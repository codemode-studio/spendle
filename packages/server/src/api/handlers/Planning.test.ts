import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { fakeAssistantModel } from '../../testing/FakeAssistantModel.ts'
import { drain } from '../../testing/FakePluggy.ts'

const statement = `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>20260901<DTEND>20260920
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>8000.00<FITID>s1<MEMO>SALARIO ACME</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910<TRNAMT>-2500.00<FITID>s2<MEMO>PIX IMOBILIARIA LAR</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260912<TRNAMT>-300.00<FITID>s3<MEMO>SUPERMERCADO BOM</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>5200.00<DTASOF>20260920</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

const analysis = {
  headline: 'Mês equilibrado',
  healthScore: 80,
  healthLabel: 'Bom',
  summary: 'Gastos dentro do plano.',
  findings: [],
  actions: [
    {
      title: 'Planejar o mercado',
      detail: 'Lista semanal.',
      categoryId: 'groceries',
      proposedLimitCents: 20_000,
    },
  ],
}

// A checking account with September imported, salary and market categorised.
const september = Effect.gen(function* () {
  yield* TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-20T15:00:00Z')),
  )
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Família', kind: 'household' },
  })
  const account = yield* client.accounts.open({
    payload: {
      ownerId: owner.id,
      institutionName: 'Banco',
      name: 'Conta',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    },
  })
  const data = new FormData()
  data.append('accountId', account.id)
  data.append('file', new Blob([statement]), 'set.ofx')
  yield* client.imports.upload({ payload: data })
  yield* drain
  const { entries } = yield* client.entries.list({ query: {} })
  const byDescription = (text: string) =>
    entries.find((entry) => entry.description === text)!
  for (const [description, categoryId] of [
    ['SALARIO ACME', 'salary'],
    ['SUPERMERCADO BOM', 'groceries'],
  ] as const)
    yield* client.categoryDecisions.decide({
      params: { entryId: byDescription(description).id },
      payload: { categoryId },
    })
  yield* drain
  return { client, account, rent: byDescription('PIX IMOBILIARIA LAR') }
})

describe('planning API', () => {
  it.effect(
    'closes a month only once nothing blocks it, and keeps its plan frozen',
    () =>
      Effect.gen(function* () {
        const { client, account, rent } = yield* september
        const blocked = yield* client.planning.close().pipe(Effect.flip)

        const { id } = yield* client.recurrences.create({
          payload: {
            name: 'Aluguel Imobiliária Lar',
            accountId: account.id,
            categoryId: 'housing',
            amountCents: 250_000,
            currency: 'BRL',
            direction: 'expense',
            amountMode: 'fixed',
            matchMode: 'single',
            destinationMode: 'automatic',
            frequency: 'monthly',
            nextDate: '2026-09-10',
          },
        })
        const suggested = (yield* client.recurrences.book()).recurrences[0]!
        yield* client.recurrences.confirm({
          payload: {
            recurrenceId: id,
            expectedDate: '2026-09-10',
            entryId: rent.id,
          },
        })
        yield* drain
        const linked = (yield* client.recurrences.book()).recurrences[0]!
        const rentCategory = (yield* client.entries.get({
          params: { entryId: rent.id },
        })).category

        const month = yield* client.dashboard.month({ query: {} })
        const closing = yield* client.planning.close()
        const refused = yield* client.planning
          .strategy({
            payload: {
              strategyId: 'strategy-wealth',
              allocation: {
                essential: 3_500,
                lifestyle: 2_000,
                investment: 3_500,
                reserve: 1_000,
              },
            },
          })
          .pipe(Effect.flip)
        const closed = yield* client.dashboard.month({
          query: { month: '2026-09' },
        })
        const latest = yield* client.assistant.latest({
          payload: { refreshInitial: false },
        })

        assert.deepStrictEqual(
          {
            blocked: [
              blocked._tag,
              'reason' in blocked ? blocked.reason : null,
            ],
            suggested: suggested.occurrences.map((o) => [
              o.expectedDate,
              o.matches.map((m) => m.status),
            ]),
            linked: [linked.nextDate, linked.occurrences[0]!.status],
            rentCategory: rentCategory?.categoryId,
            month: {
              income: month.incomeCents,
              actual: month.actual,
              cash: month.cashFlow.cashCents,
              blockers: month.integrity.closingBlockerCount,
            },
            closing,
            refused: [
              refused._tag,
              'reason' in refused ? refused.reason : null,
            ],
            closed: [
              closed.closed,
              closed.strategy.id,
              closed.allocation.essential,
            ],
            savings: latest.analysis?.actions.map((action) => [
              action.baselineCents,
              action.estimatedMonthlySavingsReais,
            ]),
          },
          {
            blocked: ['Rejected', 'closing_blocked'],
            suggested: [['2026-09-10', ['suggested']]],
            linked: ['2026-10-10', 'matched'],
            // The person said what the payment is; the recurrence's category followed.
            rentCategory: 'housing',
            month: {
              income: 800_000,
              actual: {
                essential: 280_000,
                lifestyle: 0,
                investment: 0,
                reserve: 0,
              },
              cash: 520_000,
              blockers: 0,
            },
            closing: {
              month: '2026-09',
              alreadyClosed: false,
              analysisError: false,
            },
            refused: ['Conflict', 'month_closed'],
            closed: [true, 'strategy-balanced', 4_000],
            savings: [[30_000, 100]],
          },
        )
      }).pipe(
        Effect.provide(
          apiTest({
            assistant: fakeAssistantModel({ monthly_analysis: () => analysis }),
          }),
        ),
      ),
  )

  it.effect('says the assistant is off when no model is configured', () =>
    Effect.gen(function* () {
      const client = yield* apiClient()
      const status = yield* client.assistant.status()
      const failure = yield* client.assistant
        .latest({ payload: { refreshInitial: false } })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [
          status.configured,
          failure._tag,
          'reason' in failure ? failure.reason : null,
        ],
        [false, 'Unavailable', 'assistant_not_configured'],
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'fills an envelope period only with payments booked inside it',
    () =>
      Effect.gen(function* () {
        const { client, rent } = yield* september
        const { entries } = yield* client.entries.list({ query: {} })
        const market = entries.find(
          (entry) => entry.description === 'SUPERMERCADO BOM',
        )!
        // The period runs from 11/09 to 10/10: the rent, on 10/09, is before it.
        const { id } = yield* client.recurrences.create({
          payload: {
            name: 'Mercado',
            accountId: null,
            categoryId: 'groceries',
            amountCents: 100_000,
            currency: 'BRL',
            direction: 'expense',
            amountMode: 'variable',
            matchMode: 'aggregate',
            destinationMode: 'automatic',
            frequency: 'monthly',
            nextDate: '2026-09-11',
          },
        })
        const period = { recurrenceId: id, expectedDate: '2026-09-11' }
        const candidates = yield* client.recurrences.candidates({
          query: period,
        })
        const outside = yield* client.recurrences
          .link({ payload: { ...period, entryIds: [market.id, rent.id] } })
          .pipe(Effect.flip)
        const inside = yield* client.recurrences.link({
          payload: { ...period, entryIds: [market.id] },
        })
        assert.deepStrictEqual(
          {
            candidates: candidates.map((candidate) => candidate.entryId),
            outside: 'reason' in outside ? outside.reason : outside._tag,
            inside: inside.linked,
          },
          {
            candidates: [market.id],
            outside: 'entry_outside_period',
            inside: 1,
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'saves goals and the plan, and approves a detected recurrence with its history',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-08-20T15:00:00Z')),
        )
        const client = yield* apiClient()
        const owner = yield* client.owners.create({
          payload: { name: 'Família', kind: 'household' },
        })
        const account = yield* client.accounts.open({
          payload: {
            ownerId: owner.id,
            institutionName: 'Banco',
            name: 'Conta',
            kind: 'checking',
            purpose: 'operating',
            currency: 'BRL',
          },
        })
        const lines = ['20260605', '20260705', '20260806']
          .map(
            (date, index) =>
              `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${date}<TRNAMT>-59.90<FITID>n${index}<MEMO>NETFLIX.COM</STMTTRN>`,
          )
          .join('\n')
        const data = new FormData()
        data.append('accountId', account.id)
        data.append(
          'file',
          new Blob([
            `OFXHEADER:100\nCHARSET:UTF-8\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL\n<BANKTRANLIST><DTSTART>20260601<DTEND>20260810\n${lines}\n</BANKTRANLIST><LEDGERBAL><BALAMT>-179.70<DTASOF>20260810</LEDGERBAL>\n</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
          ]),
          'netflix.ofx',
        )
        yield* client.imports.upload({ payload: data })
        yield* drain

        const [candidate] = yield* client.recurrences.detected()
        const approved = yield* client.recurrences.approve({
          payload: {
            name: 'Netflix',
            categoryId: 'subscriptions',
            amountCents: candidate!.typicalAmountCents,
            currency: 'BRL',
            direction: 'expense',
            amountMode: candidate!.amountMode,
            frequency: candidate!.frequency,
            nextDate: candidate!.nextExpectedDate,
            accountId: account.id,
            entryIds: candidate!.entries.map((entry) => entry.id),
          },
        })
        const detectedAfter = yield* client.recurrences.detected()
        const netflix = (yield* client.recurrences.book()).recurrences[0]!

        const goal = yield* client.planning.saveGoal({
          payload: {
            name: 'Reserva',
            type: 'emergency_reserve',
            targetCents: 600_000,
            currentCents: 100_000,
          },
        })
        const contributed = yield* client.planning.contribute({
          params: { goalId: goal.id },
          payload: { amountCents: 50_000, contributedOn: '2026-08-15' },
        })
        yield* client.planning.settings({
          payload: { monthlyIncomeTargetCents: 900_000 },
        })
        const invalid = yield* client.planning
          .strategy({
            payload: {
              strategyId: 'strategy-wealth',
              allocation: {
                essential: 3_500,
                lifestyle: 2_000,
                investment: 3_500,
                reserve: 500,
              },
            },
          })
          .pipe(Effect.flip)
        const state = yield* client.planning.state()
        const month = yield* client.dashboard.month({ query: {} })

        assert.deepStrictEqual(
          {
            approved: approved.linked,
            detectedAfter: detectedAfter.length,
            occurrences: netflix.occurrences.map((o) => [
              o.expectedDate,
              o.status,
            ]),
            contributed: contributed.currentCents,
            invalid: [
              invalid._tag,
              'reason' in invalid ? invalid.reason : null,
            ],
            target: state.settings.monthlyIncomeTargetCents,
            reserve: [month.reserve.currentCents, month.reserve.targetCents],
            base: month.baseIncomeCents,
          },
          {
            approved: 3,
            detectedAfter: 0,
            occurrences: [
              ['2026-06-05', 'matched'],
              ['2026-07-05', 'matched'],
              ['2026-08-05', 'matched'],
              ['2026-09-05', 'expected'],
            ],
            contributed: 150_000,
            invalid: ['InvalidRequest', 'invalid_allocation'],
            target: 900_000,
            reserve: [150_000, 600_000],
            base: 900_000,
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )
  it.effect(
    'counts a dollar account in reais and says which values were converted',
    () =>
      Effect.gen(function* () {
        const { client, account } = yield* september
        const dollars = yield* client.accounts.open({
          payload: {
            ownerId: account.ownerId,
            institutionName: 'Wise',
            name: 'Conta em dólar',
            kind: 'checking',
            purpose: 'operating',
            currency: 'USD',
          },
        })
        const lunch = yield* client.manual.createTransaction({
          payload: {
            accountId: dollars.id,
            bookedOn: '2026-09-12',
            amountCents: -2_000,
            description: 'Lunch',
          },
        })
        yield* client.recurrences.create({
          payload: {
            name: 'Streaming',
            accountId: dollars.id,
            categoryId: 'utilities',
            amountCents: 1_000,
            currency: 'USD',
            direction: 'expense',
            amountMode: 'fixed',
            matchMode: 'single',
            destinationMode: 'automatic',
            frequency: 'monthly',
            nextDate: '2026-09-28',
          },
        })
        yield* drain
        const month = yield* client.dashboard.month({ query: {} })
        const entry = (yield* client.entries.get({
          params: { entryId: lunch.entryId! },
        })).entry
        const book = yield* client.recurrences.book()
        const line = (id: string) =>
          month.family.lines.find((item) => item.id.startsWith(id))
        assert.deepStrictEqual(
          {
            lunch: [
              line(lunch.entryId!)?.cents,
              line(lunch.entryId!)?.converted?.rateDate,
            ],
            streaming: line(book.recurrences[0]!.id)?.cents,
            entry: entry.converted,
            recurrence: book.recurrences[0]!.converted?.originalCents,
            exchange: month.exchange,
          },
          {
            // US$ 20.00 on Saturday the 12th, at Friday's R$ 5.00.
            lunch: [10_000, '2026-09-11'],
            // US$ 10.00 due on the 28th, at the latest rate.
            streaming: 5_500,
            entry: {
              cents: -10_000,
              currency: 'USD',
              originalCents: -2_000,
              rateMicros: 5_000_000,
              rateDate: '2026-09-11',
              source: 'Fake',
            },
            recurrence: 1_000,
            exchange: {
              rates: [
                {
                  currency: 'USD',
                  rateMicros: 5_500_000,
                  date: '2026-09-18',
                  source: 'Fake',
                },
              ],
              missing: [],
            },
          },
        )
      }).pipe(
        Effect.provide(
          apiTest({
            rates: {
              USD: [
                ['2026-09-11', 5_000_000],
                ['2026-09-18', 5_500_000],
              ],
            },
          }),
        ),
      ),
  )
})
