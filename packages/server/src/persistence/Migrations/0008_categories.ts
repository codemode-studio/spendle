import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

// V1's categories with their ids, so decisions imported from V1 keep them.
// `transfer` and `card_payment` belong to reconciliation (`system`): nobody
// assigns them by hand and the store never learns them. `food` was split
// into groceries, restaurants and delivery and stays archived for history.
const seed: ReadonlyArray<
  readonly [id: string, name: string, bucket: string, color: string]
> = [
  ['housing', 'Moradia', 'essential', '#2563eb'],
  ['financing', 'Financiamentos', 'essential', '#1d4ed8'],
  ['utilities', 'Contas e serviços', 'essential', '#0284c7'],
  ['groceries', 'Mercado', 'essential', '#0d9488'],
  ['restaurants', 'Restaurantes', 'lifestyle', '#d97706'],
  ['delivery', 'Delivery', 'lifestyle', '#f97316'],
  ['food', 'Alimentação', 'essential', '#0d9488'],
  ['transport', 'Transporte', 'essential', '#0891b2'],
  ['health', 'Saúde', 'essential', '#dc2626'],
  ['education', 'Educação', 'essential', '#7c3aed'],
  ['insurance', 'Seguros', 'essential', '#0369a1'],
  ['family', 'Família e filhos', 'essential', '#9333ea'],
  ['leisure', 'Lazer', 'lifestyle', '#db2777'],
  ['shopping', 'Compras', 'lifestyle', '#ea580c'],
  ['travel', 'Viagens', 'lifestyle', '#4f46e5'],
  ['subscriptions', 'Assinaturas', 'lifestyle', '#c026d3'],
  ['personal_care', 'Cuidados pessoais', 'lifestyle', '#e11d48'],
  ['pets', 'Pets', 'lifestyle', '#ca8a04'],
  ['maintenance', 'Manutenção e reparos', 'essential', '#64748b'],
  ['fees_interest', 'Tarifas e juros', 'tax', '#9f1239'],
  ['other_expense', 'Outras despesas', 'lifestyle', '#78716c'],
  ['investment', 'Investimentos', 'investment', '#16a34a'],
  ['reserve', 'Reserva', 'reserve', '#059669'],
  ['salary', 'Renda familiar', 'income', '#15803d'],
  ['profit_distribution_income', 'Distribuição de lucros', 'income', '#166534'],
  ['services_income', 'Serviços e trabalhos extras', 'income', '#047857'],
  ['rental_income', 'Aluguéis recebidos', 'income', '#0f766e'],
  ['investment_income', 'Rendimentos de investimentos', 'income', '#166534'],
  ['reimbursements', 'Reembolsos e restituições', 'income', '#15803d'],
  ['asset_sales', 'Venda de bens', 'income', '#4d7c0f'],
  ['other_income', 'Outras receitas', 'income', '#3f6212'],
  ['business', 'Empresa', 'business', '#475569'],
  ['tax', 'Impostos', 'tax', '#b91c1c'],
  ['transfer', 'Transferência interna', 'excluded', '#64748b'],
  ['card_payment', 'Pagamento de cartão', 'excluded', '#64748b'],
  ['uncategorized', 'Sem categoria', 'excluded', '#94a3b8'],
]
const archived = new Set(['food'])
const system = new Set(['transfer', 'card_payment'])

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Configuration only the person changes. Categories are archived, never
  // deleted, so decisions and patterns always name an existing one.
  yield* sql`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES categories (id),
      name TEXT NOT NULL,
      bucket TEXT NOT NULL CHECK (bucket IN (
        'essential', 'lifestyle', 'investment', 'reserve', 'income', 'business', 'tax', 'excluded'
      )),
      color TEXT NOT NULL DEFAULT '#64748b',
      icon TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1))
    )
  `
  for (const [id, name, bucket, color] of seed) {
    yield* sql`
      INSERT INTO categories (id, name, bucket, color, active, system)
      VALUES (${id}, ${name}, ${bucket}, ${color}, ${archived.has(id) ? 0 : 1},
        ${system.has(id) ? 1 : 0})
    `
  }

  // A person's category for one movement. `uncategorized` means "leave it
  // without a category" and still settles the review. `revision` orders
  // decisions: when merged entries carry two, the latest wins.
  yield* sql`
    CREATE TABLE category_decisions (
      key TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES categories (id),
      origin TEXT NOT NULL CHECK (origin IN ('transaction_list', 'review', 'v1_import')),
      decided_at TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE
    )
  `
  // The observations the entry had when decided, so the decision follows
  // them through merges and pending-to-posted updates. Only ever added to.
  yield* sql`
    CREATE TABLE category_decision_endpoints (
      key TEXT NOT NULL REFERENCES category_decisions (key) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      PRIMARY KEY (key, source_id, account_id, external_id)
    )
  `
  // What the person taught: merchant patterns learned from decisions or
  // edited by hand, and provider categories they mapped. Prefixes exist
  // only when the person creates or promotes one. Provider mappings apply
  // to both directions (`any`).
  yield* sql`
    CREATE TABLE category_patterns (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('merchant', 'provider_category')),
      pattern TEXT NOT NULL,
      match_mode TEXT NOT NULL CHECK (match_mode IN ('exact', 'prefix')),
      direction TEXT NOT NULL CHECK (direction IN ('income', 'expense', 'any')),
      category_id TEXT NOT NULL REFERENCES categories (id),
      signature TEXT NOT NULL,
      sample_description TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN (
        'transaction_list', 'review', 'v1_import', 'store_edit', 'provider_mapping'
      )),
      confirmations INTEGER NOT NULL DEFAULT 1,
      corrections INTEGER NOT NULL DEFAULT 0,
      last_learned_at TEXT NOT NULL,
      UNIQUE (kind, pattern, match_mode, direction)
    )
  `
  // A projection of entries, relations, decisions and the store. Entry ids
  // are not foreign keys: entries are rewritten per account on each
  // resolution, and the next rebuild drops inferences of vanished ones.
  yield* sql`
    CREATE TABLE category_inferences (
      entry_id TEXT PRIMARY KEY,
      category_id TEXT,
      origin TEXT NOT NULL CHECK (origin IN (
        'decision', 'reconciliation', 'refund', 'pattern', 'prefix', 'provider', 'model', 'none'
      )),
      origin_ref TEXT,
      policy_version INTEGER NOT NULL,
      confidence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applied', 'review', 'none')),
      excluded_from_spending INTEGER NOT NULL CHECK (excluded_from_spending IN (0, 1)),
      reasons TEXT NOT NULL,
      candidates TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX category_inferences_status ON category_inferences (status)`
  // Paid answers from the model, cached by what it was asked; rebuildable,
  // and never read as a decision.
  yield* sql`
    CREATE TABLE model_classifications (
      pattern TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
      model_version TEXT NOT NULL,
      -- Null when the model found no category that fits.
      category_id TEXT,
      probability REAL NOT NULL,
      classified_at TEXT NOT NULL,
      PRIMARY KEY (pattern, direction, model_version)
    )
  `
  // The last event sequence and policy version inferences reflect.
  yield* sql`
    CREATE TABLE categorization_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL,
      policy_version INTEGER NOT NULL
    )
  `
})
