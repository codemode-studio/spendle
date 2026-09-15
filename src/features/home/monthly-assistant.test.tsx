// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Sheet, SheetContent } from '#/components/ui/sheet'
import { MonthlyAssistant } from './monthly-assistant'
import {
  ActivityColumn,
  FinanceAnswerView,
  initialAnalysisRefetchInterval,
} from './home'
import { INITIAL_ANALYSIS_REFRESH_MS } from './assistant-contract'

const report = {
  healthScore: 50,
  healthLabel: 'Atenção',
  findings: [],
  actions: [],
}

const { ask, generate, latest } = vi.hoisted(() => ({
  ask: vi.fn(),
  generate: vi.fn(),
  latest: vi.fn(),
}))
vi.mock('./analysis.functions', () => ({
  askFinanceQuestionFn: ask,
  generateMonthlyAnalysisFn: generate,
  getLatestMonthlyAnalysisFn: latest,
}))
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.resetAllMocks()
})
it('never calls the model when the assistant is disabled', () => {
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MonthlyAssistant month="2026-09" revision="a" configured={false} />
    </QueryClientProvider>,
  )
  expect(screen.getByText(/Ative o assistente/)).toBeTruthy()
  expect(generate).not.toHaveBeenCalled()
  client.clear()
})
it('keeps responses scoped to month and refreshes when its figures change', async () => {
  let finishSeptember!: (value: {
    headline: string
    summary: string
    healthScore: number
    healthLabel: string
    findings: never[]
    actions: never[]
  }) => void
  generate
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSeptember = resolve
        }),
    )
    .mockResolvedValueOnce({
      ...report,
      headline: 'Agosto',
      summary: 'Gastos acima dos limites em agosto.',
    })
    .mockResolvedValueOnce({
      ...report,
      headline: 'Agosto atualizado',
      summary: 'Novos números de agosto.',
    })
  const client = new QueryClient()
  const view = (month: string, revision: string) => (
    <QueryClientProvider client={client}>
      <MonthlyAssistant month={month} revision={revision} configured closed />
    </QueryClientProvider>
  )
  const { rerender } = render(view('2026-09', 'a'))
  await waitFor(() =>
    expect(generate).toHaveBeenCalledWith({ data: { month: '2026-09' } }),
  )
  rerender(view('2026-08', 'a'))
  await screen.findByText('Gastos acima dos limites em agosto.')
  finishSeptember({
    ...report,
    headline: 'Setembro',
    summary: 'Resposta atrasada de setembro.',
  })
  expect(screen.queryByText('Resposta atrasada de setembro.')).toBeNull()
  rerender(view('2026-08', 'b'))
  await screen.findByText('Novos números de agosto.')
  expect(generate).toHaveBeenCalledTimes(3)
  client.clear()
})

it('waits for closing before generating and starts after closing', async () => {
  generate.mockResolvedValue({
    ...report,
    headline: 'Fechamento',
    summary: 'Plano do mês.',
  })
  const client = new QueryClient()
  const view = (closed: boolean) => (
    <QueryClientProvider client={client}>
      <MonthlyAssistant
        month="2026-08"
        revision="same"
        configured
        closed={closed}
      />
    </QueryClientProvider>
  )
  const { rerender } = render(view(false))
  expect(screen.getByText(/A análise será gerada ao fechar/)).toBeTruthy()
  expect(generate).not.toHaveBeenCalled()
  rerender(view(true))
  await screen.findByText('Plano do mês.')
  expect(generate).toHaveBeenCalledTimes(1)
  client.clear()
})

it('renders compact structured answers with real currency values', () => {
  render(
    <FinanceAnswerView
      answer={{
        summary: 'O limite cabe no plano.',
        metrics: [{ label: 'Economia', valueCents: 73240 }],
        comparison: {
          title: 'Restaurantes',
          items: [
            { label: 'Atual', valueCents: 223240 },
            { label: 'Limite', valueCents: 150000 },
          ],
        },
        nextStep: 'Separe R$ 375,00 por semana.',
      }}
    />,
  )
  expect(screen.getByText('O limite cabe no plano.')).toBeTruthy()
  expect(screen.getByText('R$ 732,40')).toBeTruthy()
  expect(screen.getByLabelText('Atual: R$ 2.232,40')).toBeTruthy()
  expect(screen.getByText('Separe R$ 375,00 por semana.')).toBeTruthy()
})

