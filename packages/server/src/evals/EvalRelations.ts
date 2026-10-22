/**
 * Runs the relation matcher over the frozen relation evaluation
 * (`evals/relations`) and prints how many real transfers, card payments and
 * refunds it confirms, suggests or misses, and which pairs it invents. The
 * matcher is pure, so this is free and gives the same board for a commit.
 *
 *   vp run --filter @spendle/server eval:relations
 */
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Command from 'effect/cli/Command'

import { matchRelations } from '../reconciliation/Matching.ts'
import type {
  MatchableEntry,
  MatchedRelation,
} from '../reconciliation/Matching.ts'
import { relationScoreboard } from './RelationScoreboard.ts'
import type {
  PairResult,
  RelationCase,
  RelationScore,
} from './RelationScoreboard.ts'

const Account = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    'checking',
    'savings',
    'cash',
    'investment',
    'credit_card',
  ]),
  institution: Schema.String,
  ownerName: Schema.String,
})
const Entry = Schema.Struct({
  id: Schema.String,
  account: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
  status: Schema.optional(Schema.Literals(['pending', 'posted'])),
})
const Case = Schema.Struct({
  id: Schema.String,
  tags: Schema.Array(Schema.String),
  note: Schema.String,
  entries: Schema.Array(Entry),
  relations: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['internal_transfer', 'card_payment', 'refund']),
      outflow: Schema.String,
      inflow: Schema.String,
    }),
  ),
})
type Case = typeof Case.Type
const Dataset = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(Account),
    cases: Schema.Array(Case),
  }),
)
const Json = Schema.fromJsonString(Schema.Unknown)

const directoryUrl = new URL('../../evals/relations/', import.meta.url)

/** A mistake in the dataset, found before anything is scored. */
const datasetProblems = (
  cases: ReadonlyArray<Case>,
  accounts: ReadonlySet<string>,
) => {
  const problems: Array<string> = []
  const caseIds = new Set<string>()
  for (const item of cases) {
    if (caseIds.has(item.id)) problems.push(`${item.id}: repeated case id`)
    caseIds.add(item.id)
    const entryIds = new Set<string>()
    for (const entry of item.entries) {
      if (entryIds.has(entry.id))
        problems.push(`${item.id}: repeated entry ${entry.id}`)
      entryIds.add(entry.id)
      if (!accounts.has(entry.account))
        problems.push(`${item.id}: unknown account ${entry.account}`)
    }
    for (const relation of item.relations)
      for (const id of [relation.outflow, relation.inflow])
        if (!entryIds.has(id))
          problems.push(`${item.id}: relation names unknown entry ${id}`)
  }
  return problems
}

const percent = (value: number | null) =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`

const scoreRow = (score: RelationScore) => ({
  real: score.realPairs,
  'auto right': score.counts.auto_right,
  'auto WRONG': score.counts.auto_wrong,
  'suggested right': score.counts.suggested_right,
  'suggested wrong': score.counts.suggested_wrong,
  missed: score.counts.missed,
  autoPrecision: percent(score.autoPrecision),
  'autoPrecision ≥': percent(score.autoPrecisionLow),
  automation: percent(score.automation),
  recall: percent(score.recall),
  suggestionPrecision: percent(score.suggestionPrecision),
})

const describe = (result: PairResult) =>
  `${result.caseId} ${result.kind} ${result.outflowId} → ${result.inflowId}${
    result.score === undefined
      ? ''
      : ` | score ${result.score} | ${result.reasons?.join(', ')}`
  }`

const command = Command.make(
  'eval:relations',
  {},
  Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* path.fromFileUrl(directoryUrl)
    const { accounts, cases } = yield* Schema.decodeEffect(Dataset)(
      yield* fs.readFileString(path.join(directory, 'dataset.json')),
    )
    const accountsById = new Map(
      accounts.map((account) => [account.id, account]),
    )
    const problems = datasetProblems(cases, new Set(accountsById.keys()))
    if (problems.length > 0) {
      for (const problem of problems) yield* Console.error(problem)
      process.exitCode = 1
      return
    }

    // Each case runs alone, without decisions: what the matcher proposes
    // the first time it sees these entries.
    const found = new Map<string, ReadonlyArray<MatchedRelation>>()
    for (const item of cases) {
      const entries = item.entries.map((entry): MatchableEntry => {
        const account = accountsById.get(entry.account)!
        return {
          id: entry.id,
          accountId: account.id,
          accountKind: account.kind,
          bookedOn: entry.bookedOn,
          amountCents: entry.amountCents,
          currency: 'BRL',
          status: entry.status ?? 'posted',
          description: entry.description,
          descriptions: [entry.description],
          institution: account.institution,
          ownerName: account.ownerName,
        }
      })
      found.set(item.id, matchRelations(entries, new Map()).relations)
    }

    const expected: ReadonlyArray<RelationCase> = cases.map((item) => ({
      id: item.id,
      tags: item.tags,
      relations: item.relations.map((relation) => ({
        kind: relation.kind,
        outflowId: relation.outflow,
        inflowId: relation.inflow,
      })),
    }))
    const board = relationScoreboard(expected, found)
    const caseCount = (tag: string) =>
      cases.filter((item) => item.tags.includes(tag)).length

    yield* Console.log(
      `\n${cases.length} cases, ${board.overall.realPairs} real pairs, ${cases.filter((item) => item.relations.length === 0).length} cases with none`,
    )
    yield* Console.log('\n=== overall ===')
    yield* Console.table({ all: scoreRow(board.overall) })
    yield* Console.log('\n=== by kind ===')
    yield* Console.table(
      Object.fromEntries(
        Object.entries(board.byKind).map(([kind, score]) => [
          kind,
          scoreRow(score),
        ]),
      ),
    )
    yield* Console.log('\n=== by tag ===')
    yield* Console.table(
      Object.fromEntries(
        Object.entries(board.byTag).map(([tag, score]) => [
          tag,
          { cases: caseCount(tag), ...scoreRow(score) },
        ]),
      ),
    )
    const show = Effect.fnUntraced(function* (
      title: string,
      verdict: PairResult['verdict'],
    ) {
      const list = board.results.filter((result) => result.verdict === verdict)
      if (list.length === 0) return
      yield* Console.log(`\n${title}:`)
      for (const result of list) yield* Console.log(`  ${describe(result)}`)
    })
    yield* show('Confirmed without review, but not real', 'auto_wrong')
    yield* show('Suggested, but not real', 'suggested_wrong')
    yield* show('Real, but never proposed', 'missed')

    const ranAt = DateTime.formatIso(yield* DateTime.now)
    const results = path.join(directory, 'results')
    yield* fs.makeDirectory(results, { recursive: true })
    const file = path.join(results, `${ranAt.replace(/[:.]/g, '-')}.json`)
    yield* fs.writeFileString(
      file,
      yield* Schema.encodeEffect(Json)({ ranAt, ...board }),
    )
    yield* Console.log(`\nFull results: ${file}`)
  }),
).pipe(
  Command.withDescription(
    'Scores the transfer, card payment and refund matcher against real pairs',
  ),
)

command.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
