export type RelationKind = 'internal_transfer' | 'card_payment' | 'refund'

/** `kind:outId+inId`; stable because entry ids are. Keys decisions too. */
export const relationKey = (
  kind: RelationKind,
  outflowId: string,
  inflowId: string,
) => `${kind}:${outflowId}+${inflowId}`

/**
 * A decision about a pair that an earlier decision of the same key no longer
 * covers alone gets its own key, `relationKey#revision`; it parses as the
 * relation it decides.
 */
export const supersedingDecisionKey = (key: string, revision: number) =>
  `${key}#${revision}`

export const parseRelationKey = (key: string) => {
  const [kind = '', pair = ''] = (key.split('#')[0] ?? '').split(':')
  const [outflowId = '', inflowId = ''] = pair.split('+')
  return { kind, outflowId, inflowId }
}

/** Auto-confirm needs this score and no rival within the margin. */
export const autoConfirmScore = 80
export const rivalMargin = 10
