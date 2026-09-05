import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { merchantSignature } from '#/domain/recurrence-book'

const migration = readFileSync(
  resolve(process.cwd(), 'drizzle/0034_backfill_knowledge_base.sql'),
  'utf8',
)

/** Forma das tabelas na época da 0034 (antes dos padrões da 0036). */
const legacySchema = `
  CREATE TABLE categories (id text PRIMARY KEY NOT NULL);
  CREATE TABLE recurrences (id text PRIMARY KEY NOT NULL);
  CREATE TABLE staged_transactions (
    id text PRIMARY KEY NOT NULL,
    description text NOT NULL,
    amount_cents integer NOT NULL,
    suggested_category_id text,
    suggestion_source text NOT NULL,
    created_at integer NOT NULL
  );
  CREATE TABLE transactions (
    id text PRIMARY KEY NOT NULL,
    import_id text,
    description text NOT NULL,
    amount_cents integer NOT NULL,
    category_id text,
    created_at integer NOT NULL
  );
  CREATE TABLE transaction_evidence (
    id text PRIMARY KEY NOT NULL,
    staged_transaction_id text NOT NULL,
    transaction_id text NOT NULL,
    match_kind text NOT NULL
  );
  CREATE TABLE recurrence_occurrences (
    id text PRIMARY KEY NOT NULL,
    recurrence_id text NOT NULL,
    category_id text NOT NULL
  );
  CREATE TABLE recurrence_matches (
    id text PRIMARY KEY NOT NULL,
    occurrence_id text NOT NULL,
    transaction_id text NOT NULL,
    status text NOT NULL,
    confirmed_at integer,
    created_at integer NOT NULL
  );
  CREATE TABLE knowledge_base (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    signature text NOT NULL,
    direction text NOT NULL,
    category_id text REFERENCES categories(id) ON DELETE CASCADE,
    recurrence_id text REFERENCES recurrences(id) ON DELETE CASCADE,
    sample_description text NOT NULL,
    source text NOT NULL,
    confirmations integer DEFAULT 1 NOT NULL,
    corrections integer DEFAULT 0 NOT NULL,
    last_learned_at integer DEFAULT (unixepoch()) NOT NULL,
    created_at integer DEFAULT (unixepoch()) NOT NULL
  );
  CREATE UNIQUE INDEX knowledge_base_key_idx ON knowledge_base (kind, signature, direction);
`

const older = 1_700_000_000
const newer = 1_700_100_000

describe('backfill da base de conhecimento (0034)', () => {
  let sqlite: Database.Database | undefined

  afterEach(() => sqlite?.close())

  it('reconstrói só decisões humanas, escolhe a mais recente e é idempotente', () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    sqlite.function('merchant_signature', { deterministic: true }, (value) =>
      merchantSignature(String(value ?? '')),
    )
    sqlite.exec(legacySchema)
    sqlite.exec(`
      INSERT INTO categories (id) VALUES ('family'), ('food'), ('housing'), ('leisure'), ('personal_care'), ('subscriptions'), ('transfer'), ('uncategorized');
      INSERT INTO recurrences (id) VALUES ('rec-netflix'), ('rec-spotify');
      INSERT INTO staged_transactions VALUES
        ('st-review', 'LOJA DO BAIRRO 4421', -4500, 'family', 'manual', ${older}),
        ('st-overridden', 'SUPERMERCADO BOM 1', -30000, 'food', 'heuristic', ${older}),
        ('st-uncategorized', 'CLINICA VIDA 22', -20000, 'uncategorized', 'none', ${older}),
        ('st-transfer', 'ENVIADO PARA FULANO', -50000, 'transfer', 'manual', ${older}),
        ('st-later', 'LOJA DO BAIRRO 9999', -9900, 'food', 'heuristic', ${newer});
      INSERT INTO transactions VALUES
        ('tx-overridden', 'legacy-import', 'SUPERMERCADO BOM 1', -30000, 'housing', ${older}),
        ('tx-uncategorized', 'legacy-import', 'CLINICA VIDA 22', -20000, 'leisure', ${older}),
        ('tx-later', 'legacy-import', 'LOJA DO BAIRRO 9999', -9900, 'leisure', ${newer}),
        ('tx-manual', NULL, 'ACADEMIA FIT 99', -15000, 'personal_care', ${older}),
        ('tx-netflix', 'legacy-import', 'PG *NETFLIX.COM 847291', -3990, 'subscriptions', ${older}),
        ('tx-spotify', 'legacy-import', 'SPOTIFY 1001', -2190, 'subscriptions', ${older});
      INSERT INTO transaction_evidence VALUES
        ('ev-overridden', 'st-overridden', 'tx-overridden', 'created'),
        ('ev-uncategorized', 'st-uncategorized', 'tx-uncategorized', 'created'),
        ('ev-later', 'st-later', 'tx-later', 'created');
      INSERT INTO recurrence_occurrences VALUES
        ('occ-netflix', 'rec-netflix', 'subscriptions'),
        ('occ-spotify', 'rec-spotify', 'subscriptions');
      INSERT INTO recurrence_matches VALUES
        ('match-netflix', 'occ-netflix', 'tx-netflix', 'confirmed', ${older}, ${older}),
        ('match-spotify', 'occ-spotify', 'tx-spotify', 'auto_confirmed', ${older}, ${older});
    `)

    const run = () => {
      for (const statement of migration.split('--> statement-breakpoint')) {
        sqlite!.exec(statement)
      }
    }
    run()

    const rows = sqlite
      .prepare(
        'SELECT kind, signature, direction, category_id, recurrence_id, sample_description, source, confirmations, corrections, last_learned_at FROM knowledge_base ORDER BY kind, signature',
      )
      .all()
    expect(rows).toMatchObject([
      {
        kind: 'category',
        signature: 'academia fit 99',
        direction: 'expense',
        category_id: 'personal_care',
        source: 'transaction_review',
        confirmations: 1,
        corrections: 0,
      },
      {
        kind: 'category',
        signature: 'loja do bairro',
        category_id: 'leisure',
        sample_description: 'LOJA DO BAIRRO 9999',
        source: 'transaction_review',
        confirmations: 1,
        corrections: 1,
        last_learned_at: newer,
      },
      {
        kind: 'category',
        signature: 'netflix com',
        category_id: 'subscriptions',
        source: 'recurrence_link',
      },
      {
        kind: 'category',
        signature: 'supermercado bom 1',
        category_id: 'housing',
        source: 'transaction_review',
      },
      {
        kind: 'recurrence',
        signature: 'netflix com',
        recurrence_id: 'rec-netflix',
        category_id: null,
        source: 'recurrence_link',
        confirmations: 1,
      },
    ])

    run()
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM knowledge_base').get(),
    ).toEqual({ n: 5 })
  })
})
