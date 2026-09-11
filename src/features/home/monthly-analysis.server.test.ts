import { afterEach, expect, it, vi } from 'vitest'
import { openTestDatabase } from '#/test/database'
import { generateMonthlyAnalysis } from './analysis.server'

const mocks = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('ai', () => ({
  generateText: mocks.generate,
  Output: { object: vi.fn() },
}))
vi.mock('#/features/finance/ai.server', () => ({
  getConfiguredAiModel: () => 'test-model',
}))
let database: Awaited<ReturnType<typeof openTestDatabase>>
afterEach(() => {
  database.close()
  vi.clearAllMocks()
})
it('does not generate an automatic report for an open month', async () => {
  database = await openTestDatabase()
  await database.db
    .update(database.schema.appSettings)
    .set({ aiClassificationConsent: true })
  await expect(generateMonthlyAnalysis('2026-08')).resolves.toBeNull()
  expect(mocks.generate).not.toHaveBeenCalled()
})

async function setupClosedMonth() {
  database = await openTestDatabase()
  const { db, schema } = database
  await db.update(schema.appSettings).set({ aiClassificationConsent: true })
  await db.insert(schema.monthlyBudgets).values({
    id: 'closed',
    month: '2026-08',
    strategyId: 'test-strategy-balanced',
    baseIncomeCents: 100000,
    eligibleIncomeCents: 100000,
    essentialBps: 4000,
    lifestyleBps: 2000,
    investmentBps: 3000,
    reserveBps: 1000,
    effectiveInvestmentBps: 3000,
    effectiveReserveBps: 1000,
    closed: true,
  })
}
const report = {
  headline: 'Plano para setembro',
  summary: 'Preserve os essenciais.',
  healthScore: 50,
  healthLabel: 'Atenção',
  findings: [],
  actions: [],
}
it('uses human knowledge and essential buckets, saves once and leaves knowledge unchanged', async () => {
  await setupClosedMonth()
  const { db, schema, ids } = database
  await db.insert(schema.knowledgeBase).values({
    id: 'school',
    kind: 'category',
    signature: 'positivo e ltda',
    pattern: 'positivo e ltda',
    direction: 'expense',
    categoryId: ids.categories.family,
    sampleDescription: 'Positivo E Ltda',
    source: 'transaction_review',
  })
  const before = await db.select().from(schema.knowledgeBase)
  mocks.generate.mockResolvedValue({ output: report })
  const [first, second] = await Promise.all([
    generateMonthlyAnalysis('2026-08'),
    generateMonthlyAnalysis('2026-08'),
  ])
  expect(first).toEqual(report)
  expect(second).toEqual(report)
  expect(await generateMonthlyAnalysis('2026-08')).toEqual(report)
  expect(mocks.generate).toHaveBeenCalledTimes(1)
  const request = mocks.generate.mock.calls[0][0]
  const { briefing } = JSON.parse(request.prompt)
  expect(briefing.month).toBe('2026-08')
  expect(briefing.unit).toBe('centavos de BRL')
  expect(briefing.knowledge).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        description: 'Positivo E Ltda',
        bucket: 'essential',
        source: 'decisão humana',
      }),
    ]),
  )
  expect(request.system).toContain('Preserve despesas essenciais como escola')
  expect(await db.select().from(schema.knowledgeBase)).toEqual(before)
})
it('does not send data without consent, including saved reports', async () => {
  await setupClosedMonth()
  await database.db
    .update(database.schema.appSettings)
    .set({ aiClassificationConsent: false })
  await expect(generateMonthlyAnalysis('2026-08')).rejects.toThrow(
    'Ative o uso de IA',
  )
  expect(mocks.generate).not.toHaveBeenCalled()
})
it('allows retry after provider failure without storing a broken report', async () => {
  await setupClosedMonth()
  mocks.generate
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ output: report })
  await expect(generateMonthlyAnalysis('2026-08')).rejects.toThrow('offline')
  expect(
    await database.db.select().from(database.schema.monthlyReports),
  ).toEqual([])
  await expect(generateMonthlyAnalysis('2026-08')).resolves.toEqual(report)
})
it('continues the conversation with its history, current knowledge and saved monthly plan', async () => {
  await setupClosedMonth()
  await database.db
    .insert(database.schema.monthlyReports)
    .values({ month: '2026-08', report: JSON.stringify(report) })
  mocks.generate.mockResolvedValue({ text: 'Reserve o limite proposto.' })
  const { answerFinanceQuestion } = await import('./analysis.server')
  const history = [
    { role: 'user' as const, content: 'Quero reduzir delivery.' },
    { role: 'assistant' as const, content: 'Qual limite pretende adotar?' },
  ]
  await answerFinanceQuestion('E se for 300 reais?', history)
  const request = mocks.generate.mock.calls[0][0]
  expect(request.messages.slice(1)).toEqual([
    ...history,
    { role: 'user', content: 'E se for 300 reais?' },
  ])
  expect(JSON.parse(request.messages[0].content).lastMonthlyReport).toEqual({
    month: '2026-08',
    report,
  })
})

