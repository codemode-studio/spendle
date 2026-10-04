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
import { createCreditCard, createManualTransaction } from './finance.server'
import {
  getConfigurationSnapshot,
  getFinanceSnapshot,
} from './finance-snapshot.server'
import { refreshReconciliationSuggestions } from './reconciliation-refresh.server'

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

  it('mantém a categoria original ao mover e desfazer o vínculo', async () => {
    const dueDate = (await getConfigurationSnapshot()).cards.find(
      (row) => row.id === database.ids.card,
    )!.currentStatement.dueDate
    const nextDueDate = shiftDays(dueDate, 31)
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: shiftDays(dueDate, -1),
      description: 'Débito movido',
      direction: 'outflow',
      amountCents: 100_000,
      categoryId: 'groceries',
    })
    await linkCardStatementPayment({
      creditCardId: database.ids.card,
      dueDate,
      transactionId: debit.id,
    })
    const moved = await linkCardStatementPayment({
      creditCardId: database.ids.card,
      dueDate: nextDueDate,
      transactionId: debit.id,
    })
    const links = await database.db
      .select()
      .from(schema.cardStatementPayments)
      .where(eq(schema.cardStatementPayments.transactionId, debit.id))
    expect(links.map((link) => link.id)).toEqual([moved.id])

    await unlinkCardStatementPayment({ id: moved.id })
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

  it('conta uma vez o débito vinculado à mão e o recebimento sem conciliação', async () => {
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
      id: 'ungrouped-receipt',
      postedAt: '2026-09-07',
      amountCents: 10_000,
      status: 'confirmed',
    })
    const snapshot = await getFinanceSnapshot()
    const statement = snapshot.cards
      .find((card) => card.id === db.ids.card)
      ?.statements.find((row) => row.dueDate === '2026-09-15')
    expect(statement).toMatchObject({ status: 'partial', paidCents: 10_000 })
    expect(await scheduledCents()).toBe(-20_000)
  })
  it('conta o recebimento lançado quando o débito vinculado à mão é futuro', async () => {
    const db = await statementDueSept15()
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: db.ids.brlAccount,
      postedAt: '2026-09-09',
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
      id: 'posted-receipt-future-debit',
      postedAt: '2026-09-07',
      amountCents: 10_000,
      status: 'confirmed',
    })
    expect(await scheduledCents()).toBe(-20_000)
  })

  it('conta o recebimento conciliado quando o débito vinculado à mão está pendente', async () => {
    const db = await statementDueSept15()
    await db.db.insert(schema.transactions).values({
      id: 'pending-debit',
      accountId: db.ids.brlAccount,
      categoryId: 'groceries',
      fingerprint: 'pending-debit',
      postedAt: '2026-09-07',
      description: 'Débito genérico',
      normalizedDescription: 'debito generico',
      amountCents: -10_000,
      currency: 'BRL',
      status: 'pending',
    })
    await linkCardStatementPayment({
      creditCardId: db.ids.card,
      dueDate: '2026-09-15',
      transactionId: 'pending-debit',
      partial: true,
    })
    await cardReceipt({
      id: 'posted-receipt-pending-debit',
      postedAt: '2026-09-07',
      amountCents: 10_000,
      status: 'confirmed',
    })
    await db.db.insert(schema.reconciliationGroups).values({
      id: 'pending-pair',
      type: 'card_payment',
      status: 'confirmed',
      confidence: 100,
    })
    await db.db.insert(schema.reconciliationLinks).values([
      {
        id: 'pending-pair-bank',
        groupId: 'pending-pair',
        transactionId: 'pending-debit',
        role: 'outgoing',
      },
      {
        id: 'pending-pair-card',
        groupId: 'pending-pair',
        transactionId: 'posted-receipt-pending-debit',
        role: 'incoming',
      },
    ])
    expect(await scheduledCents()).toBe(-20_000)
  })

  it('conta uma vez o recebimento conciliado com débito bancário futuro', async () => {
    const db = await statementDueSept15()
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: db.ids.brlAccount,
      postedAt: '2026-09-09',
      description: 'Pagamento fatura cartão',
      direction: 'outflow',
      amountCents: 10_000,
      categoryId: 'card_payment',
    })
    await cardReceipt({
      id: 'grouped-receipt-future-debit',
      postedAt: '2026-09-07',
      amountCents: 10_000,
      status: 'confirmed',
    })
    await db.db.insert(schema.reconciliationGroups).values({
      id: 'future-pair',
      type: 'card_payment',
      status: 'confirmed',
      confidence: 100,
    })
    await db.db.insert(schema.reconciliationLinks).values([
      {
        id: 'future-pair-bank',
        groupId: 'future-pair',
        transactionId: debit.id,
        role: 'outgoing',
      },
      {
        id: 'future-pair-card',
        groupId: 'future-pair',
        transactionId: 'grouped-receipt-future-debit',
        role: 'incoming',
      },
    ])
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

