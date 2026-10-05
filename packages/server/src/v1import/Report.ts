import type { Unmapped } from './Plan.ts'
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
}

/** The summary `migrate-v1` prints, ending with what the person does next. */
export const formatSummary = (
  summary: Summary,
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
  if (summary.coveredByKnowledge > 0)
    lines.push(
      '',
      `${summary.coveredByKnowledge} changed categories need no decision: the migrated patterns give the same category.`,
    )

  const groups = new Map<Unmapped['kind'], Array<Unmapped>>()
  for (const item of summary.unmapped) {
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

  if (summary.pending.waiting.length > 0) {
    lines.push(
      '',
      `Waiting for V2 to observe (${summary.pending.waiting.length}):`,
    )
    for (const item of summary.pending.waiting.slice(0, limit))
      lines.push(`    - ${item.label}: ${waitingReason[item.reason]}`)
    if (summary.pending.waiting.length > limit)
      lines.push(`    … and ${summary.pending.waiting.length - limit} more`)
  }

  if (summary.notMigrated.length > 0) {
    lines.push('', 'V2 has no place for these yet; they stay in V1:')
    for (const item of summary.notMigrated)
      lines.push(`  - ${item.what}: ${item.count}`)
  }

  lines.push(
    '',
    'Next steps (imported facts are not copied; V2 observes them again):',
    '  1. Start the V2 server: pnpm --filter @spendle/server dev',
    '  2. Pluggy (V1 never connected to it): connect each bank in V2 (POST /api/v2/open-finance/',
    '     connect-token, then POST /api/v2/open-finance/connections/:id/item), link each provider',
    '     account to its migrated account instead of opening a new one (PUT /api/v2/open-finance/',
    '     provider-accounts/:id/link) and sync (POST /api/v2/open-finance/connections/:id/sync).',
    '  3. Files: import the same OFX, CSV and PDF statements into the migrated accounts',
    '     (POST /api/v2/imports).',
    '  4. Waiting decisions apply by themselves as entries appear. Run migrate-v1 --dry-run again',
    '     to see what is still waiting.',
  )
  return lines.join('\n')
}
