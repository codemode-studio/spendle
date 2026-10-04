export type RelationKind = 'internal_transfer' | 'card_payment' | 'refund'

/** `kind:outId+inId`; stable because entry ids are. Keys decisions too. */
export const relationKey = (
  kind: RelationKind,
  outflowId: string,
  inflowId: string,
) => `${kind}:${outflowId}+${inflowId}`

export const parseRelationKey = (key: string) => {
  const [kind = '', pair = ''] = key.split(':')
  const [outflowId = '', inflowId = ''] = pair.split('+')
  return { kind, outflowId, inflowId }
}

/** Auto-confirm needs this score and no rival within the margin. */
export const autoConfirmScore = 80
export const rivalMargin = 10
