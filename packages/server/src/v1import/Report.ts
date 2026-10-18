import type { Unmapped } from './Plan.ts'
import type { PlanningSummary } from './PlanningImport.ts'
import type { PendingTally, Summary, Tally, Waiting } from './V1Import.ts'

const row = (label: string, tally: Tally) =>
  `  ${label.padEnd(22)} ${String(tally.migrated).padStart(6)} ${String(tally.already).padStart(8)} ${String(tally.skipped).padStart(8)}`

const pendingRow = (label: string, tally: PendingTally) =>
  `  ${label.padEnd(22)} ${String(tally.applied).padStart(8)} ${String(tally.pending).padStart(8)} ${String(tally.superseded).padStart(11)} ${String(tally.refused).padStart(8)}`

const waitingReason: Record<Waiting['reason'], string> = {
  not_observed: 'not observed in V2 yet',
  ambiguous: 'more than one matching entry',
  no_suggestion: 'V2 has not suggested this pair',
}

const unmappedTitle: Record<Unmapped['kind'], string> = {
  owner: 'Owners',
  account: 'Accounts',
  card: 'Cards',
  category: 'Categories',
  knowledge: 'Knowledge patterns',
  category_decision: 'Category decisions',
  relation_decision: 'Reconciliation decisions',
  statement_payment: 'Manual bill payment links',
  manual_transaction: 'Transactions typed in by hand',
  note: 'Transaction notes',
  investment_movement: 'Investment classifications',
  position: 'Investment positions',
  checkpoint: 'Balances informed by hand',
  recurrence_link: 'Recurrence payment links',
  strategy: 'Strategies',
  budget: 'Closed months',
  goal: 'Goals',
  recurrence: 'Recurrences',
}

/** The summary `migrate-v1` prints, ending with what the person does next. */
export const formatSummary = (
  summary: Summary & { readonly planning?: PlanningSummary },
  options: { readonly dryRun: boolean; readonly detailLimit?: number },
) => {
  const limit = options.detailLimit ?? 20
  const lines: Array<string> = [
    options.dryRun
      ? 'Dry run: nothing was written. This is what a real run would do now.'
      : 'V1 data migrated.',
    '',
    `  ${''.padEnd(22)} ${'moved'.padStart(6)} ${'already'.padStart(8)} ${'skipped'.padStart(8)}`,
    row('Owners', summary.owners),
    row('Accounts', summary.accounts),
    row('Cards', summary.cards),
    row('Categories', summary.categories),
    row('Knowledge patterns', summary.knowledge),
    row('Category decisions', summary.categoryDecisions),
    row('Reconciliation', summary.relationDecisions),
    row('Typed-in transactions', summary.manualTransactions),
    row('Informed balances', summary.checkpoints),
    row('Investment positions', summary.positions),
    row('Notes', summary.notes),
    row('Investment movements', summary.investmentMovements),
    '',
    'Decisions are applied when V2 observes their movements again:',
    `  ${''.padEnd(22)} ${'applied'.padStart(8)} ${'waiting'.padStart(8)} ${'superseded'.padStart(11)} ${'refused'.padStart(8)}`,
    pendingRow('Category decisions', summary.pending.categories),
    pendingRow('Reconciliation', summary.pending.relations),
    pendingRow('Notes', summary.pending.notes),
    pendingRow('Investment movements', summary.pending.investmentMovements),
  ]
  const planning = summary.planning
  if (planning)
    lines.push(
      '',
      'Planning:',
      `  ${''.padEnd(22)} ${'moved'.padStart(6)} ${'already'.padStart(8)} ${'skipped'.padStart(8)}`,
      row('Income and reserve', planning.settings),
      row('Strategies', planning.strategies),
      row('Closed months', planning.budgets),
      row('Goals', planning.goals),
      row('Recurrences', planning.recurrences),
      row('Recurrence merchants', planning.aliases),
      row('Skipped occurrences', planning.skippedOccurrences),
      row('Detection ignores', planning.ignores),
      row('Recurrence payments', planning.links),
      '',
      `  ${''.padEnd(22)} ${'applied'.padStart(8)} ${'waiting'.padStart(8)} ${'superseded'.padStart(11)} ${'refused'.padStart(8)}`,
      pendingRow('Recurrence payments', planning.pending.links),
    )
  if (summary.coveredByKnowledge > 0)
    lines.push(
      '',
      `${summary.coveredByKnowledge} changed categories need no decision: the migrated patterns give the same category.`,
    )

  const groups = new Map<Unmapped['kind'], Array<Unmapped>>()
  for (const item of [...summary.unmapped, ...(planning?.unmapped ?? [])]) {
    const list = groups.get(item.kind) ?? []
    list.push(item)
    groups.set(item.kind, list)
  }
  if (groups.size > 0) lines.push('', 'Not migrated:')
  for (const [kind, items] of groups) {
    lines.push(`  ${unmappedTitle[kind]} (${items.length})`)
    for (const item of items.slice(0, limit))
      lines.push(`    - ${item.label} [${item.v1Id}]: ${item.reason}`)
    if (items.length > limit)
      lines.push(`    … and ${items.length - limit} more`)
  }

  const waiting = [
    ...summary.pending.waiting,
    ...(planning?.pending.waiting ?? []),
  ]
  if (waiting.length > 0) {
    lines.push('', `Waiting for V2 to observe (${waiting.length}):`)
    for (const item of waiting.slice(0, limit))
      lines.push(`    - ${item.label}: ${waitingReason[item.reason]}`)
    if (waiting.length > limit)
      lines.push(`    … and ${waiting.length - limit} more`)
  }

  if (summary.notMigrated.length > 0) {
    lines.push('', 'V2 has no place for these yet; they stay in V1:')
    for (const item of summary.notMigrated)
      lines.push(`  - ${item.what}: ${item.count}`)
  }

  lines.push(
    '',
    'Next steps (imported facts are not copied; Spendle observes them again):',
    '  1. Start the API server: vp run --filter @spendle/server dev',
    '  2. Pluggy (V1 never connected to it): connect each bank in Spendle (POST /api/open-finance/',
    '     connect-token, then POST /api/open-finance/connections/:id/item), link each provider',
    '     account to its migrated account instead of opening a new one (PUT /api/open-finance/',
    '     provider-accounts/:id/link) and sync (POST /api/open-finance/connections/:id/sync).',
    '  3. Files: import the same OFX, CSV and PDF statements into the migrated accounts',
    '     (POST /api/imports).',
    '  4. Waiting decisions apply by themselves as entries appear. Run migrate-v1 --dry-run again',
    '     to see what is still waiting.',
  )
  return lines.join('\n')
}
