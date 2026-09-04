import { describe, expect, it } from 'vitest'

import {
  canonicalEvidenceKind,
  matchOptionalStatementValues,
  resolveCanonicalAssignments,
  statementIdentitiesCompatible,
  statementLinkIsCompatible,
} from './canonicalization'

describe('canonical transaction assignments', () => {
  it('prioritizes banking identity and consumes fingerprint matches once', () => {
    const assignments = resolveCanonicalAssignments({
      observations: [
        { id: 'external', externalId: 'fit-1', fingerprint: 'changed' },
        { id: 'first-overlap', externalId: null, fingerprint: 'same' },
        { id: 'second-overlap', externalId: null, fingerprint: 'same' },
      ],
      transactions: [
        { id: 'tx-external', externalId: 'fit-1', fingerprint: 'old' },
        { id: 'tx-first', externalId: null, fingerprint: 'same' },
        { id: 'tx-second', externalId: null, fingerprint: 'same' },
      ],
      duplicateReasons: [
        'external_id',
        'fingerprint_overlap',
        'fingerprint_overlap',
      ],
    })

    expect([...assignments.entries()]).toEqual([
      ['external', 'tx-external'],
      ['first-overlap', 'tx-first'],
      ['second-overlap', 'tx-second'],
    ])
  })

  it('preserves statement-control assignments and names evidence consistently', () => {
    const assignments = resolveCanonicalAssignments({
      observations: [{ id: 'control', externalId: null, fingerprint: 'same' }],
      transactions: [{ id: 'tx', externalId: null, fingerprint: 'same' }],
      duplicateReasons: ['fingerprint_overlap'],
      preassigned: new Map([['control', 'tx']]),
    })

    expect(assignments.get('control')).toBe('tx')
    expect(
      canonicalEvidenceKind({
        controlled: true,
        duplicateReason: 'fingerprint_overlap',
      }),
    ).toBe('statement_control')
  })
})

describe('statement identity compatibility', () => {
  it.each([
    [null, null, true],
    ['statement-id', null, true],
    [null, 'transaction-id', true],
    ['same-id', 'same-id', true],
    ['statement-id', 'transaction-id', false],
  ])(
    'compares observation id %s with transaction id %s',
    (observationExternalId, transactionExternalId, expected) => {
      expect(
        statementIdentitiesCompatible(
          { externalId: observationExternalId },
          { externalId: transactionExternalId },
        ),
      ).toBe(expected)
    },
  )
})

