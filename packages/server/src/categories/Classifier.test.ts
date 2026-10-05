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
            {
              id: 'groceries',
              name: 'Mercado',
              bucket: 'essential',
              description: 'Supermercado e padaria.',
            },
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
        assert.sameDeepMembers(
          sent.map((request) => Object.values(request.questions)[0]!.criteria),
          [
            {
              'none:no_category_fits':
                'None of the listed categories fits this transaction, or the description says too little to tell.',
              groceries: 'Mercado: Supermercado e padaria.',
            },
            {
              'none:no_category_fits':
                'None of the listed categories fits this transaction, or the description says too little to tell.',
              salary: 'Renda familiar',
            },
          ],
        )
      }),
  )

  it.effect(
    "shows the person's decisions about similar merchants as examples, never the model's answers",
    () =>
      Effect.gen(function* () {
        const entryOf = yield* statement(
          line('a', '20260901', '-12.00', 'Padaria Real') +
            line('b', '20260902', '-30.00', 'Padaria Central') +
            line('c', '20260903', '-55.00', 'Mercado Bom') +
            line('d', '20260904', '-21.00', 'Mercado Bom Filial') +
            line('e', '20260905', '-39.90', 'Netflix'),
        )
        const categorizer = yield* Categorizer
        const calls = yield* FakeClassifierCalls
        const sql = yield* SqlClient.SqlClient
        const askedSince = (from: number) =>
          Effect.map(Ref.get(calls), (all) =>
            all
              .slice(from)
              .map((item) => [item.pattern, item.examples ?? []] as const),
          )
        // Nothing decided yet: every merchant is asked bare, and the
        // model's applied answer for "Mercado Bom" is no example later.
        assert.sameDeepMembers(yield* askedSince(0), [
          ['padaria real', []],
          ['padaria central', []],
          ['mercado bom', []],
          ['mercado bom filial', []],
          ['netflix', []],
        ])
        assert.deepInclude(
          yield* categorizer.explain(yield* entryOf('Mercado Bom')),
          { origin: 'model', status: 'applied' },
        )

        let seen = (yield* Ref.get(calls)).length
        yield* categorizer.decide(yield* entryOf('Padaria Real'), 'groceries')
        yield* drain
        // Only the merchant whose examples changed is asked again.
        assert.deepStrictEqual(yield* askedSince(seen), [
          [
            'padaria central',
            [{ description: 'Padaria Real', categoryId: 'groceries' }],
          ],
        ])
        const contexts = yield* sql<{
          pattern: string
          context: string
        }>`SELECT pattern, context FROM model_classifications ORDER BY pattern`
        assert.deepStrictEqual(
          contexts.map((row) => [row.pattern, row.context !== '']),
          [
            ['mercado bom', false],
            ['mercado bom filial', false],
            ['netflix', false],
            ['padaria central', true],
            ['padaria real', false],
          ],
        )

        // A decision no open merchant resembles asks nothing.
        seen = (yield* Ref.get(calls)).length
        yield* categorizer.decide(yield* entryOf('Netflix'), 'subscriptions')
        yield* drain
        assert.deepStrictEqual(yield* askedSince(seen), [])

        // Withdrawing the decision takes its example away, so the merchant
        // is asked again without it.
        seen = (yield* Ref.get(calls)).length
        yield* categorizer.undo(yield* entryOf('Padaria Real'))
        yield* drain
        assert.includeDeepMembers(yield* askedSince(seen), [
          ['padaria central', []],
        ])
        assert.notIncludeDeepMembers(
          (yield* askedSince(0)).flatMap(([, examples]) => examples),
          [{ description: 'Mercado Bom', categoryId: 'groceries' }],
        )
      }).pipe(
        Effect.provide(
          categoriesTestWith(
            fakeClassifier(
              {
                'mercado bom': { categoryId: 'groceries', probability: 0.97 },
                'padaria central': {
                  categoryId: 'groceries',
                  probability: 0.7,
                },
              },
              { applyThreshold: 0.95 },
            ),
          ),
        ),
      ),
  )

  it.effect(
    'sends each transaction its own past decisions, by category name',
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
            const sent = yield* Schema.decodeUnknownEffect(SentRequest)(body)
            const answers: Record<string, unknown> = {}
            for (const id of Object.keys(sent.questions))
              answers[id] = {
                type: 'choice',
                choice: 'groceries',
                probabilities: { groceries: 0.8 },
              }
            const json = yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Unknown),
            )({ answers })
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
        yield* classifier.classify(
          [
            {
              pattern: 'padaria central',
              direction: 'expense',
              description: 'Padaria Central',
              amountCents: -1000,
              examples: [
                { description: 'Padaria Real', categoryId: 'groceries' },
                // Not offered for this direction: left out.
                { description: 'Padaria Salario', categoryId: 'salary' },
              ],
            },
            {
              pattern: 'loja',
              direction: 'expense',
              description: 'Loja',
              amountCents: -2000,
            },
          ],
          [
            { id: 'groceries', name: 'Mercado', bucket: 'essential' },
            { id: 'salary', name: 'Renda familiar', bucket: 'income' },
          ],
        )
        const [sent] = yield* Effect.forEach(yield* Ref.get(bodies), (body) =>
          Schema.decodeUnknownEffect(SentRequest)(body),
        )
        assert.deepStrictEqual(
          sent!.state.transactions.map((t) => t.pastDecisions),
          [[{ description: 'Padaria Real', category: 'Mercado' }], undefined],
        )
        const [first, second] = Object.values(sent!.questions)
        assert.include(first!.instructions, '`transactions[0].pastDecisions`')
        assert.notInclude(second!.instructions, 'pastDecisions')
      }),
  )

  it.effect('reports a refused key as rejected without retrying', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"detail":"invalid key"}', { status: 401 }),
            ),
          ),
        ),
      )
      const classifier = yield* Classifier.makeTypeSafe({
        apiKey: Redacted.make('bad-key'),
        model: 'jev-latest',
        baseUrl: 'https://typesafe.test',
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
      const error = yield* Effect.flip(
        classifier.classify(
          [
            {
              pattern: 'loja',
              direction: 'expense',
              description: 'Loja',
              amountCents: -1000,
            },
          ],
          [{ id: 'groceries', name: 'Mercado', bucket: 'essential' }],
        ),
      )
      assert.deepInclude(error, { reason: 'rejected', status: 401 })
      assert.strictEqual(yield* Ref.get(calls), 1)
    }),
  )

  const configured = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const classifier = yield* Classifier
      return {
        modelVersion: classifier.modelVersion,
        applyThreshold: classifier.applyThreshold,
      }
    }).pipe(
      Effect.provide(
        Classifier.layer.pipe(
          Layer.provide(refuseCalls),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        ),
      ),
    )

  it.effect(
    'pins a Jev version and reviews every answer until a threshold is set',
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* configured({ TYPESAFE_API_KEY: 'key' }), {
          modelVersion: Option.some('typesafe:jev-1.13.0'),
          applyThreshold: Number.POSITIVE_INFINITY,
        })
        assert.deepStrictEqual(
          yield* configured({
            TYPESAFE_API_KEY: 'key',
            TYPESAFE_MODEL: 'jev-latest',
            TYPESAFE_APPLY_THRESHOLD: '0.97',
          }),
          {
            modelVersion: Option.some('typesafe:jev-latest'),
            applyThreshold: 0.97,
          },
        )
        // Below the suggest floor a threshold would apply answers the
        // policy drops; refusing to start beats guessing.
        const refused = yield* Effect.exit(
          configured({
            TYPESAFE_API_KEY: 'key',
            TYPESAFE_APPLY_THRESHOLD: '0.3',
          }),
        )
        assert.isTrue(refused._tag === 'Failure')
      }),
  )

  it.effect(
    'applies a model answer from the configured threshold, still without teaching the store',
    () =>
      Effect.gen(function* () {
        const entryOf = yield* statement(
          line('a', '20260901', '-12.00', 'Padaria Real') +
            line('b', '20260902', '-30.00', 'Mercado Talvez'),
        )
        const categorizer = yield* Categorizer
        assert.deepInclude(
          yield* categorizer.explain(yield* entryOf('Padaria Real')),
          { categoryId: 'groceries', origin: 'model', status: 'applied' },
        )
        assert.deepInclude(
          yield* categorizer.explain(yield* entryOf('Mercado Talvez')),
          { categoryId: 'groceries', origin: 'model', status: 'review' },
        )
        assert.deepStrictEqual(yield* (yield* KnowledgeStore).list, [])
      }).pipe(
        Effect.provide(
          categoriesTestWith(
            fakeClassifier(
              {
                'padaria real': { categoryId: 'groceries', probability: 0.97 },
                'mercado talvez': {
                  categoryId: 'groceries',
                  probability: 0.7,
                },
              },
              { applyThreshold: 0.95 },
            ),
          ),
        ),
      ),
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
          pastDecisions: Schema.optional(
            Schema.Array(
              Schema.Struct({
                description: Schema.String,
                category: Schema.String,
              }),
            ),
          ),
        }),
      ),
    }),
    questions: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.Literal('choice'),
        instructions: Schema.String,
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
