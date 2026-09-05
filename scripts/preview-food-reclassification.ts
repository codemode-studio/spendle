/**
 * Prévia somente leitura da reclassificação de comida (plano em
 * plans/reclassificacao-comida-e-kb.md). Copia o banco para uma pasta
 * temporária e imprime o que a migração 0035 mudaria. Não altera nada.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { openDatabase } from '../src/db/connection.server'

/** Padrões LIKE sobre normalized_description, restritos às categorias de origem. */
export const reclassification: Array<{
  to: string
  from: string[]
  patterns: string[]
}> = [
  {
    to: 'groceries',
    from: ['food'],
    patterns: [
      'angeloni%',
      'supermercados imperatr%',
      'festval%',
      'assai atacadista%',
      'koch supermercados%',
      'acougue gimenis%',
    ],
  },
  { to: 'shopping', from: ['food'], patterns: ['mercadolivre*%'] },
  { to: 'delivery', from: ['leisure'], patterns: ['easy food%'] },
  { to: 'leisure', from: ['food'], patterns: ['rede pratique%'] },
  { to: 'personal_care', from: ['food'], patterns: ['lovea express%'] },
  {
    to: 'restaurants',
    from: ['food', 'leisure'],
    patterns: [
      'batel grill%',
      'restaurante kharina%',
      'braz sushi%',
      'nyx bar%',
      'ponto restaurante%',
      'restaurante casagrande%',
      'bier hoff%',
      'nice restaurante%',
      'pauli doces%',
      'la crepioca%',
      'ciadosorvete%',
      'famdpizzaria%',
      'mr cheney%',
      'lindt%',
      'tio zico%',
      'cafe cultura%',
      'nkmb coffee%',
      'o original na brasa%',
      'kontainer beer%',
      'flor de brasa%',
      'oliva cheese%',
      'b2rm bar%',
      'jurere on cafeteria%',
      'noma jurere%',
      'stb*carbone%',
      'alimentare baldovino%',
      'saint claire bakery%',
      'prestinaria%',
      'ivasp comercio%',
      'breadbox%',
      'grife de boteco%',
      'fronteira%hamburg%',
      'r2 bar%',
      'better comercio%',
      'benvenuta bar%',
      'santocrepe%',
      'htm*besties%',
      'brasil berry%',
      'cacau show%',
      'barra beach%',
      'bunker22%',
      'green island%',
      'v a c u n o%',
    ],
  },
]

const databaseUrl = process.env.DATABASE_URL || './data/financas.db'
const source = resolve(process.cwd(), databaseUrl.replace(/^file:/, ''))
const dir = mkdtempSync(join(tmpdir(), 'reclass-preview-'))
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${source}${suffix}`)) {
    copyFileSync(`${source}${suffix}`, join(dir, `financas.db${suffix}`))
  }
}
const connection = openDatabase(join(dir, 'financas.db'))
const sqlite = connection.sqlite

type Row = {
  id: string
  postedAt: string
  description: string
  amountCents: number
  categoryId: string
}
const seen = new Set<string>()
const summary: Record<string, { rows: Row[]; cents: number }> = {}
for (const rule of reclassification) {
  const where = rule.patterns
    .map(() => 'normalized_description like ?')
    .join(' or ')
  const rows = sqlite
    .prepare(
      `select id, posted_at as postedAt, description, amount_cents as amountCents, category_id as categoryId
       from transactions
       where category_id in (${rule.from.map(() => '?').join(',')}) and (${where})
       order by posted_at`,
    )
    .all(...rule.from, ...rule.patterns) as Row[]
  const bucket = (summary[rule.to] ??= { rows: [], cents: 0 })
  for (const row of rows) {
    if (seen.has(row.id)) {
      console.warn(`Lançamento ${row.id} casa com mais de uma regra.`)
      continue
    }
    seen.add(row.id)
    bucket.rows.push(row)
    bucket.cents += Math.abs(row.amountCents)
  }
}

const money = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
for (const [to, bucket] of Object.entries(summary)) {
  console.log(
    `\n== ${to}: ${bucket.rows.length} lançamentos, ${money(bucket.cents)}`,
  )
  const byMerchant = new Map<
    string,
    { n: number; cents: number; from: Set<string> }
  >()
  for (const row of bucket.rows) {
    const key = row.description.replace(/\s+/g, ' ').trim()
    const item = byMerchant.get(key) ?? { n: 0, cents: 0, from: new Set() }
    item.n += 1
    item.cents += Math.abs(row.amountCents)
    item.from.add(row.categoryId)
    byMerchant.set(key, item)
  }
  for (const [name, item] of [...byMerchant].sort(
    (a, b) => b[1].cents - a[1].cents,
  )) {
    console.log(
      `  ${String(item.n).padStart(3)} × ${money(item.cents).padStart(14)}  ${name}  (de ${[...item.from].join('/')})`,
    )
  }
}

const remaining = sqlite
  .prepare(
    `select description, count(*) as n, sum(abs(amount_cents)) as cents
     from transactions where category_id = 'food' and id not in (${[...seen].map(() => '?').join(',') || "''"})
     group by description order by cents desc`,
  )
  .all(...seen) as Array<{ description: string; n: number; cents: number }>
console.log(
  `\n== Continuam em Alimentação (decisão manual): ${remaining.length} descrições`,
)
for (const row of remaining) {
  console.log(
    `  ${String(row.n).padStart(3)} × ${money(row.cents).padStart(14)}  ${row.description}`,
  )
}

const dependents = sqlite
  .prepare(
    `select 'installment_plans' as tbl, count(*) as n from installment_plans where category_id = 'food'
     union all select 'recurrences', count(*) from recurrences where category_id = 'food'
     union all select 'recurrence_occurrences', count(*) from recurrence_occurrences where category_id = 'food'
     union all select 'staged_transactions', count(*) from staged_transactions where suggested_category_id in ('food','leisure')
     union all select 'knowledge_base', count(*) from knowledge_base where category_id in ('food','leisure')`,
  )
  .all()
console.log(
  '\n== Referências dependentes a atualizar:',
  JSON.stringify(dependents),
)

connection.close()
rmSync(dir, { recursive: true, force: true })