describe('statement value matching', () => {
  it('matches identified A to A and unidentified X to the remaining B', () => {
    const result = matchOptionalStatementValues(
      [
        {
          id: 'identified-a',
          externalId: 'A',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'unidentified-x',
          externalId: null,
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
      ],
      [
        {
          id: 'ledger-a',
          externalId: 'A',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'ledger-b',
          externalId: 'B',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
      ],
    )

    expect(
      result.matches.map(({ observation, transaction }) => [
        observation.id,
        transaction.id,
      ]),
    ).toEqual([
      ['identified-a', 'ledger-a'],
      ['unidentified-x', 'ledger-b'],
    ])
    expect(result.unmatched).toEqual([])
    expect(result.unmatchedTransactions).toEqual([])
  })

  it('reserves stable identifiers before value-only fallback matches', () => {
    const result = matchOptionalStatementValues(
      [
        {
          id: 'unidentified-x',
          externalId: null,
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'identified-a',
          externalId: 'A',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
      ],
      [
        {
          id: 'ledger-b',
          externalId: 'B',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'ledger-a',
          externalId: 'A',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
      ],
    )

    expect(
      result.matches.map(({ observation, transaction }) => [
        observation.id,
        transaction.id,
      ]),
    ).toEqual([
      ['unidentified-x', 'ledger-b'],
      ['identified-a', 'ledger-a'],
    ])
    expect(result.unmatched).toEqual([])
    expect(result.unmatchedTransactions).toEqual([])
  })

  it('consumes all exact rows before exposing the single real difference', () => {
    const result = matchOptionalStatementValues(
      [
        {
          id: 'statement-a',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'statement-b',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'statement-difference',
          postedAt: '2026-08-12',
          amountCents: -3_000,
          currency: 'BRL',
        },
      ],
      [
        {
          id: 'transaction-a',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'transaction-b',
          postedAt: '2026-08-10',
          amountCents: -1_000,
          currency: 'BRL',
        },
        {
          id: 'transaction-candidate',
          postedAt: '2026-08-13',
          amountCents: -3_100,
          currency: 'BRL',
        },
      ],
    )

    expect(result.matches.map(({ observation }) => observation.id)).toEqual([
      'statement-a',
      'statement-b',
    ])
    expect(result.unmatched.map((observation) => observation.id)).toEqual([
      'statement-difference',
    ])
    expect(
      result.unmatchedTransactions.map((transaction) => transaction.id),
    ).toEqual(['transaction-candidate'])
  })

  it('reserves a changed same-id pair before an id-less value fallback', () => {
    const result = matchOptionalStatementValues(
      [
        {
          id: 'statement-without-id',
          externalId: null,
          postedAt: '2026-08-13',
          amountCents: -3_100,
          currency: 'BRL',
        },
        {
          id: 'statement-changed',
          externalId: 'banking-id-1',
          postedAt: '2026-08-12',
          amountCents: -3_000,
          currency: 'BRL',
        },
      ],
      [
        {
          id: 'transaction-before-change',
          externalId: 'banking-id-1',
          postedAt: '2026-08-13',
          amountCents: -3_100,
          currency: 'BRL',
        },
      ],
    )

    expect(result.matches).toEqual([])
    expect(result.unmatched.map((observation) => observation.id)).toEqual([
      'statement-without-id',
      'statement-changed',
    ])
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]).toMatchObject({
      observation: { id: 'statement-changed' },
      transaction: { id: 'transaction-before-change' },
    })
    expect(
      result.unmatchedTransactions.map((transaction) => transaction.id),
    ).toEqual(['transaction-before-change'])
  })
})

describe('matchOptionalStatementValues com identificadores conflitantes', () => {
  it('não casa por valor quando os dois lados têm identificadores diferentes', () => {
    const result = matchOptionalStatementValues(
      [
        {
          externalId: 'obs-1',
          postedAt: '2026-08-10',
          amountCents: -1000,
          currency: 'BRL',
        },
      ],
      [
        {
          externalId: 'tx-9',
          postedAt: '2026-08-10',
          amountCents: -1000,
          currency: 'BRL',
        },
      ],
    )
    expect(result.matches).toHaveLength(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatchedTransactions).toHaveLength(1)
  })

  it('casa por valor quando um dos lados não tem identificador', () => {
    const result = matchOptionalStatementValues(
      [
        {
          externalId: null,
          postedAt: '2026-08-10',
          amountCents: -1000,
          currency: 'BRL',
        },
      ],
      [
        {
          externalId: 'tx-9',
          postedAt: '2026-08-10',
          amountCents: -1000,
          currency: 'BRL',
        },
      ],
    )
    expect(result.matches).toHaveLength(1)
  })
})

describe('statementLinkIsCompatible com reserva de identificador no razão', () => {
  it('recusa observação identificada para transação sem id quando outra transação já possui o id', () => {
    const observation = { externalId: 'A' }
    const transaction = { id: 't-2', externalId: null }
    expect(
      statementLinkIsCompatible(
        observation,
        transaction,
        [],
        [{ id: 't-1', externalId: 'A' }, transaction],
      ),
    ).toBe(false)
  })

  it('aceita observação identificada para transação sem id quando ninguém possui o id', () => {
    const observation = { externalId: 'A' }
    const transaction = { id: 't-2', externalId: null }
    expect(
      statementLinkIsCompatible(
        observation,
        transaction,
        [],
        [{ id: 't-1', externalId: 'B' }, transaction],
      ),
    ).toBe(true)
  })
})
