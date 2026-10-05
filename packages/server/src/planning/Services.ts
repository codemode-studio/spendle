import * as Layer from 'effect/Layer'

import { Assistant } from './Assistant.ts'
import { Dashboard } from './Dashboard.ts'
import { LedgerReads } from './LedgerReads.ts'
import { Planning } from './Planning.ts'
import { Recurrences } from './Recurrences.ts'

/**
 * Planning, recurrences, the dashboard and the assistant. Needs the ledger,
 * card cycles, the categorizer, investments (for the reserve) and an
 * `AssistantModel`.
 */
export const PlanningServices = Assistant.layer.pipe(
  Layer.provideMerge(Dashboard.layer),
  Layer.provideMerge(Recurrences.layer),
  Layer.provideMerge(Planning.layer),
  Layer.provideMerge(LedgerReads.layer),
)
