import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Config from 'effect/Config'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
// NodeHttpServer adapts a Node server; there is no Effect equivalent to import instead.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from 'node:http'

import { ApiConfig } from '../api/ApiConfig.ts'
import { ApiRoutes } from '../api/Routes.ts'
import { Categories } from '../categories/Categories.ts'
import * as Categorizer from '../categories/Categorizer.ts'
import { Classifier } from '../categories/Classifier.ts'
import { KnowledgeStore } from '../categories/KnowledgeStore.ts'
import * as Reactor from '../events/Reactor.ts'
import { Imports } from '../imports/Imports.ts'
import { Investments } from '../investments/Investments.ts'
import { Accounts } from '../ledger/Accounts.ts'
import * as Entries from '../ledger/Entries.ts'
import { ManualEntries } from '../ledger/Manual.ts'
import { Notes } from '../ledger/Notes.ts'
import { OpenFinance } from '../openfinance/OpenFinance.ts'
import type {
  PluggyAccount,
  PluggyTransaction,
} from '../openfinance/PluggyApi.ts'
import { PluggyClient } from '../openfinance/PluggyClient.ts'
import * as SyncReactor from '../openfinance/SyncReactor.ts'
import { WebhookConfig } from '../openfinance/WebhookConfig.ts'
import { Cards } from '../reconciliation/Cards.ts'
import * as Reconciliation from '../reconciliation/Reconciliation.ts'
import { AssistantModel } from '../planning/AssistantModel.ts'
import { PlanningServices } from '../planning/Services.ts'
import { addDays } from '../domain/LocalDate.ts'
import { Rejected } from '../api/definition/Errors.ts'
import { memberHeader } from '../api/definition/Security.ts'
import { SpaceApi } from '../api/definition/Space.ts'
import { SecurityLive } from '../api/Security.ts'
import { makeFake } from './FakePluggy.ts'
import { fakeExchangeRates } from './FakeRates.ts'
import type { FakePluggyData } from './FakePluggy.ts'
import { LedgerTest } from './layers.ts'

/**
 * The API for browser QA: an in-memory database with synthetic accounts
 * and a fake Pluggy whose item carries synthetic movements, so the connect
 * flow runs end to end without credentials. Never point it at real data.
 *
 *   SPENDLE_SERVER_PORT=4199 node src/testing/QaServer.ts
 */

const bank: PluggyAccount = {
  id: 'qa-provider-bank',
  type: 'BANK',
  subtype: 'CHECKING_ACCOUNT',
  name: 'Conta Corrente QA',
  number: '0001/99999-0',
  balance: 4523.6,
  currencyCode: 'BRL',
}

const card: PluggyAccount = {
  id: 'qa-provider-card',
  type: 'CREDIT',
  subtype: 'CREDIT_CARD',
  name: 'Cartão QA Platinum',
  number: '5555 **** **** 4242',
  balance: 389.7,
  currencyCode: 'BRL',
  creditData: { creditLimit: 5000, availableCreditLimit: 4610.3 },
}

const qaBill = 'qa-bill'

/** The card's bill for the restaurant and the store, which the payment paid. */
const bills = (today: DateTime.Utc) => {
  const day = (offset: number) =>
    `${DateTime.formatIsoDate(DateTime.subtract(today, { days: offset }))}T00:00:00.000Z`
  return {
    [card.id]: [
      {
        id: qaBill,
        billClosingDate: day(33),
        dueDate: day(26),
        totalAmount: 210.3,
      },
    ],
  }
}