it('submits clarification answers from a questionnaire', () => {
  const onSubmit = vi.fn()
  render(
    <FinanceAnswerView
      answer={{
        summary: 'Preciso entender sua prioridade antes de calcular.',
        metrics: [],
        comparison: null,
        nextStep: null,
        questionnaire: {
          items: [
            {
              question: 'Qual é a prioridade deste mês?',
              description: 'Escolha a opção mais importante.',
              multiple: false,
              required: true,
              choices: [
                { label: 'Reduzir gastos', description: null },
                { label: 'Aumentar a reserva', description: null },
              ],
              allowOther: true,
            },
          ],
        },
      }}
      onQuestionnaireSubmit={onSubmit}
    />,
  )

  fireEvent.click(screen.getByText('Reduzir gastos'))
  fireEvent.click(screen.getByRole('button', { name: 'Responder' }))

  expect(onSubmit).toHaveBeenCalledWith(
    'Qual é a prioridade deste mês?\nReduzir gastos',
  )
})

it('refreshes only the first analysis before a follow-up', () => {
  expect(initialAnalysisRefetchInterval(false, { initial: true })).toBe(
    INITIAL_ANALYSIS_REFRESH_MS,
  )
  expect(initialAnalysisRefetchInterval(true, { initial: true })).toBe(false)
  expect(initialAnalysisRefetchInterval(false, { initial: false })).toBe(false)
})

it('shows user messages as right-aligned bubbles without message labels or avatars', async () => {
  localStorage.setItem(
    'finance-assistant-conversation',
    JSON.stringify([
      { id: 'question-1', kind: 'question', text: 'Quanto posso gastar?' },
      {
        id: 'answer-1',
        kind: 'answer',
        answer: {
          summary: 'Até R$ 500,00 mantém o plano.',
          metrics: [],
          comparison: null,
          nextStep: null,
        },
      },
    ]),
  )
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <Sheet open>
        <SheetContent>
          <ActivityColumn assistantConfigured={false} closedMonths="" />
        </SheetContent>
      </Sheet>
    </QueryClientProvider>,
  )

  const question = await screen.findByText('Quanto posso gastar?')
  expect(question.closest('article')?.className).toContain('justify-end')
  expect(screen.queryByText('Você')).toBeNull()
  expect(screen.getAllByText('Assistente')).toHaveLength(1)
  expect(screen.queryByText('V')).toBeNull()
  expect(screen.getByText('Até R$ 500,00 mantém o plano.')).toBeTruthy()
  client.clear()
})

it('keeps the first-analysis loading state above every conversation', async () => {
  latest.mockImplementation(() => new Promise(() => undefined))
  localStorage.setItem(
    'finance-assistant-conversation',
    JSON.stringify([
      { id: 'question-1', kind: 'question', text: 'Quanto posso gastar?' },
    ]),
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Sheet open>
        <SheetContent>
          <ActivityColumn assistantConfigured closedMonths="" />
        </SheetContent>
      </Sheet>
    </QueryClientProvider>,
  )

  const loading = await screen.findByLabelText('Analisando seus dados')
  const question = screen.getByText('Quanto posso gastar?')
  expect(
    loading.compareDocumentPosition(question) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  client.clear()
})

it('continues the conversation with questionnaire responses', async () => {
  latest.mockImplementation(() => new Promise(() => undefined))
  ask.mockResolvedValue({
    summary: 'Agora consigo calcular o limite.',
    metrics: [],
    comparison: null,
    nextStep: null,
    questionnaire: null,
  })
  localStorage.setItem(
    'finance-assistant-conversation',
    JSON.stringify([
      {
        id: 'answer-clarification',
        kind: 'answer',
        answer: {
          summary: 'Preciso confirmar sua prioridade.',
          metrics: [],
          comparison: null,
          nextStep: null,
          questionnaire: {
            items: [
              {
                question: 'Qual é a prioridade deste mês?',
                description: null,
                multiple: false,
                required: true,
                choices: [
                  { label: 'Reduzir gastos', description: null },
                  { label: 'Aumentar a reserva', description: null },
                ],
                allowOther: false,
              },
            ],
          },
        },
      },
    ]),
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Sheet open>
        <SheetContent>
          <ActivityColumn assistantConfigured closedMonths="" />
        </SheetContent>
      </Sheet>
    </QueryClientProvider>,
  )

  fireEvent.click(await screen.findByText('Reduzir gastos'))
  fireEvent.click(screen.getByRole('button', { name: 'Responder' }))

  await waitFor(() =>
    expect(ask).toHaveBeenCalledWith({
      data: expect.objectContaining({
        question: 'Qual é a prioridade deste mês?\nReduzir gastos',
      }),
    }),
  )
  expect(await screen.findByText('Respostas enviadas')).toBeTruthy()
  client.clear()
})
