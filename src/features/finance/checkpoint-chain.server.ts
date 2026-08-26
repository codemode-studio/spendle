import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  classifyCheckpointAtDate,
  evaluateCheckpoint,
} from '#/domain/balance-checkpoint'
import { formatCurrency } from '#/domain/currency'

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface CheckpointTarget {
  targetType: 'account' | 'card'
  targetId: string
}

function previousDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function checkpointTarget(target: CheckpointTarget) {
  return target.targetType === 'account'
    ? eq(schema.balanceCheckpoints.accountId, target.targetId)
    : eq(schema.balanceCheckpoints.creditCardId, target.targetId)
}

export function addBalanceCheckpoint(
  transaction: DatabaseTransaction,
  input: Omit<typeof schema.balanceCheckpoints.$inferInsert, 'id'> & {
    id?: string
  },
) {
  const id = input.id ?? randomUUID()
  transaction
    .insert(schema.balanceCheckpoints)
    .values({ ...input, id })
    .run()
  return id
}

export function invalidateCheckpointChain(
  transaction: DatabaseTransaction,
  input: CheckpointTarget & { from: string; reason: string },
) {
  return transaction
    .update(schema.balanceCheckpoints)
    .set({
      verified: false,
      reviewState: 'invalidated',
      invalidatedAt: new Date(),
      invalidatedReason: input.reason,
    })
    .where(
      and(
        checkpointTarget(input),
        gte(schema.balanceCheckpoints.asOf, input.from),
      ),
    )
    .run()
}

export function refreshStatementAnchor(
  transaction: DatabaseTransaction,
  input: CheckpointTarget & {
    balanceType: 'posted' | 'card_statement'
  },
) {
  const latest = transaction
    .select({
      balanceCents: schema.balanceCheckpoints.balanceCents,
      asOf: schema.balanceCheckpoints.asOf,
    })
    .from(schema.balanceCheckpoints)
    .where(
      and(
        checkpointTarget(input),
        eq(schema.balanceCheckpoints.balanceType, input.balanceType),
        sql`${schema.balanceCheckpoints.reviewState} <> 'invalidated'`,
      ),
    )
    .orderBy(desc(schema.balanceCheckpoints.asOf))
    .get()

  if (input.targetType === 'account') {
    transaction
      .update(schema.accounts)
      .set({
        statementBalanceCents: latest?.balanceCents ?? null,
        statementBalanceAt: latest?.asOf ?? null,
      })
      .where(eq(schema.accounts.id, input.targetId))
      .run()
  } else {
    transaction
      .update(schema.creditCards)
      .set({
        statementBalanceCents: latest?.balanceCents ?? null,
        statementBalanceAt: latest?.asOf ?? null,
      })
      .where(eq(schema.creditCards.id, input.targetId))
      .run()
  }
  return latest ?? null
}

