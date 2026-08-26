import { describe, expect, it } from 'vitest'

import {
  classifyCheckpointAtDate,
  evaluateCheckpoint,
} from './balance-checkpoint'

describe('checkpoint de saldo', () => {
  const base = {
    targetType: 'account' as const,
    currency: 'BRL',
    balanceType: 'posted' as const,
    balanceCents: 10_150,
    asOf: '2026-05-31',
    previous: { balanceCents: 10_000, asOf: '2026-05-01' },
    coverageIntervals: [{ start: '2026-05-02', end: '2026-05-31' }],
  }

  it('torna o mesmo saldo idempotente e bloqueia outro valor na mesma data', () => {
    const checkpoints = [
      {
        id: 'checkpoint-1',
        balanceType: 'posted' as const,
        balanceCents: 10_000,
        asOf: '2026-05-31',
        reviewState: 'verified' as const,
      },
    ]
    expect(
      classifyCheckpointAtDate(checkpoints, {
        balanceType: 'posted',
        balanceCents: 10_000,
        asOf: '2026-05-31',
      }),
    ).toMatchObject({ status: 'identical', checkpointId: 'checkpoint-1' })
    expect(
      classifyCheckpointAtDate(checkpoints, {
        balanceType: 'posted',
        balanceCents: 9_999,
        asOf: '2026-05-31',
      }),
    ).toMatchObject({ status: 'conflict' })
  })

  it('usa o intervalo aberto-fechado (t0, t1]', () => {
    expect(
      evaluateCheckpoint({
        ...base,
        movements: [
          {
            amountCents: 999,
            currency: 'BRL',
            postedAt: '2026-05-01',
            status: 'confirmed',
          },
          {
            amountCents: 100,
            currency: 'BRL',
            postedAt: '2026-05-02',
            status: 'confirmed',
          },
          {
            amountCents: 50,
            currency: 'BRL',
            postedAt: '2026-05-31',
            status: 'confirmed',
          },
          {
            amountCents: 999,
            currency: 'BRL',
            postedAt: '2026-06-01',
            status: 'confirmed',
          },
        ],
      }),
    ).toMatchObject({
      movementCents: 150,
      differenceCents: 0,
      reviewState: 'verified',
    })
  })

  it('não usa pendentes nem excluídos no saldo contabilizado', () => {
    expect(
      evaluateCheckpoint({
        ...base,
        movements: [
          {
            amountCents: 150,
            currency: 'BRL',
            postedAt: '2026-05-02',
            status: 'confirmed',
          },
          {
            amountCents: 900,
            currency: 'BRL',
            postedAt: '2026-05-03',
            status: 'pending',
          },
          {
            amountCents: 900,
            currency: 'BRL',
            postedAt: '2026-05-04',
            status: 'excluded',
          },
        ],
      }),
    ).toMatchObject({ movementCents: 150, reviewState: 'verified' })
  })

  it('o primeiro saldo e o saldo disponível são observações, não reconciliações', () => {
    expect(
      evaluateCheckpoint({ ...base, previous: null, movements: [] })
        .reviewState,
    ).toBe('observed')
    expect(
      evaluateCheckpoint({
        ...base,
        balanceType: 'available',
        movements: [
          {
            amountCents: 150,
            currency: 'BRL',
            postedAt: '2026-05-02',
            status: 'confirmed',
          },
        ],
      }).reviewState,
    ).toBe('observed')
  })

  it('não reconcilia quando há outra moeda ou diferença de um centavo', () => {
    expect(
      evaluateCheckpoint({
        ...base,
        balanceCents: 10_151,
        movements: [
          {
            amountCents: 150,
            currency: 'BRL',
            postedAt: '2026-05-02',
            status: 'confirmed',
          },
          {
            amountCents: 100,
            currency: 'USD',
            postedAt: '2026-05-03',
            status: 'confirmed',
          },
        ],
      }),
    ).toMatchObject({
      differenceCents: 1,
      unsupportedCurrencyCount: 1,
      reviewState: 'observed',
    })
  })

  it('confere a fatura pelo movimento do ciclo, sem carregar o total anterior', () => {
    expect(
      evaluateCheckpoint({
        targetType: 'card',
        currency: 'BRL',
        balanceType: 'card_statement',
        balanceCents: 500,
        asOf: '2026-05-31',
        previous: { balanceCents: 10_000, asOf: '2026-05-01' },
        movements: [
          {
            amountCents: -300,
            currency: 'BRL',
            postedAt: '2026-05-10',
            status: 'confirmed',
          },
          {
            amountCents: -200,
            currency: 'BRL',
            postedAt: '2026-05-20',
            status: 'confirmed',
          },
        ],
        coverageIntervals: [{ start: '2026-05-02', end: '2026-05-31' }],
      }),
    ).toMatchObject({
      expectedBalanceCents: 500,
      differenceCents: 0,
      reviewState: 'verified',
    })
  })

  it('não verifica um saldo quando existe lacuna no período', () => {
    expect(
      evaluateCheckpoint({
        ...base,
        movements: [
          {
            amountCents: 150,
            currency: 'BRL',
            postedAt: '2026-05-02',
            status: 'confirmed',
          },
        ],
        coverageIntervals: [
          { start: '2026-05-02', end: '2026-05-10' },
          { start: '2026-05-20', end: '2026-05-31' },
        ],
      }),
    ).toMatchObject({ coverageComplete: false, reviewState: 'observed' })
  })

  it('não usa lançamentos provisórios como prova de uma fatura', () => {
    expect(
      evaluateCheckpoint({
        targetType: 'card',
        currency: 'BRL',
        balanceType: 'card_statement',
        balanceCents: 500,
        asOf: '2026-05-31',
        previous: { balanceCents: 0, asOf: '2026-05-01' },
        coverageIntervals: [{ start: '2026-05-02', end: '2026-05-31' }],
        movements: [
          {
            amountCents: -500,
            currency: 'BRL',
            postedAt: '2026-05-10',
            status: 'pending',
          },
        ],
      }),
    ).toMatchObject({
      movementCents: 0,
      differenceCents: 500,
      reviewState: 'observed',
    })
  })

  it('ignora moeda diferente enquanto o lançamento ainda é provisório', () => {
    expect(
      evaluateCheckpoint({
        ...base,
        balanceCents: 10_000,
        movements: [
          {
            amountCents: 100,
            currency: 'USD',
            postedAt: '2026-05-03',
            status: 'pending',
          },
        ],
      }),
    ).toMatchObject({
      unsupportedCurrencyCount: 0,
      differenceCents: 0,
      reviewState: 'verified',
    })
  })
})
