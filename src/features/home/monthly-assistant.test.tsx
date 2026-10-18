// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vite-plus/test'
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

// Node keeps a `localStorage` global that stays undefined unless the process is
// started with --localstorage-file, and it shadows the Storage jsdom installs.
vi.hoisted(() => {
  // Typed as optional because the DOM lib declares it as always present.
  if ((globalThis as { localStorage?: Storage }).localStorage) return
  const entries = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return entries.size
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, String(value))
      },
      removeItem: (key: string) => {
        entries.delete(key)
      },
      clear: () => {
        entries.clear()
      },
    } satisfies Storage,
  })
})

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
vi.mock('#/features/data/planning.functions', () => ({
  askAssistantFn: ask,
  monthlyAnalysisFn: generate,
  latestAnalysisFn: latest,
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
  expect(screen.getByText(/Assistente desligado/)).toBeTruthy()
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
        questionnaire: null,
      }}
    />,
  )
  expect(screen.getByText('O limite cabe no plano.')).toBeTruthy()
  expect(screen.getByText('R$ 732,40')).toBeTruthy()
  expect(screen.getByLabelText('Atual: R$ 2.232,40')).toBeTruthy()
  expect(screen.getByText('Separe R$ 375,00 por semana.')).toBeTruthy()
})

it('renders negative projections with a valid comparison scale', () => {
  render(
    <FinanceAnswerView
      answer={{
        summary: 'O saldo ficaria negativo em três meses.',
        metrics: [{ label: 'Saldo projetado', valueCents: -1350000 }],
        comparison: {
          title: 'Projeção de saldo',
          items: [
            { label: 'Hoje', valueCents: 250000 },
            { label: 'Em 3 meses', valueCents: -1350000 },
          ],
        },
        nextStep: null,
        questionnaire: null,
      }}
    />,
  )

  expect(screen.getAllByText('-R$ 13.500,00')).toHaveLength(2)
  expect(
    screen
      .getByLabelText('Em 3 meses: -R$ 13.500,00')
      .getAttribute('aria-valuenow'),
  ).toBe('100')
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

it('shows a failed answer in the conversation and retries without duplicating the question', async () => {
  latest.mockImplementation(() => new Promise(() => undefined))
  ask
    .mockRejectedValueOnce(new Error('Resposta inválida'))
    .mockResolvedValueOnce({
      summary: 'Em três meses, o déficit acumulado exigiria um ajuste.',
      metrics: [],
      comparison: null,
      nextStep: null,
      questionnaire: null,
    })
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

  const question =
    'Considerando que nada mude, em 3 meses como ficaria nossa saude financeira?'
  fireEvent.change(
    await screen.findByLabelText('Pergunte sobre suas finanças'),
    {
      target: { value: question },
    },
  )
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pergunta' }))

  expect(
    await screen.findByText('Não consegui preparar essa resposta.'),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))

  expect(
    await screen.findByText(
      'Em três meses, o déficit acumulado exigiria um ajuste.',
    ),
  ).toBeTruthy()
  expect(screen.getAllByText(question)).toHaveLength(1)
  expect(ask).toHaveBeenCalledTimes(2)
  client.clear()
})