it('calculates savings from recorded cents and rejects duplicate or unsupported category limits', async () => {
  await setupClosedMonth()
  const { db, schema, ids } = database
  await db.insert(schema.transactions).values({
    id: 'groceries',
    accountId: ids.brlAccount,
    categoryId: ids.categories.groceries,
    postedAt: '2026-08-20',
    description: 'Mercado',
    normalizedDescription: 'mercado',
    amountCents: -449575,
    currency: 'BRL',
    status: 'confirmed',
    fingerprint: 'groceries',
  })
  const action = {
    title: 'Planejar supermercado',
    detail: 'Defina o teto para setembro.',
    categoryId: ids.categories.groceries,
    proposedLimitCents: 249575,
  }
  mocks.generate.mockResolvedValueOnce({
    output: { ...report, actions: [action, action] },
  })
  await expect(generateMonthlyAnalysis('2026-08')).rejects.toThrow(
    'limite sem base',
  )
  mocks.generate.mockResolvedValueOnce({
    output: { ...report, actions: [{ ...action, proposedLimitCents: 449576 }] },
  })
  await expect(generateMonthlyAnalysis('2026-08')).rejects.toThrow(
    'limite sem base',
  )
  mocks.generate.mockResolvedValueOnce({
    output: { ...report, actions: [action] },
  })
  const result = await generateMonthlyAnalysis('2026-08')
  expect(result?.actions[0]).toMatchObject({
    baselineCents: 449575,
    proposedLimitCents: 249575,
    estimatedMonthlySavingsReais: 2000,
  })
})

it('automatically creates the report when closing and keeps the budget closed if AI fails', async () => {
  database = await openTestDatabase()
  await database.db
    .update(database.schema.appSettings)
    .set({ aiClassificationConsent: true })
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-test-key')
  vi.stubEnv('OPENROUTER_MODEL', 'synthetic-test-model')
  try {
    mocks.generate.mockRejectedValueOnce(new Error('provider offline'))
    const { closeCurrentBudget } =
      await import('#/features/finance/planning.server')
    const result = await closeCurrentBudget()
    expect(result).toMatchObject({ alreadyClosed: false, analysisError: true })
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(
      (await database.db.select().from(database.schema.monthlyBudgets))[0]
        .closed,
    ).toBe(true)
    mocks.generate.mockResolvedValueOnce({ output: report })
    await expect(generateMonthlyAnalysis(result.month)).resolves.toEqual(report)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('creates and persists the first analysis without closing a budget, then prefers the monthly closing', async () => {
  database = await openTestDatabase()
  await database.db
    .update(database.schema.appSettings)
    .set({ aiClassificationConsent: true })
  mocks.generate.mockResolvedValue({ output: report })
  const { getLatestMonthlyAnalysis } = await import('./analysis.server')
  const [first, simultaneous] = await Promise.all([
    getLatestMonthlyAnalysis(),
    getLatestMonthlyAnalysis(),
  ])
  expect(first).toMatchObject({ initial: true, analysis: report })
  expect(simultaneous).toEqual(first)
  expect(await getLatestMonthlyAnalysis()).toEqual(first)
  expect(mocks.generate).toHaveBeenCalledTimes(1)
  expect(JSON.parse(mocks.generate.mock.calls[0][0].prompt).task).toContain(
    'antes de qualquer fechamento',
  )
  expect(
    await database.db.select().from(database.schema.monthlyBudgets),
  ).toEqual([])
  expect(
    await database.db.select().from(database.schema.monthlyReports),
  ).toEqual([])
  await database.db
    .insert(database.schema.monthlyBudgets)
    .values({
      id: 'closed',
      month: '2026-08',
      strategyId: 'test-strategy-balanced',
      baseIncomeCents: 100000,
      eligibleIncomeCents: 100000,
      essentialBps: 4000,
      lifestyleBps: 2000,
      investmentBps: 3000,
      reserveBps: 1000,
      effectiveInvestmentBps: 3000,
      effectiveReserveBps: 1000,
      closed: true,
    })
  expect(await getLatestMonthlyAnalysis()).toMatchObject({
    initial: false,
    month: '2026-08',
  })
  expect(mocks.generate).toHaveBeenCalledTimes(2)
})
it('does not create the first analysis without consent and retries provider failures', async () => {
  database = await openTestDatabase()
  const { getLatestMonthlyAnalysis } = await import('./analysis.server')
  await expect(getLatestMonthlyAnalysis()).rejects.toThrow('Ative o uso de IA')
  expect(mocks.generate).not.toHaveBeenCalled()
  await database.db
    .update(database.schema.appSettings)
    .set({ aiClassificationConsent: true })
  mocks.generate
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ output: report })
  await expect(getLatestMonthlyAnalysis()).rejects.toThrow('offline')
  expect(
    await database.db.select().from(database.schema.initialAnalysis),
  ).toEqual([])
  await expect(getLatestMonthlyAnalysis()).resolves.toMatchObject({
    initial: true,
    analysis: report,
  })
})
