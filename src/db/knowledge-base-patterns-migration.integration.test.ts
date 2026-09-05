import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { knowledgePattern } from '#/domain/knowledge-pattern'
import { merchantSignature } from '#/domain/recurrence-book'

const migration = readFileSync(
  resolve(process.cwd(), 'drizzle/0036_knowledge_base_patterns.sql'),
  'utf8',
)

/** Forma da tabela antes da 0036: chave única pela assinatura. */
const legacySchema = `
  CREATE TABLE categories (id text PRIMARY KEY NOT NULL);
  CREATE TABLE recurrences (id text PRIMARY KEY NOT NULL);
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

function openLegacyDatabase() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.function('merchant_signature', { deterministic: true }, (value) =>
    merchantSignature(String(value ?? '')),
  )
  sqlite.function('knowledge_pattern', { deterministic: true }, (value) =>
    knowledgePattern(String(value ?? '')),
  )
  sqlite.exec(legacySchema)
  return sqlite
}

function insertLegacy(
  sqlite: Database.Database,
  rows: Array<{
    id: string
    kind?: 'category' | 'recurrence'
    description: string
    categoryId?: string | null
    recurrenceId?: string | null
    confirmations?: number
    corrections?: number
    learnedAt: number
  }>,
) {
  const statement = sqlite.prepare(
    `INSERT INTO knowledge_base
      (id, kind, signature, direction, category_id, recurrence_id, sample_description, source, confirmations, corrections, last_learned_at)
     VALUES (?, ?, ?, 'expense', ?, ?, ?, 'transaction_review', ?, ?, ?)`,
  )
  for (const row of rows) {
    statement.run(
      row.id,
      row.kind ?? 'category',
      merchantSignature(row.description),
      row.categoryId ?? null,
      row.recurrenceId ?? null,
      row.description,
      row.confirmations ?? 1,
      row.corrections ?? 0,
      row.learnedAt,
    )
  }
}

describe('migração 0036: padrões da base de conhecimento', () => {
  let sqlite: Database.Database | undefined

  afterEach(() => sqlite?.close())

  it('deriva padrões, funde parcelas, preserva divergências e cria os prefixos aprovados', () => {
    sqlite = openLegacyDatabase()
    sqlite.exec(
      "INSERT INTO categories (id) VALUES ('shopping'), ('delivery'), ('health'), ('personal_care'), ('subscriptions'); INSERT INTO recurrences (id) VALUES ('rec-netflix');",
    )
    insertLegacy(sqlite, [
      {
        id: 'ml-1',
        description: 'MERCADOLIVRE*MERCADOL (Parcela 01 de 02)',
        categoryId: 'shopping',
        confirmations: 1,
        learnedAt: 100,
      },
      {
        id: 'ml-2',
        description: 'MERCADOLIVRE*MERCADOL (Parcela 02 de 02)',
        categoryId: 'shopping',
        confirmations: 2,
        corrections: 1,
        learnedAt: 300,
      },
      {
        id: 'ml-3',
        description: 'Mercadolivre*Mercadol',
        categoryId: 'shopping',
        confirmations: 3,
        learnedAt: 200,
      },
      {
        id: 'clinic-1',
        description: 'CLINICA X (Parcela 01 de 03)',
        categoryId: 'health',
        learnedAt: 100,
      },
      {
        id: 'clinic-2',
        description: 'CLINICA X (Parcela 02 de 03)',
        categoryId: 'personal_care',
        learnedAt: 200,
      },
      {
        id: 'nuv',
        description: 'Nuv*Sunflower - Parcela 1/2',
        categoryId: 'shopping',
        learnedAt: 100,
      },
      {
        id: 'rec',
        kind: 'recurrence',
        description: 'PG *NETFLIX.COM 847291',
        recurrenceId: 'rec-netflix',
        learnedAt: 100,
      },
    ])

    for (const statement of migration.split('--> statement-breakpoint')) {
      sqlite.exec(statement)
    }

    const rows = sqlite
      .prepare(
        'SELECT id, kind, pattern, match_mode, category_id, confirmations, corrections, source FROM knowledge_base ORDER BY kind, pattern, id',
      )
      .all() as Array<Record<string, unknown>>
    const byId = Object.fromEntries(rows.map((row) => [row.id as string, row]))

    expect(byId['ml-2']).toMatchObject({
      pattern: 'mercadolivre mercadol',
      match_mode: 'exact',
      confirmations: 6,
      corrections: 1,
    })
    expect(byId['ml-1']).toBeUndefined()
    expect(byId['ml-3']).toBeUndefined()
    expect(byId['clinic-1']).toMatchObject({
      pattern: 'clinica x parcela 01 de 03',
      category_id: 'health',
    })
    expect(byId['clinic-2']).toMatchObject({
      pattern: 'clinica x parcela 02 de 03',
      category_id: 'personal_care',
    })
    expect(byId['nuv']).toMatchObject({ pattern: 'nuv sunflower' })
    expect(byId['rec']).toMatchObject({
      kind: 'recurrence',
      pattern: 'netflix com',
      match_mode: 'exact',
    })

    const prefixes = rows.filter((row) => row.match_mode === 'prefix')
    expect(prefixes.map((row) => [row.pattern, row.category_id])).toEqual([
      ['ifd', 'delivery'],
      ['mercadolivre', 'shopping'],
      ['shopee', 'shopping'],
    ])
    expect(prefixes.every((row) => row.source === 'pattern_approval')).toBe(
      true,
    )

    const indexes = sqlite
      .prepare("PRAGMA index_list('knowledge_base')")
      .all() as Array<{ name: string; unique: number }>
    expect(indexes.map((index) => index.name)).toContain(
      'knowledge_base_pattern_idx',
    )
    expect(indexes.map((index) => index.name)).not.toContain(
      'knowledge_base_key_idx',
    )
  })

  it('não cria prefixos quando a categoria ainda não existe', () => {
    sqlite = openLegacyDatabase()
    for (const statement of migration.split('--> statement-breakpoint')) {
      sqlite.exec(statement)
    }
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM knowledge_base').get(),
    ).toEqual({ n: 0 })
  })
})