export async function recordManualBalanceCheckpoint(input: {
  targetType: 'account' | 'card'
  targetId: string
  balanceCents: number
  asOf: string
  periodStart?: string
  balanceType: 'posted' | 'available' | 'card_statement'
  note?: string
  replaceExisting?: boolean
}) {
  await ensureDatabase()
  const targetRows =
    input.targetType === 'account'
      ? await db
          .select({
            currency: schema.accounts.currency,
            statementBalanceAt: schema.accounts.statementBalanceAt,
          })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.targetId))
          .limit(1)
      : await db
          .select({
            currency: schema.creditCards.currency,
            statementBalanceAt: schema.creditCards.statementBalanceAt,
          })
          .from(schema.creditCards)
          .where(eq(schema.creditCards.id, input.targetId))
          .limit(1)
  const target = targetRows.at(0)
  if (!target) throw new Error('Conta ou cartão não encontrado.')
  if (input.targetType === 'card' && !input.periodStart) {
    throw new Error('Informe o início do ciclo da fatura.')
  }
  if (input.periodStart && input.periodStart > input.asOf) {
    throw new Error('O início do ciclo deve ser anterior ao fechamento.')
  }

  const checkpoints = await db
    .select()
    .from(schema.balanceCheckpoints)
    .where(checkpointTarget(input))
    .orderBy(desc(schema.balanceCheckpoints.asOf))
  const checkpointAtDate = classifyCheckpointAtDate(checkpoints, {
    balanceType: input.balanceType,
    balanceCents: input.balanceCents,
    asOf: input.asOf,
  })
  if (checkpointAtDate.status === 'conflict' && !input.replaceExisting) {
    throw new Error(
      'Já existe outro saldo ativo deste tipo para a mesma data. Confirme a substituição para invalidar o ponto anterior e as conferências posteriores.',
    )
  }
  if (checkpointAtDate.status === 'identical') {
    return {
      id: checkpointAtDate.checkpointId,
      reviewState: checkpoints.find(
        (checkpoint) => checkpoint.id === checkpointAtDate.checkpointId,
      )!.reviewState,
      expectedBalanceCents: input.balanceCents,
      differenceCents: 0,
      message: 'Este saldo já estava registrado para a mesma data.',
    }
  }
  const replacedCheckpoints = input.replaceExisting
    ? checkpoints.filter(
        (checkpoint) =>
          checkpoint.reviewState !== 'invalidated' &&
          checkpoint.balanceType === input.balanceType &&
          checkpoint.asOf >= input.asOf,
      )
    : []
  const replacedCheckpointIds = replacedCheckpoints.map(
    (checkpoint) => checkpoint.id,
  )
  const previous = checkpoints
    .filter((checkpoint) => !replacedCheckpointIds.includes(checkpoint.id))
    .find(
      (checkpoint) =>
        checkpoint.asOf < input.asOf &&
        checkpoint.reviewState !== 'invalidated' &&
        checkpoint.balanceType !== 'available',
    )
  const movementRows = await db
    .select({
      amountCents: schema.transactions.amountCents,
      currency: schema.transactions.currency,
      status: schema.transactions.status,
      postedAt: schema.transactions.postedAt,
    })
    .from(schema.transactions)
    .where(
      input.targetType === 'account'
        ? eq(schema.transactions.accountId, input.targetId)
        : eq(schema.transactions.creditCardId, input.targetId),
    )
  const coverageRows =
    input.targetType === 'card'
      ? [{ start: input.periodStart!, end: input.asOf }]
      : await db
          .select({
            start: schema.coverageIntervals.start,
            end: schema.coverageIntervals.end,
          })
          .from(schema.coverageIntervals)
          .innerJoin(
            schema.imports,
            eq(schema.imports.id, schema.coverageIntervals.importId),
          )
          .where(
            and(
              eq(schema.coverageIntervals.accountId, input.targetId),
              inArray(schema.imports.status, ['committed', 'evidence']),
            ),
          )
  const evaluation = evaluateCheckpoint({
    targetType: input.targetType,
    currency: target.currency,
    balanceType: input.balanceType,
    balanceCents: input.balanceCents,
    asOf: input.asOf,
    previous:
      input.targetType === 'card'
        ? { balanceCents: 0, asOf: previousDate(input.periodStart!) }
        : previous
          ? { balanceCents: previous.balanceCents, asOf: previous.asOf }
          : null,
    movements:
      input.targetType === 'card'
        ? movementRows
            .filter(
              (movement) =>
                movement.postedAt >= input.periodStart! &&
                movement.postedAt <= input.asOf,
            )
            .map((movement) => ({
              ...movement,
              status:
                movement.status === 'pending'
                  ? ('confirmed' as const)
                  : movement.status,
            }))
        : movementRows,
    coverageIntervals: coverageRows,
  })
  const { expectedBalanceCents, differenceCents, reviewState } = evaluation
  const checkpointId = randomUUID()

  db.transaction((transaction) => {
    if (replacedCheckpointIds.length) {
      transaction
        .update(schema.balanceCheckpoints)
        .set({
          reviewState: 'invalidated',
          verified: false,
          invalidatedAt: new Date(),
          invalidatedReason: `Substituído explicitamente pelo checkpoint manual ${checkpointId}.`,
        })
        .where(inArray(schema.balanceCheckpoints.id, replacedCheckpointIds))
        .run()
      const affectedImportIds = replacedCheckpoints.flatMap((checkpoint) =>
        checkpoint.importId ? [checkpoint.importId] : [],
      )
      if (affectedImportIds.length) {
        transaction
          .update(schema.imports)
          .set({
            validationStatus: 'warning',
            validationMessage:
              'O ponto de controle deste documento foi substituído manualmente. Os saldos posteriores precisam ser conferidos novamente.',
          })
          .where(inArray(schema.imports.id, affectedImportIds))
          .run()
      }
    }
    transaction
      .insert(schema.balanceCheckpoints)
      .values({
        id: checkpointId,
        accountId: input.targetType === 'account' ? input.targetId : null,
        creditCardId: input.targetType === 'card' ? input.targetId : null,
        kind: 'manual',
        balanceType: input.balanceType,
        source: 'manual',
        reviewState,
        balanceCents: input.balanceCents,
        asOf: input.asOf,
        verified: reviewState === 'verified',
        differenceCents,
        evidenceJson: JSON.stringify({ note: input.note?.trim() || null }),
      })
      .run()
    if (
      input.targetType === 'account' &&
      input.balanceType === 'posted' &&
      (input.replaceExisting ||
        !target.statementBalanceAt ||
        target.statementBalanceAt < input.asOf)
    ) {
      transaction
        .update(schema.accounts)
        .set({
          statementBalanceCents: input.balanceCents,
          statementBalanceAt: input.asOf,
        })
        .where(eq(schema.accounts.id, input.targetId))
        .run()
    }
    if (input.targetType === 'card' && input.balanceType === 'card_statement') {
      if (
        !target.statementBalanceAt ||
        target.statementBalanceAt < input.asOf ||
        input.replaceExisting
      ) {
        transaction
          .update(schema.creditCards)
          .set({
            statementBalanceCents: input.balanceCents,
            statementBalanceAt: input.asOf,
          })
          .where(eq(schema.creditCards.id, input.targetId))
          .run()
      }
      if (input.replaceExisting) {
        transaction
          .update(schema.cardStatementCycles)
          .set({ status: 'closed' })
          .where(
            and(
              eq(schema.cardStatementCycles.creditCardId, input.targetId),
              gte(schema.cardStatementCycles.periodEnd, input.asOf),
            ),
          )
          .run()
      }
      transaction
        .insert(schema.cardStatementCycles)
        .values({
          id: randomUUID(),
          creditCardId: input.targetId,
          periodStart: input.periodStart!,
          periodEnd: input.asOf,
          closingDate: input.asOf,
          issuedAt: input.asOf,
          totalCents: input.balanceCents,
          status: reviewState === 'verified' ? 'reconciled' : 'closed',
        })
        .onConflictDoUpdate({
          target: [
            schema.cardStatementCycles.creditCardId,
            schema.cardStatementCycles.periodStart,
            schema.cardStatementCycles.periodEnd,
          ],
          set: {
            closingDate: input.asOf,
            issuedAt: input.asOf,
            totalCents: input.balanceCents,
            status: reviewState === 'verified' ? 'reconciled' : 'closed',
          },
        })
        .run()
      if (reviewState === 'verified') {
        transaction
          .update(schema.transactions)
          .set({ status: 'confirmed' })
          .where(
            and(
              eq(schema.transactions.creditCardId, input.targetId),
              eq(schema.transactions.status, 'pending'),
              gte(schema.transactions.postedAt, input.periodStart!),
              lte(schema.transactions.postedAt, input.asOf),
            ),
          )
          .run()
      }
    }
  })

  return {
    id: checkpointId,
    reviewState,
    expectedBalanceCents,
    differenceCents,
    message:
      evaluation.unsupportedCurrencyCount > 0
        ? 'Saldo registrado, mas há movimentações em outra moeda no período. A reconciliação ficou pendente e nenhum ajuste foi criado.'
        : expectedBalanceCents === null
          ? 'Saldo registrado como primeiro ponto de controle. O próximo saldo datado poderá reconciliar o período.'
          : !evaluation.coverageComplete
            ? 'Saldo registrado, mas ainda existe uma lacuna de importação desde o ponto anterior. Importe ou confirme o período ausente para concluir a conferência.'
            : differenceCents === 0
              ? 'Saldo conferido com todas as movimentações do período.'
              : `Saldo registrado, mas o período tem uma diferença de ${formatCurrency(Math.abs(differenceCents!), target.currency)}. Nenhum ajuste foi criado.`,
  }
}

