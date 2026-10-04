import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { eq } from 'drizzle-orm'

import * as schema from '#/db/schema'
import { shiftDays } from '#/domain/period'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import {
  linkCardStatementPayment,
  listCardStatementPaymentCandidates,
  unlinkCardStatementPayment,
} from './card-statement-payment.server'
import { createManualTransaction } from './finance.server'
import {
  getConfigurationSnapshot,
  getFinanceSnapshot,
} from './finance-snapshot.server'

describe('vínculo manual de pagamento de fatura', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => database.close())

  it('lista débitos perto do vencimento, vincula, reclassifica e desfaz', async () => {
    const before = await getConfigurationSnapshot()
    const dueDate = before.cards.find((row) => row.id === database.ids.card)!
      .currentStatement.dueDate
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: shiftDays(dueDate, 1),
      description: 'Débito genérico',
      direction: 'outflow',
      amountCents: 50_000,
      categoryId: 'groceries',
    })

    const candidates = await listCardStatementPaymentCandidates({
      creditCardId: database.ids.card,
      dueDate,
      amountCents: 50_000,
    })
    expect(candidates[0]).toMatchObject({
      id: debit.id,
      amountDifferenceCents: 0,
      daysApart: 1,
      linkedToDueDate: null,
    })

    const link = await linkCardStatementPayment({
      creditCardId: database.ids.card,
      dueDate,
      transactionId: debit.id,
    })
    const [reclassified] = await database.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, debit.id))
    expect(reclassified.categoryId).toBe('card_payment')

    const afterLink = await listCardStatementPaymentCandidates({
      creditCardId: database.ids.card,
      dueDate,
    })
    expect(afterLink.some((row) => row.id === debit.id)).toBe(false)

    const snapshot = await getConfigurationSnapshot()
    const card = snapshot.cards.find((row) => row.id === database.ids.card)
    const statement = card?.statements.find((row) => row.dueDate === dueDate)
    expect(statement?.payments).toEqual([
      expect.objectContaining({
        transactionId: debit.id,
        kind: 'manual',
        linkId: link.id,
      }),
    ])

    await unlinkCardStatementPayment({ id: link.id })
    const [restored] = await database.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, debit.id))
    expect(restored.categoryId).toBe('groceries')
  })

  it('recusa entradas e lançamentos de cartão', async () => {
    const income = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-09-10',
      description: 'Entrada',
      direction: 'inflow',
      amountCents: 1_000,
    })
    await expect(
      linkCardStatementPayment({
        creditCardId: database.ids.card,
        dueDate: '2026-09-09',
        transactionId: income.id,
      }),
    ).rejects.toThrow('débito')
  })
})

describe('moeda do pagamento de fatura', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => database.close())

  it('não oferece nem vincula débito em outra moeda', async () => {
    await database.db.insert(schema.accounts).values({
      id: 'usd-account',
      ownershipScopeId: database.ids.personScope,
      institutionId: database.ids.institution,
      name: 'Conta USD',
      kind: 'checking',
      purpose: 'operating',
      currency: 'USD',
    })
    await database.db.insert(schema.transactions).values({
      id: 'usd-debit',
      accountId: 'usd-account',
      fingerprint: 'usd-debit',
      postedAt: '2026-09-10',
      description: 'Card payment',
      normalizedDescription: 'card payment',
      amountCents: -50_000,
      currency: 'USD',
      status: 'confirmed',
    })
    const candidates = await listCardStatementPaymentCandidates({
      creditCardId: database.ids.card,
      dueDate: '2026-09-12',
      amountCents: 50_000,
    })
    expect(candidates.some((row) => row.id === 'usd-debit')).toBe(false)
    await expect(
      linkCardStatementPayment({
        creditCardId: database.ids.card,
        dueDate: '2026-09-12',
        transactionId: 'usd-debit',
      }),
    ).rejects.toThrow('BRL')
  })
})

describe('fatura paga na projeção de caixa', () => {
  let database: TestDatabase | undefined

  afterEach(() => {
    database?.close()
    vi.useRealTimers()
  })

  async function closedUnpaidStatement() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    database = await openTestDatabase()
    await database.db
      .update(schema.creditCards)
      .set({ dueDay: 15 })
      .where(eq(schema.creditCards.id, database.ids.card))
    await createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-20',
      description: 'Compra no cartão',
      direction: 'outflow',
      amountCents: 30_000,
      categoryId: 'groceries',
    })
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-09-07',
      description: 'Débito genérico',
      direction: 'outflow',
      amountCents: 10_000,
      categoryId: 'groceries',
    })
    return { cardId: database.ids.card, debitId: debit.id }
  }

  function scheduledStatement(
    snapshot: Awaited<ReturnType<typeof getFinanceSnapshot>>,
    cardId: string,
  ) {
    return snapshot.cashProjection.scheduled.find(
      (event) => event.id === `${cardId}-2026-09-15`,
    )
  }

  it('não agenda de novo uma fatura marcada como paga', async () => {
    const { cardId, debitId } = await closedUnpaidStatement()
    expect(
      scheduledStatement(await getFinanceSnapshot(), cardId)?.amountCents,
    ).toBe(-30_000)

    await linkCardStatementPayment({
      creditCardId: cardId,
      dueDate: '2026-09-15',
      transactionId: debitId,
    })
    const snapshot = await getFinanceSnapshot()
    const statement = snapshot.cards
      .find((card) => card.id === cardId)
      ?.statements.find((row) => row.dueDate === '2026-09-15')
    expect(statement?.status).toBe('paid')
    expect(scheduledStatement(snapshot, cardId)).toBeUndefined()
  })

  it('agenda só o restante de uma fatura paga parcialmente', async () => {
    const { cardId, debitId } = await closedUnpaidStatement()
    await linkCardStatementPayment({
      creditCardId: cardId,
      dueDate: '2026-09-15',
      transactionId: debitId,
      partial: true,
    })
    expect(
      scheduledStatement(await getFinanceSnapshot(), cardId)?.amountCents,
    ).toBe(-20_000)
  })
})

