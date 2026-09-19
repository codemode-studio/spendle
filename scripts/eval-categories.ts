/**
 * Avaliação das sugestões de categoria por IA.
 *
 * Reproduz decisões humanas congeladas em `evals/categories/dataset.json` por
 * cada configuração e compara o que muda o comportamento do app: acerto entre
 * sugestões confiantes, cobertura e sugestões indevidas em movimentações.
 *
 * O conjunto é anonimizado e versionado, então não depende do consentimento de
 * IA do app. Faz chamadas pagas: não entra em `pnpm verify`.
 *
 *   pnpm eval:categories                  todas as configurações
 *   pnpm eval:categories --only jev       só as que começam com "jev"
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { categorizeTransactionsWithOpenRouter } from '../src/features/finance/ai.server'
import { categorizeTransactionsWithJev } from '../src/features/finance/typesafe.server'
import type {
  AiCategorySuggestion,
  AiCategoryTransaction,
} from '../src/features/finance/ai.server'
import type { JevCategoryAnswers } from '../src/features/finance/typesafe.server'

/** Mesmo corte que o app usa para aplicar sugestões em lote. */
const ACTING_CONFIDENCE = 70
const DIRECTORY = join(import.meta.dirname, '..', 'evals', 'categories')

interface DatasetItem {
  id: string
  description: string
  amountCents: number
  currency: string
  targetType: 'account' | 'card'
  /** `null`: movimentação que não deve receber categoria. */
  expectedCategoryId: string | null
  /** `false`: convenção pessoal ou descrição opaca; contado à parte. */
  guessable: boolean
  origin: 'decision' | 'synthetic' | 'synthetic_movement'
  split: 'context' | 'exam'
}
interface Category {
  id: string
  name: string
  bucket: string
  description: string
}

try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env.local'))
} catch {
  // Sem .env.local, valem as variáveis do ambiente.
}

const { items } = JSON.parse(
  readFileSync(join(DIRECTORY, 'dataset.json'), 'utf8'),
) as { items: DatasetItem[] }
const { categories } = JSON.parse(
  readFileSync(join(DIRECTORY, 'categories.json'), 'utf8'),
) as { categories: Category[] }

const exam = items.filter((item) => item.split === 'exam')
const context = items.filter((item) => item.split === 'context')
const transactions: AiCategoryTransaction[] = exam.map((item) => ({
  id: item.id,
  description: item.description,
  amountCents: item.amountCents,
  currency: item.currency,
  targetType: item.targetType,
}))
const options = categories.map(({ id, name, bucket }) => ({ id, name, bucket }))
const categoryDescriptions = Object.fromEntries(
  categories.map((category) => [category.id, category.description]),
)
const knowledge = context.flatMap((item) =>
  item.expectedCategoryId
    ? [{ description: item.description, categoryId: item.expectedCategoryId }]
    : [],
)

type Judgments = Map<string, JevCategoryAnswers>
interface Configuration {
  name: string
  available: () => boolean
  run: (judgments: Judgments) => Promise<AiCategorySuggestion[]>
}
const jev = Boolean(process.env.AI_GATEWAY_API_KEY)
const record = (judgments: Judgments) => ({
  onJudgment: (id: string, answers: JevCategoryAnswers) =>
    void judgments.set(id, answers),
})
const configurations: Configuration[] = [
  {
    name: 'openrouter',
    available: () =>
      Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL),
    run: () => categorizeTransactionsWithOpenRouter(transactions, options),
  },
  {
    name: 'jev',
    available: () => jev,
    run: (judgments) =>
      categorizeTransactionsWithJev(transactions, options, record(judgments)),
  },
  {
    name: 'jev+descriptions',
    available: () => jev,
    run: (judgments) =>
      categorizeTransactionsWithJev(transactions, options, {
        categoryDescriptions,
        ...record(judgments),
      }),
  },
  {
    name: 'jev+descriptions+context',
    available: () => jev,
    run: (judgments) =>
      categorizeTransactionsWithJev(transactions, options, {
        categoryDescriptions,
        knowledge,
        ...record(judgments),
      }),
  },
]

const percent = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : null

function score(subset: DatasetItem[], byId: Map<string, AiCategorySuggestion>) {
  const confident = subset.filter(
    (item) => (byId.get(item.id)?.confidence ?? 0) >= ACTING_CONFIDENCE,
  )
  const correct = (item: DatasetItem) =>
    byId.get(item.id)?.categoryId === item.expectedCategoryId
  return {
    items: subset.length,
    /** Entre sugestões confiantes, quantas coincidem com a decisão humana. */
    accuracyWhenConfident: percent(
      confident.filter(correct).length,
      confident.length,
    ),
    /** Quantos lançamentos receberam uma sugestão confiante. */
    coverage: percent(confident.length, subset.length),
    /** Lançamentos resolvidos corretamente sem revisão: o ganho real. */
    correctAndConfident: percent(
      confident.filter(correct).length,
      subset.length,
    ),
    /** Acerto ignorando a confiança. */
    accuracyAnyConfidence: percent(
      subset.filter(correct).length,
      subset.length,
    ),
  }
}

