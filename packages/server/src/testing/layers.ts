import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as Layer from 'effect/Layer'

import { EventLog } from '../events/EventLog.ts'
import { Imports } from '../imports/Imports.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import * as Sqlite from '../persistence/Sqlite.ts'

/** A fresh in-memory database with the event log. */
export const CoreTest = EventLog.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Sqlite.layerMemory, NodeCrypto.layer)),
)

/** Ledger services over `CoreTest`. */
export const LedgerTest = Observations.layer.pipe(
  Layer.provideMerge(Accounts.layer),
  Layer.provideMerge(CoreTest),
)

/** File imports over `LedgerTest`. */
export const ImportsTest = Imports.layer.pipe(Layer.provideMerge(LedgerTest))