/** Synthetic movements dated relative to today, as Pluggy reports them. */
const movements = (today: DateTime.Utc) => {
  const day = (offset: number) =>
    `${DateTime.formatIsoDate(DateTime.subtract(today, { days: offset }))}T15:00:00.000Z`
  const tx = (
    id: string,
    offset: number,
    fields: Partial<PluggyTransaction>,
  ): PluggyTransaction => ({
    id,
    accountId: bank.id,
    date: day(offset),
    description: id,
    type: 'DEBIT',
    amount: 10,
    currencyCode: 'BRL',
    status: 'POSTED',
    ...fields,
  })
  return {
    [bank.id]: [
      tx('qa-salary', 40, {
        type: 'CREDIT',
        amount: 5000,
        description: 'SALARIO ACME LTDA',
        category: 'Salary',
        categoryId: '01010000',
      }),
      tx('qa-market', 35, {
        amount: 120.5,
        description: 'SUPERMERCADO PAO DOCE',
        category: 'Groceries',
        categoryId: '05080000',
      }),
      tx('qa-card-bill', 28, {
        amount: 210.3,
        description: 'PAGAMENTO FATURA CARTAO',
        category: 'Credit card payment',
        categoryId: '05100000',
      }),
      tx('qa-uber', 20, {
        amount: 45.9,
        description: 'UBER *TRIP',
        category: 'Taxi and ride-hailing',
        categoryId: '19050000',
      }),
      tx('qa-pix-out', 10, {
        amount: 300,
        description: 'PIX ENVIADO MARIA SILVA',
        category: 'Transfer - PIX',
        categoryId: '04000000',
      }),
      tx('qa-refund', 5, {
        type: 'CREDIT',
        amount: 150,
        description: 'REEMBOLSO LOJA XYZ',
      }),
      tx('qa-pharmacy', 1, {
        amount: 60,
        description: 'FARMACIA SAUDE',
        status: 'PENDING',
        category: 'Pharmacy',
        categoryId: '14020000',
      }),
    ],
    [card.id]: [
      tx('qa-card-restaurant', 45, {
        accountId: card.id,
        amount: 89.9,
        description: 'RESTAURANTE SABOR',
        category: 'Restaurants',
        categoryId: '05070000',
        creditCardMetadata: { billId: qaBill },
      }),
      tx('qa-card-store', 38, {
        accountId: card.id,
        amount: 120.4,
        description: 'LOJA DE ROUPAS 2/6',
        category: 'Clothing',
        creditCardMetadata: {
          installmentNumber: 2,
          totalInstallments: 6,
          totalAmount: 722.4,
          billId: qaBill,
        },
      }),
      tx('qa-card-payment', 27, {
        accountId: card.id,
        type: 'CREDIT',
        amount: -210.3,
        description: 'PAGAMENTO RECEBIDO',
        category: 'Credit card payment',
      }),
      // Pluggy lists some bill payments twice on the card, under another id.
      tx('qa-card-payment-copy', 26, {
        accountId: card.id,
        type: 'CREDIT',
        amount: -210.3,
        description: 'PAGAMENTO ON LINE',
        category: 'Shopping',
      }),
      // Pluggy reports a card's charges as pending until the bill comes due.
      tx('qa-card-streaming', 12, {
        accountId: card.id,
        amount: 39.9,
        description: 'NETFLIX.COM',
        status: 'PENDING',
        category: 'Video streaming',
      }),
      tx('qa-card-market', 3, {
        accountId: card.id,
        amount: 139.5,
        status: 'PENDING',
        description: 'SUPERMERCADO PAO DOCE',
        category: 'Groceries',
        categoryId: '05080000',
      }),
    ],
  }
}

/** The fake Pluggy; its item belongs to whichever connection asked for a token last. */
const QaPluggy = Layer.unwrap(
  Effect.gen(function* () {
    const today = yield* DateTime.now
    const state = yield* Ref.make<FakePluggyData>({
      clientUserId: '',
      accounts: [bank, card],
      transactions: movements(today),
      bills: bills(today),
      deleted: [],
      webhooks: [],
      connectTokens: [],
    })
    const fake = makeFake(state)
    return Layer.succeed(
      PluggyClient,
      PluggyClient.of({
        ...fake,
        createConnectToken: (input) =>
          fake.createConnectToken(input).pipe(
            Effect.tap(() =>
              Ref.update(state, (current) => ({
                ...current,
                clientUserId: input.clientUserId,
              })),
            ),
          ),
      }),
    )
  }),
)

