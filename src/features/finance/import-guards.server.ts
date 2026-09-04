import { eq, inArray } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  DESTINATION_CONFLICT_MESSAGE,
  effectiveValidationReason,
  isHardImportReviewReason,
} from '#/domain/import-audit'
import { matchesDocumentLastFour } from './statement-reader.server'

type ImportRow = typeof schema.imports.$inferSelect

interface ImportDestinationMetadata {
  targetIdentifiers: Array<string | null>
  targetInstitutionName: string | null
}

interface ImportDestinationTarget {
  targetType: 'account' | 'card'
  targetId: string
}

export type ImportReviewAction =
  | 'commit'
  | 'confirm_coverage'
  | 'link_statement_observation'
  | 'replace_checkpoint'
  | 'resolve_statement_exclusion'
  | 'resolve_transaction_correction'
  | 'retry_finalization'

const blockedActionMessage = {
  commit:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de consolidar.',
  confirm_coverage:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de confirmar o período.',
  link_statement_observation:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de vincular lançamentos.',
  replace_checkpoint:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de substituir o ponto de controle.',
  resolve_statement_exclusion:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de alterar as ausências da fatura.',
  resolve_transaction_correction:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de aceitar correções.',
  retry_finalization:
    'Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de reprocessar a finalização.',
} satisfies Record<ImportReviewAction, string>

export function hasImportDestinationConflict(
  importRow: Pick<ImportRow, 'detectedInstitution' | 'detectedLastFour'>,
  metadata: ImportDestinationMetadata,
) {
  const detectedInstitution = importRow.detectedInstitution?.toLowerCase()
  const targetInstitution = metadata.targetInstitutionName?.toLowerCase()

  return Boolean(
    (importRow.detectedLastFour &&
      metadata.targetIdentifiers.some(Boolean) &&
      !matchesDocumentLastFour(
        importRow.detectedLastFour,
        metadata.targetIdentifiers,
      )) ||
    (detectedInstitution &&
      targetInstitution &&
      !targetInstitution.includes(detectedInstitution) &&
      !detectedInstitution.includes(targetInstitution)),
  )
}

async function loadImportDestinationMetadata(
  target: ImportDestinationTarget,
): Promise<ImportDestinationMetadata> {
  const accountTarget =
    target.targetType === 'account'
      ? await db
          .select({
            externalId: schema.accounts.externalId,
            institutionName: schema.institutions.name,
          })
          .from(schema.accounts)
          .leftJoin(
            schema.institutions,
            eq(schema.institutions.id, schema.accounts.institutionId),
          )
          .where(eq(schema.accounts.id, target.targetId))
          .limit(1)
      : []
  const cardTarget =
    target.targetType === 'card'
      ? await db
          .select({
            lastFour: schema.creditCards.lastFour,
            institutionName: schema.institutions.name,
          })
          .from(schema.creditCards)
          .leftJoin(
            schema.institutions,
            eq(schema.institutions.id, schema.creditCards.institutionId),
          )
          .where(eq(schema.creditCards.id, target.targetId))
          .limit(1)
      : []
  const cardInstruments =
    target.targetType === 'card'
      ? await db
          .select({ lastFour: schema.creditCardInstruments.lastFour })
          .from(schema.creditCardInstruments)
          .where(eq(schema.creditCardInstruments.creditCardId, target.targetId))
      : []
  const targetRow = accountTarget.at(0) ?? cardTarget.at(0)

  return {
    targetIdentifiers:
      accountTarget.length > 0
        ? accountTarget.map((item) => item.externalId)
        : [
            ...cardTarget.map((item) => item.lastFour),
            ...cardInstruments.map((item) => item.lastFour),
          ],
    targetInstitutionName: targetRow?.institutionName ?? null,
  }
}

export async function hasLiveImportDestinationConflict(importRow: ImportRow) {
  const metadata = await loadImportDestinationMetadata({
    targetType: importRow.accountId ? 'account' : 'card',
    targetId: importRow.accountId ?? importRow.creditCardId!,
  })
  return hasImportDestinationConflict(importRow, metadata)
}

export async function flagLiveBatchDestinationConflicts(
  importRows: ImportRow[],
  target: ImportDestinationTarget,
) {
  const metadata = await loadImportDestinationMetadata(target)
  const conflictingIds = [
    ...new Set(
      importRows
        .filter((importRow) =>
          hasImportDestinationConflict(importRow, metadata),
        )
        .map((importRow) => importRow.id),
    ),
  ]
  if (conflictingIds.length) {
    await db
      .update(schema.imports)
      .set({
        validationStatus: 'divergent',
        validationReason: 'destination_conflict',
        validationMessage: DESTINATION_CONFLICT_MESSAGE,
      })
      .where(inArray(schema.imports.id, conflictingIds))
  }
  return new Set(conflictingIds)
}

export async function assertImportBatchActionable(
  importRows: ImportRow[],
  target: ImportDestinationTarget,
  action: ImportReviewAction,
) {
  // Failed or rejected members are terminal: they no longer take part in the
  // commit, so they must not poison their siblings.
  const activeRows = importRows.filter(
    (importRow) => importRow.status === 'review',
  )
  const liveConflictIds = await flagLiveBatchDestinationConflicts(
    activeRows,
    target,
  )
  const hasBlockedMember = activeRows.some(
    (importRow) =>
      liveConflictIds.has(importRow.id) ||
      isHardImportReviewReason(effectiveValidationReason(importRow)),
  )
  if (hasBlockedMember) {
    throw new Error(blockedActionMessage[action])
  }
}

export async function getEffectiveImportValidationReason(importRow: ImportRow) {
  const hasDestinationConflict =
    await hasLiveImportDestinationConflict(importRow)
  return effectiveValidationReason({ ...importRow, hasDestinationConflict })
}

export async function assertImportActionable(
  importRow: ImportRow,
  action: ImportReviewAction,
) {
  const reason = await getEffectiveImportValidationReason(importRow)
  if (isHardImportReviewReason(reason)) {
    throw new Error(blockedActionMessage[action])
  }
  return reason
}
