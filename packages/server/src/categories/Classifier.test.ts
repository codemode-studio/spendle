import { assert, describe, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as TestClock from 'effect/testing/TestClock'

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

  it.effect('reports a refused key as rejected without retrying', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const client = HttpClient.make((request) =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                '{"error":{"message":"No auth credentials found"}}',
                {
                  status: 401,
                },
              ),
            ),
          ),
        ),
      )
      const classifier = yield* Classifier.makeOpenRouter({
        apiKey: Redacted.make('bad-key'),
        model: 'openai/gpt-6-luna',
        baseUrl: 'https://openrouter.test',
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

  /** OpenRouter answering each request with `answer`, recording what was sent. */
  const openRouter = (
    answer: (
      sent: typeof SentChat.Type,
      state: typeof SentState.Type,
    ) => ReadonlyArray<unknown>,
  ) =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<typeof SentState.Type>>([])
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          assert.strictEqual(
            request.headers['authorization'],
            'Bearer test-key',
          )
          const sent = yield* Schema.decodeUnknownEffect(SentChat)(
            request.body._tag === 'Uint8Array'
              ? new TextDecoder().decode(request.body.body)
              : '',
          )
          const state = yield* Schema.decodeUnknownEffect(SentState)(
            sent.messages[1]!.content,
          )
          yield* Ref.update(requests, (all) => [...all, state])
          const content = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({ answers: answer(sent, state) })
          const json = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(json, { status: 200 }),
          )
        }).pipe(Effect.orDie),
      )
      const classifier = yield* Classifier.makeOpenRouter({
        apiKey: Redacted.make('test-key'),
        model: 'openai/gpt-6-luna',
        baseUrl: 'https://openrouter.test',
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)))
      return { classifier, requests }
    })

  it.effect(
    'asks the language model about each direction apart and maps its answers back by index',
    () =>
      Effect.gen(function* () {
        const { classifier, requests } = yield* openRouter((sent, state) => {
          assert.strictEqual(sent.model, 'openai/gpt-6-luna')
          // Answered out of order, so only the index ties answers to items.
          return [...state.transactions].reverse().map((transaction) => ({
            index: transaction.index,
            categoryId:
              transaction.direction === 'money received'
                ? 'salary'
                : transaction.description === 'Padaria Real'
                  ? 'groceries'
                  : 'none',
            confidence: transaction.description === 'Loja' ? 0.6 : 0.9,
          }))
        })
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
            {
              pattern: 'padaria real',
              direction: 'expense',
              description: 'Padaria Real',
              amountCents: -1200,
              examples: [
                { description: 'Padaria Central', categoryId: 'groceries' },
              ],
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
          { categoryId: null, probability: 0.6 },
          { categoryId: 'salary', probability: 0.9 },
          { categoryId: 'groceries', probability: 0.9 },
        ])
        assert.deepStrictEqual(
          classifier.modelVersion,
          Option.some('openrouter:openai/gpt-6-luna'),
        )
        assert.sameDeepMembers(
          (yield* Ref.get(requests)).map((state) => ({
            offered: state.categories.map((category) => category.id),
            asked: state.transactions.map((transaction) => [
              transaction.description,
              transaction.pastDecisions ?? [],
            ]),
          })),
          [
            {
              offered: ['groceries'],
              asked: [
                ['Loja', []],
                [
                  'Padaria Real',
                  [{ description: 'Padaria Central', categoryId: 'groceries' }],
                ],
              ],
            },
            { offered: ['salary'], asked: [['Empresa', []]] },
          ],
        )
      }),
  )

  it.effect(
    'asks again when an answer skips a transaction, and fails rather than guess',
    () =>
      Effect.gen(function* () {
        // One answer for two transactions, every time.
        const { classifier, requests } = yield* openRouter(() => [
          { index: 0, categoryId: 'groceries', confidence: 0.9 },
        ])
        const fiber = yield* Effect.forkChild(
          Effect.flip(
            classifier.classify(
              ['Loja', 'Padaria'].map((description) => ({
                pattern: description.toLowerCase(),
                direction: 'expense' as const,
                description,
                amountCents: -1000,
              })),
              [{ id: 'groceries', name: 'Mercado', bucket: 'essential' }],
            ),
          ),
        )
        // Let the retry backoff elapse.
        yield* TestClock.adjust('1 minute')
        const error = yield* Fiber.join(fiber)
        assert.strictEqual(error.reason, 'invalid_response')
        assert.lengthOf(yield* Ref.get(requests), 3)
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
    'pins GPT-6 Luna and reviews every answer until a threshold is set',
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* configured({ OPENROUTER_API_KEY: 'key' }),
          {
            modelVersion: Option.some('openrouter:openai/gpt-6-luna'),
            applyThreshold: Number.POSITIVE_INFINITY,
          },
        )
        assert.deepStrictEqual(
          yield* configured({
            OPENROUTER_API_KEY: 'key',
            CLASSIFIER_MODEL: 'anthropic/claude-haiku-5.5',
            CLASSIFIER_APPLY_THRESHOLD: '0.97',
          }),
          {
            modelVersion: Option.some('openrouter:anthropic/claude-haiku-5.5'),
            applyThreshold: 0.97,
          },
        )
        // An empty key, as a blank line in an env file leaves it, is no key.
        assert.isTrue(
          Option.isNone(
            (yield* configured({ OPENROUTER_API_KEY: '' })).modelVersion,
          ),
        )
        // Below the suggest floor a threshold would apply answers the
        // policy drops; refusing to start beats guessing.
        const refused = yield* Effect.exit(
          configured({
            OPENROUTER_API_KEY: 'key',
            CLASSIFIER_APPLY_THRESHOLD: '0.3',
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

const SentChat = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    messages: Schema.Tuple([
      Schema.Struct({ role: Schema.Literal('system'), content: Schema.String }),
      Schema.Struct({ role: Schema.Literal('user'), content: Schema.String }),
    ]),
  }),
)

const SentState = Schema.fromJsonString(
  Schema.Struct({
    categories: Schema.Array(Schema.Struct({ id: Schema.String })),
    transactions: Schema.Array(
      Schema.Struct({
        index: Schema.Int,
        description: Schema.String,
        direction: Schema.String,
        pastDecisions: Schema.optional(
          Schema.Array(
            Schema.Struct({
              description: Schema.String,
              categoryId: Schema.String,
            }),
          ),
        ),
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
