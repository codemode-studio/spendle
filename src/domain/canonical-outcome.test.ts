import { describe, expect, it } from 'vitest'

import {
  externalIdentityOwnerKey,
  resolveImportObservationOutcomes,
} from './canonicalization'

describe('resolveImportObservationOutcomes', () => {
  it('does not treat the same external id on another card as an owner conflict', () => {
    const owners = new Map([
      [
        externalIdentityOwnerKey(
          { type: 'card', id: 'card-other' },
          'shared-external-id',
        ),
        'transaction-other',
      ],
    ])

    expect(
      owners.get(
        externalIdentityOwnerKey(
          { type: 'card', id: 'card-target' },
          'shared-external-id',
        ),
      ),
    ).toBeUndefined()
  })

  it('recognizes stable ids in an overlapping window', () => {
    expect(
      resolveImportObservationOutcomes({
        observations: [
          { id: 'obs-known', externalId: 'bank-1', fingerprint: 'same' },
          { id: 'obs-new', externalId: 'bank-2', fingerprint: 'new' },
        ],
        transactions: [
          { id: 'tx-known', externalId: 'bank-1', fingerprint: 'same' },
        ],
      }),
    ).toEqual([
      {
        observationId: 'obs-known',
        kind: 'known',
        transactionId: 'tx-known',
        reasons: ['stable_external_id'],
      },
      {
        observationId: 'obs-new',
        kind: 'new',
        reasons: ['new_observation'],
      },
    ])
  })

  it('lets identified observations take fallback candidates before id-less ones', () => {
    const outcomes = resolveImportObservationOutcomes({
      observations: [
        { id: 'obs-no-id', externalId: null, fingerprint: 'same' },
        { id: 'obs-with-id', externalId: 'bank-9', fingerprint: 'same' },
      ],
      transactions: [
        { id: 'tx-no-id', externalId: null, fingerprint: 'same' },
        { id: 'tx-other-id', externalId: 'bank-1', fingerprint: 'same' },
      ],
    })
    const byObservation = new Map(
      outcomes.map((outcome) => [outcome.observationId, outcome]),
    )
    expect(byObservation.get('obs-with-id')?.transactionId).toBe('tx-no-id')
    expect(byObservation.get('obs-no-id')?.transactionId).toBe('tx-other-id')
    expect(outcomes.filter((outcome) => outcome.kind === 'new')).toHaveLength(0)
  })

  it('turns a stable id with different content into a correction', () => {
    expect(
      resolveImportObservationOutcomes({
        observations: [
          { id: 'obs', externalId: 'bank-1', fingerprint: 'changed' },
        ],
        transactions: [
          { id: 'tx', externalId: 'bank-1', fingerprint: 'original' },
        ],
      }),
    ).toEqual([
      {
        observationId: 'obs',
        kind: 'correction',
        transactionId: 'tx',
        reasons: ['stable_external_id', 'changed_external_id'],
      },
    ])
  })

  it('uses a definitive PDF control as evidence for a CSV observation', () => {
    expect(
      resolveImportObservationOutcomes({
        observations: [{ id: 'csv-row', fingerprint: 'csv-description' }],
        transactions: [
          { id: 'pdf-transaction', fingerprint: 'pdf-description' },
        ],
        assignments: [
          {
            observationId: 'csv-row',
            transactionId: 'pdf-transaction',
            reason: 'trusted_statement_control',
          },
        ],
      }),
    ).toEqual([
      {
        observationId: 'csv-row',
        kind: 'evidence',
        transactionId: 'pdf-transaction',
        reasons: ['trusted_statement_control'],
      },
    ])
  })

  it('preserves multiplicity for candidates without ids', () => {
    const result = resolveImportObservationOutcomes({
      observations: [
        { id: 'obs-1', fingerprint: 'same' },
        { id: 'obs-2', fingerprint: 'same' },
        { id: 'obs-3', fingerprint: 'same' },
      ],
      transactions: [
        { id: 'tx-1', fingerprint: 'same' },
        { id: 'tx-2', fingerprint: 'same' },
      ],
    })

    expect(result.map((item) => item.kind)).toEqual(['known', 'known', 'new'])
    expect(result.flatMap((item) => item.transactionId ?? [])).toEqual([
      'tx-1',
      'tx-2',
    ])
  })

  it('assigns dependent batch evidence without creating another fact', () => {
    expect(
      resolveImportObservationOutcomes({
        observations: [{ id: 'dependent-row', fingerprint: 'same' }],
        transactions: [{ id: 'canonical', fingerprint: 'same' }],
        assignments: [
          {
            observationId: 'dependent-row',
            transactionId: 'canonical',
            reason: 'dependent_batch_evidence',
          },
        ],
      }),
    ).toEqual([
      {
        observationId: 'dependent-row',
        kind: 'evidence',
        transactionId: 'canonical',
        reasons: ['dependent_batch_evidence'],
      },
    ])
  })
})
