import * as Migrator from 'effect/sql/Migrator'

import EventLog from './Migrations/0001_event_log.ts'
import Ledger from './Migrations/0002_ledger.ts'
import OpenFinance from './Migrations/0003_open_finance.ts'
import Imports from './Migrations/0004_imports.ts'
import Entries from './Migrations/0005_entries.ts'
import Relations from './Migrations/0006_relations.ts'
import RefundRelations from './Migrations/0007_refund_relations.ts'
import Categories from './Migrations/0008_categories.ts'
import V1Import from './Migrations/0009_v1_import.ts'
import Planning from './Migrations/0010_planning.ts'
import InvestmentsManual from './Migrations/0011_investments_manual.ts'
import StatementAdvance from './Migrations/0012_statement_advance.ts'
import ExchangeRates from './Migrations/0013_exchange_rates.ts'
import ClassifierContext from './Migrations/0014_classifier_context.ts'
import DropV1Import from './Migrations/0015_drop_v1_import.ts'
import StartupMarks from './Migrations/0016_startup_marks.ts'
import RelationOrphans from './Migrations/0017_relation_orphans.ts'
import GhostConnections from './Migrations/0018_ghost_connections.ts'
import BillPaymentName from './Migrations/0019_bill_payment_name.ts'
import CardCredit from './Migrations/0020_card_credit.ts'
import CardBills from './Migrations/0021_card_bills.ts'

// Keys are `<id>_<name>`; each migration runs once, in id order. Import every
// migration statically so the server never depends on files beside the bundle.
// Never edit a merged migration; add a new one.
export const migrations = {
  '0001_event_log': EventLog,
  '0002_ledger': Ledger,
  '0003_open_finance': OpenFinance,
  '0004_imports': Imports,
  '0005_entries': Entries,
  '0006_relations': Relations,
  '0007_refund_relations': RefundRelations,
  '0008_categories': Categories,
  '0009_v1_import': V1Import,
  '0010_planning': Planning,
  '0011_investments_manual': InvestmentsManual,
  '0012_statement_advance': StatementAdvance,
  '0013_exchange_rates': ExchangeRates,
  '0014_classifier_context': ClassifierContext,
  '0015_drop_v1_import': DropV1Import,
  '0016_startup_marks': StartupMarks,
  '0017_relation_orphans': RelationOrphans,
  '0018_ghost_connections': GhostConnections,
  '0019_bill_payment_name': BillPaymentName,
  '0020_card_credit': CardCredit,
  '0021_card_bills': CardBills,
}

// The generic migrator, so the same migrations run on any SQLite client.
export const runMigrations = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
})
