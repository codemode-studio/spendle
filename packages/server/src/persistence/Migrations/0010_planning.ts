import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

// The strategy presets V1 seeded, with the same ids, so closed months and
// imported plans keep naming them.
const strategies: ReadonlyArray<
  readonly [
    template: string,
    name: string,
    essential: number,
    lifestyle: number,
    investment: number,
    reserve: number,
  ]
> = [
  ['balanced', 'Equilibrada', 4_000, 2_000, 3_000, 1_000],
  ['wealth', 'Patrimonial', 3_500, 2_000, 3_500, 1_000],
  ['aggressive', 'Agressiva', 3_000, 2_000, 4_000, 1_000],
  ['independence', 'Independência', 3_000, 1_000, 5_000, 1_000],
]

/**
 * Planning: what the person decided about income, strategy, goals and
 * recurrences. Everything here is a durable decision except the assistant's
 * cached reports. Occurrences, payment matches, detection and the monthly
 * picture are projections computed when read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE planning_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monthly_income_target_cents INTEGER NOT NULL
        CHECK (typeof(monthly_income_target_cents) = 'integer' AND monthly_income_target_cents >= 0),
      reserve_months INTEGER NOT NULL CHECK (reserve_months BETWEEN 1 AND 36),
      keep_reserve_contributions INTEGER NOT NULL CHECK (keep_reserve_contributions IN (0, 1)),
      updated_at TEXT
    )
  `
  yield* sql`
    INSERT INTO planning_settings (id, monthly_income_target_cents, reserve_months,
      keep_reserve_contributions)
    VALUES (1, 6000000, 6, 0)
  `

  yield* sql`
    CREATE TABLE budget_strategies (
      id TEXT PRIMARY KEY,
      template TEXT NOT NULL UNIQUE
        CHECK (template IN ('balanced', 'wealth', 'aggressive', 'independence')),
      name TEXT NOT NULL,
      essential_bps INTEGER NOT NULL CHECK (essential_bps BETWEEN 0 AND 10000),
      lifestyle_bps INTEGER NOT NULL CHECK (lifestyle_bps BETWEEN 0 AND 10000),
      investment_bps INTEGER NOT NULL CHECK (investment_bps BETWEEN 0 AND 10000),
      reserve_bps INTEGER NOT NULL CHECK (reserve_bps BETWEEN 0 AND 10000),
      is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
      CHECK (essential_bps + lifestyle_bps + investment_bps + reserve_bps = 10000)
    )
  `
  for (const [
    template,
    name,
    essential,
    lifestyle,
    investment,
    reserve,
  ] of strategies) {
    yield* sql`
      INSERT INTO budget_strategies (id, template, name, essential_bps, lifestyle_bps,
        investment_bps, reserve_bps, is_default)
      VALUES (${`strategy-${template}`}, ${template}, ${name}, ${essential}, ${lifestyle},
        ${investment}, ${reserve}, ${template === 'balanced' ? 1 : 0})
    `
  }

  // A closed month keeps the allocation and income it was closed with, so
  // later strategy changes, imports or recategorisations never rewrite it.
  yield* sql`
    CREATE TABLE monthly_budgets (
      month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
      strategy_id TEXT NOT NULL REFERENCES budget_strategies (id),
      strategy_name TEXT NOT NULL,
      base_income_cents INTEGER NOT NULL CHECK (typeof(base_income_cents) = 'integer'),
      eligible_income_cents INTEGER NOT NULL CHECK (typeof(eligible_income_cents) = 'integer'),
      essential_bps INTEGER NOT NULL,
      lifestyle_bps INTEGER NOT NULL,
      investment_bps INTEGER NOT NULL,
      reserve_bps INTEGER NOT NULL,
      effective_investment_bps INTEGER NOT NULL,
      effective_reserve_bps INTEGER NOT NULL,
      reserve_redirected INTEGER NOT NULL CHECK (reserve_redirected IN (0, 1)),
      origin TEXT NOT NULL CHECK (origin IN ('closing', 'v1_import')),
      closed_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TRIGGER monthly_budgets_no_update BEFORE UPDATE ON monthly_budgets
    BEGIN SELECT RAISE(ABORT, 'closed budgets are frozen'); END
  `
  yield* sql`
    CREATE TRIGGER monthly_budgets_no_delete BEFORE DELETE ON monthly_budgets
    BEGIN SELECT RAISE(ABORT, 'closed budgets are frozen'); END
  `

  yield* sql`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      type TEXT NOT NULL CHECK (type IN ('emergency_reserve', 'medium_term', 'retirement', 'other')),
      target_cents INTEGER NOT NULL CHECK (typeof(target_cents) = 'integer' AND target_cents >= 0),
      -- What the person had already saved when they set the goal.
      initial_cents INTEGER NOT NULL CHECK (typeof(initial_cents) = 'integer' AND initial_cents >= 0),
      target_date TEXT,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE goal_contributions (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
      contributed_on TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX goal_contributions_goal ON goal_contributions (goal_id)`

  yield* sql`
    CREATE TABLE recurrence_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      name_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `
  // A receipt or payment the person expects on a schedule. The schedule
  // (starts_on, anchor, frequency) is the decision; occurrences are derived.
  yield* sql`
    CREATE TABLE recurrences (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      group_id TEXT REFERENCES recurrence_groups (id) ON DELETE SET NULL,
      participant_label TEXT,
      account_id TEXT REFERENCES accounts (id),
      category_id TEXT NOT NULL REFERENCES categories (id),
      amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
      currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
      direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
      amount_mode TEXT NOT NULL CHECK (amount_mode IN ('fixed', 'variable')),
      match_mode TEXT NOT NULL CHECK (match_mode IN ('single', 'aggregate')),
      destination_mode TEXT NOT NULL CHECK (destination_mode IN ('automatic', 'fixed')),
      frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
      starts_on TEXT NOT NULL,
      schedule_anchor TEXT NOT NULL,
      date_tolerance_days INTEGER NOT NULL DEFAULT 15,
      amount_tolerance_bps INTEGER NOT NULL DEFAULT 500,
      auto_match INTEGER NOT NULL DEFAULT 1 CHECK (auto_match IN (0, 1)),
      minimum_confirmations INTEGER NOT NULL DEFAULT 3,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      CHECK (destination_mode <> 'fixed' OR account_id IS NOT NULL)
    )
  `
  // The person's verdict that an entry is (or is not) the payment of one
  // occurrence. Like category decisions, the observations the entry had
  // when decided let the verdict follow it through merges. `revision`
  // orders verdicts about the same pair.
  yield* sql`
    CREATE TABLE recurrence_link_decisions (
      key TEXT PRIMARY KEY,
      recurrence_id TEXT NOT NULL REFERENCES recurrences (id) ON DELETE CASCADE,
      expected_date TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
      origin TEXT NOT NULL CHECK (origin IN ('person', 'approval', 'v1_import')),
      decided_at TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE
    )
  `
  yield* sql`CREATE INDEX recurrence_link_decisions_recurrence ON recurrence_link_decisions (recurrence_id)`
  yield* sql`
    CREATE TABLE recurrence_link_endpoints (
      key TEXT NOT NULL REFERENCES recurrence_link_decisions (key) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (key, source_id, account_id, external_id)
    )
  `
  // An occurrence the person skipped, or an envelope period they closed.
  yield* sql`
    CREATE TABLE recurrence_occurrence_decisions (
      recurrence_id TEXT NOT NULL REFERENCES recurrences (id) ON DELETE CASCADE,
      expected_date TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('skipped', 'completed')),
      decided_at TEXT NOT NULL,
      PRIMARY KEY (recurrence_id, expected_date)
    )
  `
  // Merchant signatures the person tied to a recurrence in V1. Links
  // confirmed in V2 teach their own signatures without a row here.
  yield* sql`
    CREATE TABLE recurrence_aliases (
      recurrence_id TEXT NOT NULL REFERENCES recurrences (id) ON DELETE CASCADE,
      pattern TEXT NOT NULL,
      sample_description TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('v1_import')),
      PRIMARY KEY (recurrence_id, pattern)
    )
  `
  // Candidates the person told detection to stop offering.
  yield* sql`
    CREATE TABLE recurrence_detection_ignores (
      signature TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
      decided_at TEXT NOT NULL,
      PRIMARY KEY (signature, direction)
    )
  `

  // The assistant's reports, cached by what they analysed. Model output,
  // rebuildable, never read as a decision.
  yield* sql`
    CREATE TABLE assistant_reports (
      kind TEXT NOT NULL CHECK (kind IN ('monthly', 'initial')),
      month TEXT NOT NULL,
      report TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (kind, month)
    )
  `

  // What `migrate-v1` brought over for planning, so a second run changes nothing.
  yield* sql`
    CREATE TABLE v1_import_planning_map (
      kind TEXT NOT NULL CHECK (kind IN (
        'settings', 'strategy', 'budget', 'goal', 'recurrence_group', 'recurrence',
        'recurrence_alias', 'occurrence_skip', 'detection_ignore'
      )),
      v1_id TEXT NOT NULL,
      v2_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (kind, v1_id)
    )
  `
  // A payment the person linked to a recurrence in V1, applied as a V2 link
  // decision once its movement maps to exactly one entry.
  yield* sql`
    CREATE TABLE v1_import_recurrence_links (
      v1_match_id TEXT PRIMARY KEY,
      recurrence_id TEXT NOT NULL REFERENCES recurrences (id) ON DELETE CASCADE,
      expected_date TEXT NOT NULL,
      v1_transaction_id TEXT NOT NULL REFERENCES v1_import_movements (v1_transaction_id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'superseded', 'refused')),
      entry_id TEXT,
      detail TEXT,
      resolved_at TEXT
    )
  `
})