describe('débito de pagamento entre dois cartões', () => {
  let database: TestDatabase | undefined

  afterEach(() => {
    database?.close()
    vi.useRealTimers()
  })

  /** Dois cartões com faturas de R$ 300,00 vencendo em 15/09. */
  async function twoCardsDueSept15() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    database = await openTestDatabase()
    const { db, ids } = database
    await db
      .update(schema.creditCards)
      .set({ dueDay: 15 })
      .where(eq(schema.creditCards.id, ids.card))
    await db.insert(schema.creditCards).values({
      id: 'second-card',
      ownershipScopeId: ids.personScope,
      institutionId: ids.institution,
      name: 'Segundo cartão',
      currency: 'BRL',
      lastFour: '4242',
      closingDay: 2,
      dueDay: 15,
    })
    for (const cardId of [ids.card, 'second-card'])
      await createManualTransaction({
        targetType: 'card',
        targetId: cardId,
        postedAt: '2026-08-20',
        description: 'Compra no cartão',
        direction: 'outflow',
        amountCents: 30_000,
        categoryId: 'groceries',
      })
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: ids.brlAccount,
      postedAt: '2026-09-07',
      description: 'Pagamento de fatura',
      direction: 'outflow',
      amountCents: 30_000,
      categoryId: 'card_payment',
    })
    return { cardA: ids.card, cardB: 'second-card', debitId: debit.id }
  }

  function cardView(
    snapshot: Awaited<ReturnType<typeof getFinanceSnapshot>>,
    cardId: string,
  ) {
    return {
      statement: snapshot.cards
        .find((card) => card.id === cardId)
        ?.statements.find((row) => row.dueDate === '2026-09-15'),
      scheduledCents: snapshot.cashProjection.scheduled.find(
        (event) => event.id === `${cardId}-2026-09-15`,
      )?.amountCents,
    }
  }

  it('o débito vinculado a um cartão não quita a fatura do outro', async () => {
    const { cardA, cardB, debitId } = await twoCardsDueSept15()
    await linkCardStatementPayment({
      creditCardId: cardA,
      dueDate: '2026-09-15',
      transactionId: debitId,
    })
    const snapshot = await getFinanceSnapshot()
    const a = cardView(snapshot, cardA)
    const b = cardView(snapshot, cardB)
    expect(a.statement?.status).toBe('paid')
    expect(a.scheduledCents).toBeUndefined()
    expect(b.statement?.status).not.toBe('paid')
    expect(b.statement?.payments.some((p) => p.transactionId === debitId)).toBe(
      false,
    )
    expect(b.scheduledCents).toBe(-30_000)
  })

  it('não deduz que um débito sem vínculo quitou um dos dois cartões', async () => {
    const { cardA, cardB, debitId } = await twoCardsDueSept15()
    const snapshot = await getFinanceSnapshot()
    for (const cardId of [cardA, cardB]) {
      const view = cardView(snapshot, cardId)
      expect(view.statement?.status).not.toBe('paid')
      expect(
        view.statement?.payments.find((p) => p.transactionId === debitId)?.kind,
      ).toBe('candidate')
      expect(view.scheduledCents).toBe(-30_000)
    }
  })
})

