import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { knowledgePattern } from '#/domain/knowledge-pattern'

const migration = readFileSync(
  resolve(process.cwd(), 'drizzle/0037_knowledge_base_prefix_absorption.sql'),
  'utf8',
)

/** Forma da tabela após a 0036, com padrões. */
const schemaAfter0036 = `
  CREATE TABLE categories (id text PRIMARY KEY NOT NULL);
  CREATE TABLE knowledge_base (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    signature text NOT NULL,
    pattern text NOT NULL,
    match_mode text DEFAULT 'exact' NOT NULL,
    direction text NOT NULL,
    category_id text REFERENCES categories(id) ON DELETE CASCADE,
    recurrence_id text,
    sample_description text NOT NULL,
    source text NOT NULL,
    confirmations integer DEFAULT 1 NOT NULL,
    corrections integer DEFAULT 0 NOT NULL,
    last_learned_at integer DEFAULT (unixepoch()) NOT NULL,
    created_at integer DEFAULT (unixepoch()) NOT NULL
  );
  CREATE UNIQUE INDEX knowledge_base_pattern_idx ON knowledge_base (kind, pattern, match_mode, direction);
`

type Row = {
  id: string
  signature: string
  pattern: string
  matchMode?: 'exact' | 'prefix'
  direction?: 'expense' | 'income'
  categoryId: string
  sample: string
  confirmations?: number
  source?: string
}

function insert(sqlite: Database.Database, rows: Row[]) {
  const statement = sqlite.prepare(
    `INSERT INTO knowledge_base (id, kind, signature, pattern, match_mode, direction, category_id, sample_description, source, confirmations)
     VALUES (?, 'category', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const row of rows) {
    statement.run(
      row.id,
      row.signature,
      row.pattern,
      row.matchMode ?? 'exact',
      row.direction ?? 'expense',
      row.categoryId,
      row.sample,
      row.source ?? 'transaction_review',
      row.confirmations ?? 1,
    )
  }
}

describe('migração 0037: prefixos mp e nuv e absorção de entradas cobertas', () => {
  let sqlite: Database.Database | undefined

  afterEach(() => sqlite?.close())

  it('recalcula mp/nuv, cria os prefixos e absorve só a mesma categoria', () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    sqlite.function('knowledge_pattern', { deterministic: true }, (value) =>
      knowledgePattern(String(value ?? '')),
    )
    sqlite.exec(schemaAfter0036)
    sqlite.exec(
      "INSERT INTO categories (id) VALUES ('shopping'), ('family'), ('delivery')",
    )
    insert(sqlite, [
      {
        id: 'prefix-shopee',
        signature: 'shopee',
        pattern: 'shopee',
        matchMode: 'prefix',
        categoryId: 'shopping',
        sample: 'Shopee *',
        source: 'pattern_approval',
      },
      {
        id: 'shopee-a',
        signature: 'shopee abcpapelaria',
        pattern: 'shopee abcpapelaria',
        categoryId: 'shopping',
        sample: 'Shopee *Abcpapelaria',
        confirmations: 2,
      },
      {
        id: 'shopee-b',
        signature: 'shopee lepokpapelaria',
        pattern: 'shopee lepokpapelaria',
        categoryId: 'shopping',
        sample: 'Shopee *Lepokpapelaria',
      },
      {
        id: 'shopee-gift',
        signature: 'shopee presentes',
        pattern: 'shopee presentes',
        categoryId: 'family',
        sample: 'Shopee *Presentes',
      },
      {
        id: 'shopee-income',
        signature: 'shopee reembolso',
        pattern: 'shopee reembolso',
        direction: 'income',
        categoryId: 'shopping',
        sample: 'Shopee *Reembolso',
      },
      {
        id: 'belive',
        signature: 'mp belive parcela 01 de 02',
        pattern: 'belive',
        categoryId: 'shopping',
        sample: 'MP *BELIVE (Parcela 01 de 02)',
      },
      {
        id: 'dayane',
        signature: 'mp dayanemeilipalma',
        pattern: 'dayanemeilipalma',
        categoryId: 'family',
        sample: 'Mp *Dayanemeilipalma',
      },
      {
        id: 'sunflower',
        signature: 'nuv sunflower parcela',
        pattern: 'sunflower',
        categoryId: 'shopping',
        sample: 'Nuv*Sunflower - Parcela 1/2',
      },
      {
        id: 'shopeex',
        signature: 'shopeex loja',
        pattern: 'shopeex loja',
        categoryId: 'shopping',
        sample: 'SHOPEEX LOJA',
      },
    ])

    for (const statement of migration.split('--> statement-breakpoint')) {
      sqlite.exec(statement)
    }

    const rows = sqlite
      .prepare(
        'SELECT id, pattern, match_mode, category_id, confirmations FROM knowledge_base ORDER BY pattern',
      )
      .all() as Array<Record<string, unknown>>
    const byId = Object.fromEntries(rows.map((row) => [row.id as string, row]))

    expect(byId['prefix-shopee']).toMatchObject({ confirmations: 4 })
    expect(byId['shopee-a']).toBeUndefined()
    expect(byId['shopee-b']).toBeUndefined()
    expect(byId['shopee-gift']).toMatchObject({ category_id: 'family' })
    expect(byId['shopee-income']).toMatchObject({ pattern: 'shopee reembolso' })
    expect(byId['shopeex']).toMatchObject({ pattern: 'shopeex loja' })
    expect(byId['belive']).toBeUndefined()
    expect(byId['dayane']).toMatchObject({
      pattern: 'mp dayanemeilipalma',
      category_id: 'family',
    })
    expect(byId['sunflower']).toBeUndefined()

    const prefixes = rows.filter((row) => row.match_mode === 'prefix')
    expect(
      prefixes.map((row) => [row.pattern, row.category_id, row.confirmations]),
    ).toEqual([
      ['mp', 'shopping', 2],
      ['nuv', 'shopping', 2],
      ['shopee', 'shopping', 4],
    ])
  })
})
