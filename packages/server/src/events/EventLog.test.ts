import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as Sqlite from '../persistence/Sqlite.ts'
import { EventLog } from './EventLog.ts'

const TestLayer = EventLog.layer.pipe(
  Layer.provide([Sqlite.layerMemory, NodeCrypto.layer]),
)

describe('EventLog', () => {
  it.effect('appends events in order and reads them back', () =>
    Effect.gen(function* () {
      const log = yield* EventLog
      const stored = yield* log.append([
        {
          type: 'AccountOpened',
          streamId: 'account-1',
          payload: { name: 'Conta' },
        },
        {
          type: 'BalanceObserved',
          streamId: 'account-1',
          payload: { cents: 1050 },
        },
      ])

      const read = yield* log.readAfter(0, 10)
      assert.deepStrictEqual(
        read.map((event) => [event.sequence, event.type, event.payload]),
        [
          [1, 'AccountOpened', { name: 'Conta' }],
          [2, 'BalanceObserved', { cents: 1050 }],
        ],
      )
      assert.deepStrictEqual(read, stored)
      assert.strictEqual(yield* log.latestSequence, 2)
      assert.deepStrictEqual(yield* log.readAfter(1, 10), read.slice(1))
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('ignores an event whose id was already appended', () =>
    Effect.gen(function* () {
      const log = yield* EventLog
      const event = {
        type: 'WebhookReceived',
        streamId: 'item-1',
        payload: { event: 'transactions/created' },
        eventId: 'pluggy-event-1',
      }
      assert.strictEqual((yield* log.append([event])).length, 1)
      assert.strictEqual((yield* log.append([event])).length, 0)
      assert.strictEqual(yield* log.latestSequence, 1)
    }).pipe(Effect.provide(TestLayer)),
  )
})
