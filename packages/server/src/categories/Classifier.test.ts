import { assert, describe, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import { Imports } from '../imports/Imports.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Entries } from '../ledger/Entries.ts'
import {
  FakeClassifierCalls,
  fakeClassifier,
} from '../testing/FakeClassifier.ts'
import { categoriesTestWith, drain } from '../testing/FakePluggy.ts'
import { Categorizer } from './Categorizer.ts'
import { Classifier } from './Classifier.ts'
import { KnowledgeStore } from './KnowledgeStore.ts'

const ofx = (lines: string) =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><STMTRS><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST></STMTRS></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

const statement = (lines: string) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const owner = yield* accounts.createOwner({
      name: 'Donald',
      kind: 'person',
    })
    const account = yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Nubank',
      name: 'Nubank',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    })
    yield* (yield* Imports).importFile({
      accountId: account.id,
      fileName: 'nubank.ofx',
      bytes: ofx(lines),
    })
    yield* drain
    const entries = yield* Entries
    return (description: string) =>
      Effect.map(
        entries.entries(account.id),
        (all) => all.find((entry) => entry.description === description)!.id,
      )
  })

const refuseCalls = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die('the model must not be called')),
)

describe('Classifier', () => {
  it.effect('stays disabled without an API key and never calls out', () =>
    Effect.gen(function* () {
      const entryOf = yield* statement(
        line('a', '20260901', '-12.00', 'Padaria Real'),
      )
      const inference = yield* (yield* Categorizer).explain(
        yield* entryOf('Padaria Real'),
      )
      assert.strictEqual(inference.status, 'none')
      const cached = yield* (yield* SqlClient.SqlClient)<{
        n: number
      }>`SELECT count(*) AS n FROM model_classifications`
      assert.strictEqual(cached[0]!.n, 0)
      assert.isTrue(Option.isNone((yield* Classifier).modelVersion))
    }).pipe(
      Effect.provide(
        categoriesTestWith(
          Classifier.layer.pipe(
            Layer.provide(refuseCalls),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          ),
        ),
      ),
    ),
  )

  it.effect(
    'sends model answers to review without teaching the store, until the person confirms',
    () =>
      Effect.gen(function* () {
        const entryOf = yield* statement(
          line('a', '20260901', '-12.00', 'Padaria Real') +
            line('b', '20260902', '-30.00', 'Loja Duvidosa') +
            line('c', '20260903', '-15.00', 'Padaria Real'),
        )
        const categorizer = yield* Categorizer
        const store = yield* KnowledgeStore
        const bakery = yield* entryOf('Padaria Real')
        assert.deepInclude(yield* categorizer.explain(bakery), {
          categoryId: 'groceries',
          origin: 'model',
          originRef: 'fake-model',
          status: 'review',
          confidence: 83,
        })
        assert.strictEqual(
          (yield* categorizer.explain(yield* entryOf('Loja Duvidosa'))).status,
          'none',
        )
        assert.deepStrictEqual(yield* store.list, [])

        yield* categorizer.confirm(bakery)
        yield* drain
        assert.deepInclude(yield* categorizer.explain(bakery), {
          categoryId: 'groceries',
          origin: 'decision',
          status: 'applied',
        })
        assert.deepStrictEqual(
          (yield* store.list).map((row) => [row.pattern, row.categoryId]),
          [['padaria real', 'groceries']],
        )
        // Each merchant was asked about once.
        assert.sameMembers(
          (yield* Ref.get(yield* FakeClassifierCalls)).map(
            (item) => item.pattern,
          ),
          ['padaria real', 'loja duvidosa'],
        )
      }).pipe(Effect.provide(withFakeModel)),
  )

  it.effect(
    'asks TypeSafe for a choice among the categories of each direction',
    () =>
      Effect.gen(function* () {
        const bodies = yield* Ref.make<ReadonlyArray<string>>([])
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            const body =
              request.body._tag === 'Uint8Array'
                ? new TextDecoder().decode(request.body.body)
                : ''
            yield* Ref.update(bodies, (all) => [...all, body])
            assert.strictEqual(
              request.headers['authorization'],
              'Bearer test-key',
            )
            const sent = yield* Schema.decodeUnknownEffect(SentRequest)(body)
            const answers: Record<string, unknown> = {}
            for (const id of Object.keys(sent.questions)) {
              const income =
                sent.state.transactions[0]!.direction === 'money received'
              answers[id] = income
                ? {
                    type: 'choice',
                    choice: 'salary',
                    probabilities: { salary: 0.7 },
                    confidence: 0.6,
                  }
                : {
                    type: 'choice',
                    choice: 'none:no_category_fits',
                    probabilities: { 'none:no_category_fits': 0.55 },
                    confidence: 0.3,
                  }
            }
            const json = yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Unknown),
            )({
              model: 'jev-1',
              answers,
            })
            return HttpClientResponse.fromWeb(
              request,
              new Response(json, { status: 200 }),
            )
          }).pipe(Effect.orDie),
        )
        const classifier = yield* Classifier.makeTypeSafe({
          apiKey: Redacted.make('test-key'),
          model: 'jev-latest',
          baseUrl: 'https://typesafe.test',
        }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
        const answers = yield* classifier.classify(
          [
            {
              pattern: 'loja',
              direction: 'expense',
              description: 'Loja',
              amountCents: -1000,
            },
            {
              pattern: 'empresa',
              direction: 'income',
              description: 'Empresa',
              amountCents: 500000,
            },
          ],
          [
            { id: 'groceries', name: 'Mercado', bucket: 'essential' },
            { id: 'salary', name: 'Renda familiar', bucket: 'income' },
          ],
        )
        assert.deepStrictEqual(answers, [
          { categoryId: null, probability: 0.55 },
          { categoryId: 'salary', probability: 0.7 },
        ])
        assert.deepStrictEqual(
          classifier.modelVersion,
          Option.some('typesafe:jev-latest'),
        )
        const sent = yield* Effect.forEach(yield* Ref.get(bodies), (body) =>
          Schema.decodeUnknownEffect(SentRequest)(body),
        )
        assert.deepStrictEqual(
          sent.map((request) =>
            Object.keys(Object.values(request.questions)[0]!.criteria),
          ),
          [
            ['none:no_category_fits', 'groceries'],
            ['none:no_category_fits', 'salary'],
          ],
        )
      }),
  )
})

const SentRequest = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.Literal('jev-latest'),
    state: Schema.Struct({
      transactions: Schema.Array(
        Schema.Struct({
          description: Schema.String,
          amount: Schema.String,
          direction: Schema.String,
        }),
      ),
    }),
    questions: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.Literal('choice'),
        criteria: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  }),
)

const withFakeModel = categoriesTestWith(
  fakeClassifier({
    'padaria real': { categoryId: 'groceries', probability: 0.83 },
    'loja duvidosa': { categoryId: 'shopping', probability: 0.4 },
  }),
)
