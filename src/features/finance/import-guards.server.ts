import { eq, inArray } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  DESTINATION_CONFLICT_MESSAGE,
  getEffectiveImportValidationState,
  hasImportDestinationConflict,
} from '#/domain/import-audit'

type ImportRow = typeof schema.imports.$inferSelect

interface ImportDestinationMetadata {
  targetIdentifiers: Array<string | null>
  targetInstitutionName: string | null
}

interface ImportDestinationTarget {
  targetType: 'account' | 'card'
  targetId: string
}

const blockedAction = {
  commit: 'consolidar',
  confirm_coverage: 'confirmar o período',
  link_statement_observation: 'vincular lançamentos',
  replace_checkpoint: 'substituir o ponto de controle',
  resolve_statement_exclusion: 'alterar as ausências da fatura',
  resolve_transaction_correction: 'aceitar correções',
  retry_finalization: 'reprocessar a finalização',
} as const
type ImportReviewAction = keyof typeof blockedAction

async function loadImportDestinationMetadata(
  target: ImportDestinationTarget,
): Promise<ImportDestinationMetadata> {
  if (target.targetType === 'account') {
    const account = await db
      .select({
        identifier: schema.accounts.externalId,
        institutionName: schema.institutions.name,
      })
      .from(schema.accounts)
      .leftJoin(
        schema.institutions,
        eq(schema.institutions.id, schema.accounts.institutionId),
      )
      .where(eq(schema.accounts.id, target.targetId))
      .limit(1)
    return {
      targetIdentifiers: account.map((item) => item.identifier),
      targetInstitutionName: account[0]?.institutionName ?? null,
    }
  }
  const [card, instruments] = await Promise.all([
    db
      .select({
        identifier: schema.creditCards.lastFour,
        institutionName: schema.institutions.name,
      })
      .from(schema.creditCards)
      .leftJoin(
        schema.institutions,
        eq(schema.institutions.id, schema.creditCards.institutionId),
      )
      .where(eq(schema.creditCards.id, target.targetId))
      .limit(1),
    db
      .select({ identifier: schema.creditCardInstruments.lastFour })
      .from(schema.creditCardInstruments)
      .where(eq(schema.creditCardInstruments.creditCardId, target.targetId)),
  ])
  return {
    targetIdentifiers: [...card, ...instruments].map((item) => item.identifier),
    targetInstitutionName: card[0]?.institutionName ?? null,
  }
}

export async function loadEffectiveImportValidationStates(
  importRows: ImportRow[],
  target?: ImportDestinationTarget,
) {
  const sharedMetadata = target
    ? await loadImportDestinationMetadata(target)
    : null
  const entries = await Promise.all(
    importRows.map(async (importRow) => {
      const metadata =
        sharedMetadata ??
        (await loadImportDestinationMetadata({
          targetType: importRow.accountId ? 'account' : 'card',
          targetId: importRow.accountId ?? importRow.creditCardId!,
        }))
      const hasDestinationConflict = hasImportDestinationConflict(
        importRow,
        metadata,
      )
      return [
        importRow.id,
        {
          state: getEffectiveImportValidationState(importRow, {
            hasDestinationConflict,
          }),
          hasDestinationConflict,
        },
      ] as const
    }),
  )

  if (target) {
    const conflictingIds = entries.flatMap(([id, validation]) =>
      validation.hasDestinationConflict ? [id] : [],
    )
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
  }

  return new Map(entries.map(([id, validation]) => [id, validation.state]))
}

export async function assertImportActionable(
  importRows: ImportRow | ImportRow[],
  action: ImportReviewAction,
  target?: ImportDestinationTarget,
) {
  const rows = Array.isArray(importRows)
    ? importRows.filter((importRow) => importRow.status === 'review')
    : [importRows]
  const validations = await loadEffectiveImportValidationStates(rows, target)
  if (
    rows.some((importRow) => !validations.get(importRow.id)?.remediation.links)
  ) {
    throw new Error(
      `Esta importação está bloqueada por uma validação obrigatória. Resolva o bloqueio antes de ${blockedAction[action]}.`,
    )
  }
  return Array.isArray(importRows)
    ? validations
    : validations.get(importRows.id)!
}
