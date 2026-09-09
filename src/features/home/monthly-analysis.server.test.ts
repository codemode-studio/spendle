import { beforeEach, expect, it, vi } from 'vitest'
import { generateMonthlyAnalysis } from './analysis.server'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  snapshot: vi.fn(),
  settings: vi.fn(),
  model: vi.fn(),
}))
vi.mock('ai', () => ({
  generateText: mocks.generate,
  Output: { object: vi.fn() },
}))
vi.mock('#/db/index.server', () => ({
  ensureDatabase: vi.fn(),
  db: { select: () => ({ from: () => ({ limit: mocks.settings }) }) },
}))
vi.mock('#/features/finance/ai.server', () => ({
  getConfiguredAiModel: mocks.model,
}))
vi.mock('#/features/finance/finance-snapshot.server', () => ({
  getFinanceSnapshot: mocks.snapshot,
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.model.mockReturnValue('test-model')
})
it('checks consent before reading or sending family figures', async () => {
  mocks.settings.mockResolvedValue([{ aiClassificationConsent: false }])
  await expect(generateMonthlyAnalysis('2026-08')).rejects.toThrow(
    'Ative o uso de IA',
  )
  expect(mocks.snapshot).not.toHaveBeenCalled()
  expect(mocks.generate).not.toHaveBeenCalled()
})
it('reads the selected month on the server and sends only its aggregate figures', async () => {
  mocks.settings.mockResolvedValue([{ aiClassificationConsent: true }])
  mocks.snapshot.mockResolvedValue({
    dashboard: {
      familyMonth: {
        forecasting: false,
        cashFlow: { cashCents: 7811878, unexplainedChangeCents: 253402 },
        expenses: [],
        knownExpenseCents: 9881490,
        estimatedExpenseCents: 0,
        lines: [{ description: 'private merchant' }],
      },
      budgetTargets: { essential: 3000000 },
      budgetActual: { investment: 3500000, reserve: 0 },
    },
  })
  mocks.generate.mockResolvedValue({
    output: {
      headline: 'Limites ultrapassados',
      summary: 'Confira os gastos do mês.',
    },
  })
  await generateMonthlyAnalysis('2026-07')
  expect(mocks.snapshot).toHaveBeenCalledWith('2026-07')
  const request = mocks.generate.mock.calls[0][0]
  const brief = JSON.parse(request.prompt)
  expect(brief.month).toBe('2026-07')
  expect(brief.cashFlow.unexplainedChangeCents).toBe(253402)
  expect(brief.contributions.investment).toBe(3500000)
  expect(request.prompt).not.toContain('private merchant')
})