describe('pagamento recebido no cartão e conciliação na projeção', () => {
  let database: TestDatabase | undefined

  afterEach(() => {
    database?.close()
    vi.useRealTimers()
  })

  async function statementDueSept15() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    database = await openTestDatabase()
    await database.db
      .update(schema.creditCards)
      .set({ dueDay: 15 })
      .where(eq(schema.creditCards.id, database.ids.card))
    await createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-20',
      description: 'Compra no cartão',
      direction: 'outflow',
      amountCents: 30_000,
      categoryId: 'groceries',
    })
    return database
  }

  async function cardReceipt(input: {
    id: string
    postedAt: string
    amountCents: number
    status: 'pending' | 'confirmed'
  }) {
    await database!.db.insert(schema.transactions).values({
      id: input.id,
      creditCardId: database!.ids.card,
      categoryId: 'card_payment',
      fingerprint: input.id,
      postedAt: input.postedAt,
      description: 'Pagamento recebido',
      normalizedDescription: 'pagamento recebido',
      amountCents: input.amountCents,
      currency: 'BRL',
      status: input.status,
    })
  }

  async function scheduledCents() {
    const snapshot = await getFinanceSnapshot()
    return snapshot.cashProjection.scheduled.find(
      (event) => event.id === `${database!.ids.card}-2026-09-15`,
    )?.amountCents
  }

  it('mantém a fatura agendada com recebimento futuro no cartão', async () => {
    await statementDueSept15()
    await cardReceipt({
      id: 'future-pending-receipt',
      postedAt: '2026-09-14',
      amountCents: 30_000,
      status: 'pending',
    })
    expect(await scheduledCents()).toBe(-30_000)
    await database!.db
      .update(schema.transactions)
      .set({ status: 'confirmed' })
      .where(eq(schema.transactions.id, 'future-pending-receipt'))
    expect(await scheduledCents()).toBe(-30_000)
  })

  it('recebimento já lançado no cartão quita sem débito bancário', async () => {
    await statementDueSept15()
    await cardReceipt({
      id: 'posted-receipt',
      postedAt: '2026-09-07',
      amountCents: 30_000,
      status: 'confirmed',
    })
    expect(await scheduledCents()).toBeUndefined()
  })

  it('conta uma vez o débito vinculado à mão e conciliado com o recebimento', async () => {
    const db = await statementDueSept15()
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: db.ids.brlAccount,
      postedAt: '2026-09-07',
      description: 'Débito genérico',
      direction: 'outflow',
      amountCents: 10_000,
      categoryId: 'groceries',
    })
    await linkCardStatementPayment({
      creditCardId: db.ids.card,
      dueDate: '2026-09-15',
      transactionId: debit.id,
      partial: true,
    })
    await cardReceipt({
      id: 'partial-receipt',
      postedAt: '2026-09-07',
      amountCents: 10_000,
      status: 'confirmed',
    })
    await db.db.insert(schema.reconciliationGroups).values({
      id: 'partial-pair',
      type: 'card_payment',
      status: 'confirmed',
      confidence: 100,
    })
    await db.db.insert(schema.reconciliationLinks).values([
      {
        id: 'partial-pair-bank',
        groupId: 'partial-pair',
        transactionId: debit.id,
        role: 'outgoing',
      },
      {
        id: 'partial-pair-card',
        groupId: 'partial-pair',
        transactionId: 'partial-receipt',
        role: 'incoming',
      },
    ])
    const snapshot = await getFinanceSnapshot()
    const statement = snapshot.cards
      .find((card) => card.id === db.ids.card)
      ?.statements.find((row) => row.dueDate === '2026-09-15')
    expect(statement).toMatchObject({ status: 'partial', paidCents: 10_000 })
    expect(await scheduledCents()).toBe(-20_000)
  })
})

describe('pagamento pendente na projeção de caixa', () => {
  let database: TestDatabase | undefined

  afterEach(() => {
    database?.close()
    vi.useRealTimers()
  })

  it('mantém a fatura agendada enquanto o pagamento não sai do caixa', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    database = await openTestDatabase()
    await database.db
      .update(schema.creditCards)
      .set({ dueDay: 15 })
      .where(eq(schema.creditCards.id, database.ids.card))
    await createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-20',
      description: 'Compra no cartão',
      direction: 'outflow',
      amountCents: 30_000,
      categoryId: 'groceries',
    })
    await database.db.insert(schema.transactions).values({
      id: 'scheduled-payment',
      accountId: database.ids.brlAccount,
      categoryId: 'card_payment',
      fingerprint: 'scheduled-payment',
      postedAt: '2026-09-14',
      description: 'Pagamento fatura cartão',
      normalizedDescription: 'pagamento fatura cartao',
      amountCents: -30_000,
      currency: 'BRL',
      status: 'pending',
    })

    const snapshot = await getFinanceSnapshot()
    expect(
      snapshot.cashProjection.scheduled.find(
        (event) => event.id === `${database!.ids.card}-2026-09-15`,
      )?.amountCents,
    ).toBe(-30_000)
  })
})