export async function replaceCheckpointChainForImport(importId: string) {
  await ensureDatabase()
  const importRow = (
    await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId))
      .limit(1)
  ).at(0)
  if (
    !importRow ||
    importRow.status !== 'review' ||
    importRow.closingBalanceCents === null ||
    !importRow.balanceAsOf ||
    (!importRow.accountId && !importRow.creditCardId)
  ) {
    throw new Error(
      'Esta importação não possui um saldo conflitante revisável.',
    )
  }
  const balanceType = importRow.creditCardId
    ? ('card_statement' as const)
    : importRow.closingBalanceType === 'available'
      ? ('available' as const)
      : ('posted' as const)
  const target: CheckpointTarget = importRow.accountId
    ? { targetType: 'account', targetId: importRow.accountId }
    : { targetType: 'card', targetId: importRow.creditCardId! }
  const checkpoints = await db
    .select()
    .from(schema.balanceCheckpoints)
    .where(checkpointTarget(target))
  const closingConflicts = checkpoints.filter(
    (checkpoint) =>
      checkpoint.reviewState !== 'invalidated' &&
      checkpoint.balanceType === balanceType &&
      checkpoint.asOf === importRow.balanceAsOf &&
      checkpoint.balanceCents !== importRow.closingBalanceCents,
  )
  const openingConflict =
    importRow.accountId &&
    importRow.openingBalanceCents !== null &&
    importRow.openingBalanceAt
      ? (checkpoints.find(
          (checkpoint) =>
            checkpoint.reviewState !== 'invalidated' &&
            checkpoint.balanceType === 'posted' &&
            checkpoint.asOf === importRow.openingBalanceAt &&
            checkpoint.balanceCents !== importRow.openingBalanceCents,
        ) ??
        checkpoints.find(
          (checkpoint) =>
            checkpoint.reviewState !== 'invalidated' &&
            checkpoint.balanceType === 'posted' &&
            checkpoint.asOf === previousDate(importRow.openingBalanceAt!) &&
            checkpoint.balanceCents !== importRow.openingBalanceCents,
        ))
      : null
  const conflicts = [
    ...closingConflicts,
    ...(openingConflict ? [openingConflict] : []),
  ].filter(
    (checkpoint, index, items) =>
      items.findIndex((candidate) => candidate.id === checkpoint.id) === index,
  )
  if (!conflicts.length) {
    throw new Error(
      'Nenhum ponto de controle conflitante foi encontrado. Atualize a página e tente novamente.',
    )
  }
  const chainStartByBalanceType = new Map<
    (typeof conflicts)[number]['balanceType'],
    string
  >()
  for (const conflict of conflicts) {
    const current = chainStartByBalanceType.get(conflict.balanceType)
    if (!current || conflict.asOf < current) {
      chainStartByBalanceType.set(conflict.balanceType, conflict.asOf)
    }
  }
  const affected = checkpoints.filter((checkpoint) => {
    const chainStart = chainStartByBalanceType.get(checkpoint.balanceType)
    return (
      checkpoint.reviewState !== 'invalidated' &&
      Boolean(chainStart && checkpoint.asOf >= chainStart)
    )
  })
  const affectedIds = affected.map((checkpoint) => checkpoint.id)

  db.transaction((transaction) => {
    transaction
      .update(schema.balanceCheckpoints)
      .set({
        reviewState: 'invalidated',
        verified: false,
        invalidatedAt: new Date(),
        invalidatedReason: `Substituído explicitamente pela importação ${importId}.`,
      })
      .where(inArray(schema.balanceCheckpoints.id, affectedIds))
      .run()
    const affectedImportIds = affected.flatMap((checkpoint) =>
      checkpoint.importId ? [checkpoint.importId] : [],
    )
    if (affectedImportIds.length) {
      transaction
        .update(schema.imports)
        .set({
          validationStatus: 'warning',
          validationMessage:
            'O ponto de controle deste documento foi substituído por uma correção explícita. Os saldos posteriores precisam ser conferidos novamente.',
        })
        .where(inArray(schema.imports.id, affectedImportIds))
        .run()
    }
    transaction
      .update(schema.imports)
      .set({
        validationStatus: 'imported',
        validationMessage:
          'O saldo anterior foi invalidado com registro de auditoria. Revise este arquivo e consolide para criar o novo ponto de controle.',
      })
      .where(eq(schema.imports.id, importId))
      .run()
    if (
      target.targetType === 'account' &&
      chainStartByBalanceType.has('posted')
    ) {
      refreshStatementAnchor(transaction, {
        ...target,
        balanceType: 'posted',
      })
    }
    if (
      target.targetType === 'card' &&
      chainStartByBalanceType.has('card_statement')
    ) {
      refreshStatementAnchor(transaction, {
        ...target,
        balanceType: 'card_statement',
      })
    }
    if (target.targetType === 'card') {
      transaction
        .update(schema.cardStatementCycles)
        .set({ status: 'closed' })
        .where(
          and(
            eq(schema.cardStatementCycles.creditCardId, target.targetId),
            gte(schema.cardStatementCycles.periodEnd, importRow.balanceAsOf!),
          ),
        )
        .run()
    }
  })
  return { invalidated: affectedIds.length }
}