function calibration(
  subset: DatasetItem[],
  byId: Map<string, AiCategorySuggestion>,
) {
  return [
    [0, 50],
    [50, 70],
    [70, 90],
    [90, 101],
  ].map(([from, to]) => {
    const bucket = subset.filter((item) => {
      const confidence = byId.get(item.id)?.confidence
      return confidence !== undefined && confidence >= from && confidence < to
    })
    return {
      confidence: `${from}-${Math.min(to, 100)}`,
      suggestions: bucket.length,
      accuracy: percent(
        bucket.filter(
          (item) => byId.get(item.id)?.categoryId === item.expectedCategoryId,
        ).length,
        bucket.length,
      ),
    }
  })
}

const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex > 0 ? process.argv[onlyIndex + 1] : null
const categoryName = new Map(categories.map((c) => [c.id, c.name]))
const purchases = exam.filter((item) => item.expectedCategoryId !== null)
const movements = exam.filter((item) => item.expectedCategoryId === null)
const results = []

for (const configuration of configurations) {
  if (only && !configuration.name.startsWith(only)) continue
  if (!configuration.available()) {
    console.log(`\n${configuration.name}: ignorada, credenciais ausentes.`)
    continue
  }
  const judgments: Judgments = new Map()
  const start = performance.now()
  const suggestions = await configuration.run(judgments)
  const seconds = Math.round((performance.now() - start) / 100) / 10
  const byId = new Map(suggestions.map((s) => [s.transactionId, s]))
  const indevidas = movements.filter(
    (item) => (byId.get(item.id)?.confidence ?? 0) >= ACTING_CONFIDENCE,
  )
  const result = {
    configuration: configuration.name,
    seconds,
    guessable: score(
      purchases.filter((item) => item.guessable),
      byId,
    ),
    personalConvention: score(
      purchases.filter((item) => !item.guessable),
      byId,
    ),
    allPurchases: score(purchases, byId),
    movementsWronglyCategorized: `${indevidas.length}/${movements.length}`,
    calibration: calibration(purchases, byId),
    misses: purchases
      .filter((item) => {
        const suggestion = byId.get(item.id)
        return (
          suggestion &&
          suggestion.confidence >= ACTING_CONFIDENCE &&
          suggestion.categoryId !== item.expectedCategoryId
        )
      })
      .map((item) => ({
        id: item.id,
        description: item.description,
        expected: item.expectedCategoryId,
        suggested: byId.get(item.id)?.categoryId,
        confidence: byId.get(item.id)?.confidence,
        guessable: item.guessable,
      })),
    /** Compras que o Jev descartou por parecerem movimentação. */
    purchasesDroppedAsMovement: purchases
      .filter(
        (item) => (judgments.get(item.id)?.movement.probability ?? 0) >= 0.5,
      )
      .map((item) => ({
        id: item.id,
        description: item.description,
        expected: item.expectedCategoryId,
        wouldHaveChosen: judgments.get(item.id)?.category.choice,
      })),
  }
  results.push(result)

  console.log(`\n=== ${configuration.name} (${seconds}s) ===`)
  console.table({
    adivinháveis: result.guessable,
    'convenção pessoal': result.personalConvention,
    'todas as compras': result.allPurchases,
  })
  console.log(
    `movimentações com categoria indevida: ${result.movementsWronglyCategorized}`,
  )
  console.table(result.calibration)
  if (result.purchasesDroppedAsMovement.length)
    console.log(
      `compras descartadas como movimentação: ${result.purchasesDroppedAsMovement.length}`,
    )
  for (const miss of result.misses.filter((m) => m.guessable).slice(0, 12))
    console.log(
      `  erro ${miss.id} ${miss.description} | esperado ${categoryName.get(miss.expected ?? '')} | sugerido ${categoryName.get(miss.suggested ?? '')} (${miss.confidence})`,
    )
}

if (results.length) {
  const directory = join(DIRECTORY, 'results')
  mkdirSync(directory, { recursive: true })
  const file = join(
    directory,
    `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  writeFileSync(
    file,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        openRouterModel: process.env.OPENROUTER_MODEL ?? null,
        examItems: exam.length,
        contextItems: context.length,
        actingConfidence: ACTING_CONFIDENCE,
        results,
      },
      null,
      2,
    ),
  )
  console.log(`\nResultados completos: ${file}`)
}
