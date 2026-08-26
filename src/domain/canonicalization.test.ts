import { describe, expect, it } from 'vitest'

import {
  canonicalEvidenceKind,
  resolveCanonicalAssignments,
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