// US$ 1 = R$ 5,40 every day from 2025 through 2027, so QA values are stable.
const qaRates = {
  USD: Array.from(
    { length: 365 * 3 + 1 },
    (_, day) => [addDays('2025-01-01', day), 5_400_000] as const,
  ),
}

const Services = PlanningServices.pipe(
  Layer.provideMerge(AssistantModel.disabled),
  Layer.provideMerge(
    Layer.mergeAll(
      SyncReactor.layer,
      Entries.reactor,
      Reconciliation.reactor,
      Categorizer.reactor,
      Categorizer.modelReactor,
      ManualEntries.layer,
      Investments.layer,
    ).pipe(
      // A fake rate source keeps QA offline and its values stable.
      Layer.provideMerge(
        Layer.mergeAll(Notes.layer, fakeExchangeRates(qaRates)),
      ),
      Layer.provideMerge(Categorizer.Categorizer.layer),
      Layer.provideMerge(KnowledgeStore.layer),
      Layer.provideMerge(Categories.layer),
      Layer.provideMerge(Classifier.disabled),
      Layer.provideMerge(
        Layer.mergeAll(
          Entries.Entries.layer,
          Imports.layer,
          Reconciliation.Reconciliation.layer,
          Cards.layer,
        ),
      ),
      Layer.provideMerge(OpenFinance.layer),
      Layer.provideMerge(Reactor.Reactors.layer),
      Layer.provideMerge(QaPluggy),
      Layer.provideMerge(WebhookConfig.layerTest(Option.none())),
      Layer.provideMerge(LedgerTest),
    ),
  ),
)

/** The owner, account and card the browser QA guide refers to. */
const Seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const owner = yield* accounts.createOwner({
      name: 'Família QA',
      kind: 'household',
    })
    yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Banco QA',
      name: 'Conta BRL de teste',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    })
    yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Banco QA',
      name: 'Cartão BRL de teste',
      kind: 'credit_card',
      purpose: 'operating',
      currency: 'BRL',
      card: {
        closingDay: 5,
        dueDay: 12,
        limitCents: 300_000,
        lastFour: '1234',
      },
    })
    yield* Effect.logInfo('QA data seeded', { ownerId: owner.id })
  }),
)

const HttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port('SPENDLE_SERVER_PORT').pipe(
      Config.withDefault(4199),
    )
    return NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })
  }),
)

// QA serves a single space: the QA member owns it, and its members do not
// change. The full member flow is covered by `spaces/Members.test.ts`.
const QaMembers = HttpApiBuilder.layer(SpaceApi).pipe(
  Layer.provide(
    HttpApiBuilder.group(SpaceApi, 'space', (handlers) => {
      const view = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const you = request.headers[memberHeader] ?? 'qa@spendle.local'
        return {
          id: 'qa',
          name: 'Família QA',
          you,
          members: [{ email: you, role: 'owner' as const }],
        }
      })
      const fixed = new Rejected({ reason: 'qa_fixed_members', detail: null })
      return Effect.succeed(
        handlers.handleAll({
          get: () => view,
          addMember: () => Effect.fail(fixed),
          removeMember: () => Effect.fail(fixed),
        }),
      )
    }),
  ),
  Layer.provide(SecurityLive),
)

HttpRouter.serve(
  Layer.mergeAll(ApiRoutes, QaMembers).pipe(
    Layer.provide(ApiConfig.layerTest()),
  ),
).pipe(
  Layer.provideMerge(Seed),
  Layer.provideMerge(Services),
  Layer.provide(HttpServer),
  Layer.launch,
  NodeRuntime.runMain,
)