describe('alocação de recebimentos na projeção de caixa', () => {
  let database: TestDatabase | undefined

  afterEach(() => {
    database?.close()
    vi.useRealTimers()
  })

  // Closing on the 20th, due on the 27th.
  async function cardDue27(today: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T12:00:00Z`))
    database = await openTestDatabase()
    await database.db
      .update(schema.creditCards)
      .set({ closingDay: 20, dueDay: 27 })
      .where(eq(schema.creditCards.id, database.ids.card))
    return database
  }

  async function purchase(postedAt: string, amountCents: number) {
    await createManualTransaction({
      targetType: 'card',
      targetId: database!.ids.card,
      postedAt,
      description: 'Compra no cartão',
      direction: 'outflow',
      amountCents,
      categoryId: 'groceries',
    })
  }

  async function cardReceipt(id: string, postedAt: string, amountCents: number) {
    await database!.db.insert(schema.transactions).values({
      id,
      creditCardId: database!.ids.card,
      categoryId: 'card_payment',
      fingerprint: id,
      postedAt,
      description: 'Pagamento recebido',
      normalizedDescription: 'pagamento recebido',
      amountCents,
      currency: 'BRL',
      status: 'confirmed',
    })
  }

  async function view() {
    const snapshot = await getFinanceSnapshot()
    const card = snapshot.cards.find((row) => row.id === database!.ids.card)!
    return {
      paid: Object.fromEntries(
        card.statements.map((row) => [row.dueDate, row.paidCents]),
      ),
      scheduled: Object.fromEntries(
        snapshot.cashProjection.scheduled
          .filter((event) => event.id.startsWith(`${card.id}-`))
          .map((event) => [event.date, event.amountCents]),
      ),
    }
  }

  it('não leva um adiantamento conciliado para a fatura anterior já paga', async () => {
    const db = await cardDue27('2026-08-26')
    await purchase('2026-07-05', 100_000)
    await purchase('2026-08-05', 150_000)
    await cardReceipt('july-receipt', '2026-07-27', 100_000)
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: db.ids.brlAccount,
      postedAt: '2026-08-19',
      description: 'Pagamento fatura cartão',
      direction: 'outflow',
      amountCents: 120_000,
      categoryId: 'card_payment',
    })
    await cardReceipt('advance', '2026-08-19', 120_000)
    await db.db.insert(schema.reconciliationGroups).values({
      id: 'advance-pair',
      type: 'card_payment',
      status: 'confirmed',
      confidence: 100,
    })
    await db.db.insert(schema.reconciliationLinks).values([
      {
        id: 'advance-pair-bank',
        groupId: 'advance-pair',
        transactionId: debit.id,
        role: 'outgoing',
      },
      {
        id: 'advance-pair-card',
        groupId: 'advance-pair',
        transactionId: 'advance',
        role: 'incoming',
      },
    ])
    const { paid, scheduled } = await view()
    expect(paid).toMatchObject({
      '2026-07-27': 100_000,
      '2026-08-27': 120_000,
    })
    expect(scheduled['2026-08-27']).toBe(-30_000)
  })

  it('não deixa um débito futuro vinculado à mão desviar um recebimento lançado', async () => {
    const db = await cardDue27('2026-07-26')
    await purchase('2026-07-05', 100_000)
    await purchase('2026-07-24', 100_000)
    await cardReceipt('posted-receipt', '2026-07-25', 20_000)
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: db.ids.brlAccount,
      postedAt: '2026-07-27',
      description: 'Débito genérico',
      direction: 'outflow',
      amountCents: 100_000,
      categoryId: 'groceries',
    })
    await linkCardStatementPayment({
      creditCardId: db.ids.card,
      dueDate: '2026-07-27',
      transactionId: debit.id,
    })
    const { paid, scheduled } = await view()
    expect(scheduled['2026-07-27']).toBe(-80_000)
    expect(paid['2026-08-27']).toBe(0)
  })
})

describe('pagamento de fatura entre dois cartões', () => {
  let database: TestDatabase | undefined

  afterEach(() => {
    database?.close()
    vi.useRealTimers()
  })

  it('não apaga a compra de outro cartão com o pagamento de mesmo valor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    database = await openTestDatabase()
    const db = database
    const otherCard = await createCreditCard({
      name: 'Outro cartão',
      institutionName: 'Banco Exemplo',
      ownershipScopeId: db.ids.personScope,
      currency: 'BRL',
      limitCents: 500_000,
      closingDay: 20,
      dueDay: 27,
    })
    await createManualTransaction({
      targetType: 'card',
      targetId: db.ids.card,
      postedAt: '2026-09-10',
      description: 'Pagamento de fatura',
      direction: 'inflow',
      amountCents: 17_300,
      categoryId: 'card_payment',
    })
    const purchase = await createManualTransaction({
      targetType: 'card',
      targetId: otherCard.id,
      postedAt: '2026-09-10',
      description: 'Supermercado Exemplo',
      direction: 'outflow',
      amountCents: 17_300,
      categoryId: 'groceries',
    })
    const categoryOf = async () =>
      (
        await db.db
          .select({ categoryId: schema.transactions.categoryId })
          .from(schema.transactions)
          .where(eq(schema.transactions.id, purchase.id))
      )[0].categoryId
    const groupsOfPurchase = () =>
      db.db
        .select({ id: schema.reconciliationLinks.groupId })
        .from(schema.reconciliationLinks)
        .where(eq(schema.reconciliationLinks.transactionId, purchase.id))
    const statementCents = async () =>
      (await getFinanceSnapshot()).cards
        .find((card) => card.id === otherCard.id)
        ?.statements.find((row) => row.dueDate === '2026-09-27')?.amountCents

    await refreshReconciliationSuggestions()
    expect(await groupsOfPurchase()).toEqual([])
    expect(await categoryOf()).toBe('groceries')
    expect(await statementCents()).toBe(17_300)

    // A pair confirmed automatically by the earlier rule is dissolved and the
    // purchase gets its category back.
    const [creditRow] = await db.db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, db.ids.card))
    await db.db
      .update(schema.transactions)
      .set({ categoryId: 'card_payment' })
      .where(eq(schema.transactions.id, purchase.id))
    await db.db.insert(schema.reconciliationGroups).values({
      id: 'legacy-pair',
      type: 'card_payment',
      status: 'confirmed',
      confirmationSource: 'automatic',
      confidence: 100,
    })
    await db.db.insert(schema.reconciliationLinks).values([
      {
        id: 'legacy-pair-purchase',
        groupId: 'legacy-pair',
        transactionId: purchase.id,
        role: 'outgoing',
        previousCategoryId: 'groceries',
      },
      {
        id: 'legacy-pair-credit',
        groupId: 'legacy-pair',
        transactionId: creditRow.id,
        role: 'incoming',
        previousCategoryId: 'card_payment',
      },
    ])
    await refreshReconciliationSuggestions()
    expect(await groupsOfPurchase()).toEqual([])
    expect(await categoryOf()).toBe('groceries')
    expect(await statementCents()).toBe(17_300)
  })
})
