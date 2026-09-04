import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { InvalidManualBalanceCheckpointError } from './checkpoint-chain.server'
import * as finance from './finance.server'
import {
  InvalidRecurrenceDestinationError,
  createRecurrence,
  updateRecurrence,
} from './recurrence.server'

describe('invariantes das escritas financeiras', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => {
    database.close()
  })

  it('rejeita saldo manual de cartão sem início do ciclo fora da server function', async () => {
    const error = await finance
      .createManualBalanceCheckpoint({
        targetType: 'card',
        targetId: database.ids.card,
        balanceCents: 12_345,
        asOf: '2026-09-04',
        balanceType: 'card_statement',
      })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(InvalidManualBalanceCheckpointError)
    expect(error).toMatchObject({
      code: 'card_period_start_required',
      message: 'Informe o início do ciclo da fatura.',
    })
  })

  it('rejeita início do ciclo posterior ao fechamento fora da server function', async () => {
    const error = await finance
      .createManualBalanceCheckpoint({
        targetType: 'card',
        targetId: database.ids.card,
        balanceCents: 12_345,
        asOf: '2026-09-04',
        periodStart: '2026-09-05',
        balanceType: 'card_statement',
      })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(InvalidManualBalanceCheckpointError)
    expect(error).toMatchObject({
      code: 'period_start_after_as_of',
      message: 'O início do ciclo deve ser anterior ao fechamento.',
    })
  })

  it('rejeita recorrência com conta e cartão fora da server function', async () => {
    const error = await createRecurrence({
      name: 'Destino ambíguo',
      accountId: database.ids.brlAccount,
      creditCardId: database.ids.card,
      categoryId: database.ids.categories.subscriptions,
      amountCents: 3_990,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-09-10',
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(InvalidRecurrenceDestinationError)
    expect(error).toMatchObject({
      code: 'multiple_destinations',
      message: 'Informe somente uma conta ou um cartão.',
    })
  })

  it('rejeita atualização com destino fixo ausente antes de escrever', async () => {
    const recurrence = await createRecurrence({
      name: 'Assinatura válida',
      categoryId: database.ids.categories.subscriptions,
      amountCents: 3_990,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-09-10',
    })

    const error = await updateRecurrence(recurrence.id, {
      name: recurrence.name,
      categoryId: recurrence.categoryId,
      amountCents: recurrence.amountCents,
      currency: recurrence.currency,
      direction: recurrence.direction,
      amountMode: recurrence.amountMode,
      matchMode: recurrence.matchMode,
      destinationMode: 'fixed',
      frequency: recurrence.frequency,
      nextDate: recurrence.nextDate,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(InvalidRecurrenceDestinationError)
    expect(error).toMatchObject({
      code: 'fixed_destination_required',
      message: 'Escolha uma conta ou cartão para o destino fixo.',
    })
  })
})
