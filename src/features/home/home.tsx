import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  ArrowLeft,
  ChartNoAxesCombined,
  ChartPie,
  CalendarDays,
  CreditCard,
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
  Send,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import { EmptyState, Page, Panel } from '#/components/ui'
import { Button, buttonVariants } from '#/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from '#/components/ui/input-group'
import { Progress } from '#/components/ui/progress'
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '#/components/ui/questionnaire'
import { Separator } from '#/components/ui/separator'
import { Spinner } from '#/components/ui/spinner'
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '#/components/ui/sheet'
import { MonthlyOverview } from './monthly-overview'
import { ReviewCard } from './review-card'
import { pendingReviewItems } from './review'
import type {
  CashProjection as ProjectionFromApi,
  FinanceAnswer,
  MonthView,
} from '@spendle/server/api'

import { formatCurrency } from '#/domain/currency'
import type { FamilyTransaction } from '#/domain/ledger'
import {
  askAssistantFn,
  latestAnalysisFn,
} from '#/features/v2/planning.functions'
import { cn } from '#/lib/utils'
import {
  INITIAL_ANALYSIS_REFRESH_MS,
  persistedFinanceAnswerSchema,
} from './assistant-contract'
import { AnalysisCard } from './analysis-card'
import { CategoryBar } from './charts'
import { ForecastOutlook } from './forecast-outlook'
import { buildHomeView } from './insights'
import type { HomeView } from './insights'
import { trimCashProjection } from './cash-projection'
import type { CashEvent } from './cash-projection'
import { assistantQueryKeys } from './query-keys'

type ConversationMessage = { role: 'user' | 'assistant'; content: string }
type FinanceQuestionnaire = NonNullable<FinanceAnswer['questionnaire']>

/** What the overview reads, all from V2. */
export interface HomeData {
  month: MonthView
  forecast: ProjectionFromApi
  /** The family's entries as the category analysis reads them. */
  ledger: ReadonlyArray<FamilyTransaction>
  hasAccounts: boolean
  /** Closed months, comma-separated, so a closing refreshes the assistant. */
  closedMonths: string
  assistantConfigured: boolean
}

// ─── Página ──────────────────────────────────────────────────────────────────

export function Home({ data }: { data: HomeData }) {
  const { month, assistantConfigured } = data
  const [showAnalysis, setShowAnalysis] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const view = useMemo(
    () => buildHomeView(data.ledger, month.integrity),
    [data.ledger, month.integrity],
  )
  const commitments = useMemo(
    () => trimCashProjection(data.forecast, 30).scheduled,
    [data.forecast],
  )

  return (
    <Page className="home-page max-w-[1120px]">
      <CashHeader cash={month.cashFlow.cashCents} analysis={showAnalysis}>
        <Button
          variant="outline"
          aria-label={showAnalysis ? 'Voltar à visão geral' : 'Previsão'}
          title={showAnalysis ? 'Voltar à visão geral' : 'Previsão'}
          className="max-sm:size-11 max-sm:p-0"
          onClick={() => setShowAnalysis(!showAnalysis)}
        >
          {showAnalysis ? <ArrowLeft /> : <ChartNoAxesCombined />}
          <span className="hidden sm:inline">
            {showAnalysis ? 'Voltar' : 'Previsão'}
          </span>
        </Button>
        <Sheet open={assistantOpen} onOpenChange={setAssistantOpen}>
          <SheetTrigger
            render={
              <Button
                variant="outline"
                aria-label="Assistente"
                title="Assistente"
                className="max-sm:size-11 max-sm:p-0"
              />
            }
          >
            <Sparkles /> <span className="hidden sm:inline">Assistente</span>
          </SheetTrigger>
          <SheetContent
            keepMounted
            className="min-h-0 overflow-hidden data-[side=right]:h-dvh data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
          >
            <ActivityColumn
              open={assistantOpen}
              closedMonths={data.closedMonths}
              assistantConfigured={assistantConfigured}
            />
          </SheetContent>
        </Sheet>
      </CashHeader>
      {!data.hasAccounts ? (
        <EmptyState
          icon={Landmark}
          title="Comece pela sua primeira conta"
          description="Adicione a conta que deseja acompanhar."
          action={
            <Button
              nativeButton={false}
              render={<Link to="/configuracoes" search={{ tab: 'contas' }} />}
            >
              Cadastrar conta <ArrowRight />
            </Button>
          }
        />
      ) : showAnalysis ? (
        <div className="flex flex-col gap-6">
          <ForecastOutlook forecast={data.forecast} month={month} view={view} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <ReviewCard
            items={pendingReviewItems(month.integrity.issues, month.month)}
          />
          <MonthlyOverview
            current={month}
            assistantConfigured={assistantConfigured}
          />
          <div className="grid items-stretch gap-6 md:grid-cols-2">
            <CategorySummaryCard view={view} />
            <CommitmentsCard commitments={commitments} />
          </div>
        </div>
      )}
    </Page>
  )
}

// ─── Cabeçalho ───────────────────────────────────────────────────────────────

function CashHeader({
  cash,
  children,
  analysis,
}: {
  cash: number | null
  children: React.ReactNode
  analysis: boolean
}) {
  return (
    <header className="cash-hero mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">
          {analysis ? 'Visão geral' : 'Caixa atual'}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight tabular-nums md:text-[2rem]">
          {analysis
            ? 'Previsão'
            : cash == null
              ? 'Sem saldo registrado'
              : formatCurrency(cash)}
        </h1>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
        {children}
      </div>
    </header>
  )
}

const summaryCardClass =
  '[&_[data-slot=card-content]]:flex [&_[data-slot=card-content]]:flex-1 [&_[data-slot=card-content]]:flex-col [&_[data-slot=card-content]]:gap-5 [&_[data-slot=card-header]]:grid-cols-[1fr_auto] [&_[data-slot=card-header]]:grid-rows-1 [&_[data-slot=card-action]]:col-start-2 [&_[data-slot=card-action]]:row-start-1 [&_[data-slot=card-action]]:mt-0'

function CategorySummaryCard({ view }: { view: HomeView }) {
  const breakdown = view.categories30
  return (
    <Panel
      title="Gastos por categoria"
      className={summaryCardClass}
      action={
        <ChartPie aria-hidden="true" className="size-5 text-muted-foreground" />
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {formatCurrency(breakdown.totalCents)}
        </p>
        <span className="text-xs text-muted-foreground">30 dias</span>
      </div>
      {breakdown.items.length > 0 ? (
        <>
          <CategoryBar items={breakdown.items} />
          <ul className="divide-y">
            {breakdown.items.slice(0, 5).map((item) => (
              <li
                key={item.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 first:pt-0"
              >
                <span
                  aria-hidden="true"
                  className="flex size-9 items-center justify-center rounded-xl"
                  style={{ background: `${item.color}1f` }}
                >
                  <span
                    className="size-2.5 rounded-full"
                    style={{ background: item.color }}
                  />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={item.name}>
                    {item.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {Math.round(item.share * 100)}%
                  </p>
                </div>
                <span className="whitespace-nowrap text-sm font-semibold tabular-nums">
                  {formatCurrency(item.cents)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-muted-foreground">
          <ChartPie
            aria-hidden="true"
            className="size-10 text-muted-foreground/40"
            strokeWidth={1.25}
          />
          <p className="text-sm">Nenhum gasto classificado.</p>
        </div>
      )}
      {view.last30.uncategorizedCents > 0 && (
        <div className="flex flex-wrap justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
          <span>Sem categoria</span>
          <span className="tabular-nums">
            {formatCurrency(view.last30.uncategorizedCents)}
          </span>
        </div>
      )}
      <Link
        to="/categorias"
        className={buttonVariants({
          variant: 'ghost',
          size: 'default',
          className: 'mt-auto w-full',
        })}
      >
        Ver categorias <ArrowRight data-icon="inline-end" />
      </Link>
    </Panel>
  )
}

function CommitmentsCard({
  commitments,
}: {
  commitments: ReadonlyArray<CashEvent>
}) {
  const due = commitments.filter((item) => item.amountCents < 0)
  const dueCents = due.reduce((sum, item) => sum + -item.amountCents, 0)
  return (
    <Panel
      title="Próximos 30 dias"
      className={summaryCardClass}
      action={
        <CalendarDays
          aria-hidden="true"
          className="size-5 text-muted-foreground"
        />
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {formatCurrency(dueCents)}
        </p>
        <span className="text-xs text-muted-foreground">a pagar</span>
      </div>
      {commitments.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-muted-foreground">
          <CalendarDays
            aria-hidden="true"
            className="size-10 text-muted-foreground/40"
            strokeWidth={1.25}
          />
          <p className="text-sm">Nenhum vencimento previsto.</p>
        </div>
      ) : (
        <ul className="divide-y">
          {commitments.slice(0, 5).map((item) => {
            const incoming = item.amountCents > 0
            const Icon = incoming
              ? ArrowDownLeft
              : item.kind === 'statement'
                ? CreditCard
                : ArrowUpRight
            const date = new Date(`${item.date}T12:00:00`)
            const month = new Intl.DateTimeFormat('pt-BR', { month: 'short' })
              .format(date)
              .replace('.', '')
            return (
              <li
                key={item.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 first:pt-0"
              >
                <time
                  dateTime={item.date}
                  className="flex size-10 shrink-0 flex-col items-center justify-center rounded-xl bg-muted text-foreground"
                >
                  <span className="text-sm leading-none font-semibold tabular-nums">
                    {date.getDate()}
                  </span>
                  <span className="mt-0.5 text-[10px] leading-none text-muted-foreground">
                    {month}
                  </span>
                </time>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={item.name}>
                    {item.name}
                  </p>
                  <p
                    className={cn(
                      'mt-1 flex items-center gap-1 text-xs',
                      incoming ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-3" />
                    {incoming
                      ? 'A receber'
                      : item.kind === 'statement'
                        ? 'Fatura'
                        : 'A pagar'}
                  </p>
                </div>
                <span
                  className={cn(
                    'whitespace-nowrap text-sm font-semibold tabular-nums',
                    incoming && 'text-success',
                  )}
                >
                  {incoming ? '+' : ''}
                  {formatCurrency(Math.abs(item.amountCents))}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <Link
        to="/configuracoes"
        search={{ tab: 'recorrencias' }}
        className={buttonVariants({
          variant: 'ghost',
          size: 'default',
          className: 'mt-auto w-full',
        })}
      >
        Ver recorrências <ArrowRight data-icon="inline-end" />
      </Link>
    </Panel>
  )
}

// ─── Coluna de atividade (assistente) ────────────────────────────────────────

type FeedItem =
  | { id: string; kind: 'question'; text: string }
  | {
      id: string
      kind: 'answer'
      answer: FinanceAnswer
      questionnaireResponse?: string
    }

export function ActivityColumn({
  open = true,
  assistantConfigured,
  closedMonths,
}: {
  open?: boolean
  closedMonths: string
  assistantConfigured: boolean
}) {
  const [conversation, setConversation] = useState<Array<FeedItem>>([])
  const [conversationLoaded, setConversationLoaded] = useState(false)
  const [question, setQuestion] = useState('')
  const conversationRegionRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const shouldFollowConversationRef = useRef(true)
  const wasOpenRef = useRef(false)

  const persistConversation = (items: FeedItem[]) => {
    try {
      localStorage.setItem(
        'finance-assistant-conversation',
        JSON.stringify(items),
      )
    } catch {
      /* Armazenamento indisponível. */
    }
  }
  const push = (item: FeedItem) =>
    setConversation((current) => {
      const next = [...current, item].slice(-20)
      persistConversation(next)
      return next
    })

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem('finance-assistant-conversation') ?? '[]',
      )
      if (Array.isArray(saved)) {
        const restored = saved.flatMap((item): FeedItem[] => {
          if (!item || typeof item !== 'object') return []
          const candidate = item as Record<string, unknown>
          if (typeof candidate.id !== 'string') return []
          if (
            candidate.kind === 'question' &&
            typeof candidate.text === 'string'
          )
            return [
              { id: candidate.id, kind: 'question', text: candidate.text },
            ]
          if (candidate.kind !== 'answer') return []
          const parsed = persistedFinanceAnswerSchema.safeParse(
            candidate.answer,
          )
          if (parsed.success)
            return [
              {
                id: candidate.id,
                kind: 'answer',
                answer: parsed.data,
                questionnaireResponse:
                  typeof candidate.questionnaireResponse === 'string'
                    ? candidate.questionnaireResponse
                    : undefined,
              },
            ]
          if (typeof candidate.text === 'string')
            return [
              {
                id: candidate.id,
                kind: 'answer',
                answer: {
                  summary: candidate.text.replace(/\*\*/g, ''),
                  metrics: [],
                  comparison: null,
                  nextStep: null,
                  questionnaire: null,
                },
              },
            ]
          return []
        })
        setConversation(restored.slice(-20))
      }
    } catch {
      /* Conversa indisponível neste navegador. */
    } finally {
      setConversationLoaded(true)
    }
  }, [])
  const hasFollowUp = conversation.some((item) => item.kind === 'question')
  const analysis = useQuery({
    queryKey: assistantQueryKeys.latestAnalysis(closedMonths),
    queryFn: () => latestAnalysisFn({ data: { refreshInitial: true } }),
    enabled: assistantConfigured && conversationLoaded,
    staleTime: INITIAL_ANALYSIS_REFRESH_MS,
    retry: 1,
    retryDelay: 1500,
    refetchInterval: (query) =>
      initialAnalysisRefetchInterval(hasFollowUp, query.state.data),
    refetchIntervalInBackground: false,
  })

  const ask = useMutation({
    mutationFn: (data: { question: string; history: ConversationMessage[] }) =>
      askAssistantFn({ data }),
    onSuccess: (answer) =>
      push({ id: `answer-${Date.now()}`, kind: 'answer', answer }),
    onError: (error) => toast.error(error.message),
    onSettled: () => {
      submittingRef.current = false
    },
  })

  const historyFrom = (items: FeedItem[]): ConversationMessage[] =>
    items
      .map((item): ConversationMessage => ({
        role: item.kind === 'question' ? 'user' : 'assistant',
        content:
          item.kind === 'question' ? item.text : answerAsHistory(item.answer),
      }))
      .slice(-20)

  const askQuestion = (text: string) => {
    if (
      !assistantConfigured ||
      text.length < 3 ||
      ask.isPending ||
      submittingRef.current
    )
      return
    submittingRef.current = true
    shouldFollowConversationRef.current = true
    push({ id: `question-${Date.now()}`, kind: 'question', text })
    setQuestion('')
    ask.mutate({
      question: text,
      history: historyFrom(conversation),
    })
  }

  const submitQuestion = (event: React.FormEvent) => {
    event.preventDefault()
    askQuestion(question.trim())
  }

  const retryQuestion = () => {
    if (
      !assistantConfigured ||
      ask.isPending ||
      submittingRef.current ||
      !ask.variables
    )
      return
    submittingRef.current = true
    ask.mutate(ask.variables)
  }

  const submitQuestionnaire = (answerId: string, response: string) => {
    if (!assistantConfigured || ask.isPending || submittingRef.current) return
    setConversation((current) => {
      const next = current.map((item) =>
        item.id === answerId && item.kind === 'answer'
          ? { ...item, questionnaireResponse: response }
          : item,
      )
      persistConversation(next)
      return next
    })
    askQuestion(response)
  }

  const hasAnalysisArea =
    Boolean(analysis.data?.analysis) ||
    analysis.isFetching ||
    analysis.isError ||
    (!assistantConfigured && !closedMonths)
  const pendingQuestionnaireId = [...conversation]
    .reverse()
    .find(
      (item) =>
        item.kind === 'answer' &&
        item.answer.questionnaire &&
        !item.questionnaireResponse,
    )?.id

  useEffect(() => {
    const conversationElement = conversationRegionRef.current
    if (!open || !conversationElement) {
      wasOpenRef.current = open
      return
    }

    const justOpened = !wasOpenRef.current
    wasOpenRef.current = true
    if (!justOpened && !shouldFollowConversationRef.current) return

    if (typeof conversationElement.scrollTo === 'function')
      conversationElement.scrollTo({
        top: conversationElement.scrollHeight,
        behavior: justOpened ? 'auto' : 'smooth',
      })
    else conversationElement.scrollTop = conversationElement.scrollHeight
  }, [open, conversation.length, ask.isPending, analysis.isFetching])

  return (
    <aside className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <SheetHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-3 pr-14">
        <SheetTitle className="text-xl font-semibold tracking-tight">
          Assistente
        </SheetTitle>
      </SheetHeader>

      <div
        ref={conversationRegionRef}
        aria-label="Conversa com o assistente"
        role="region"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget
          shouldFollowConversationRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-panel"
      >
        <div className="flex flex-col gap-5 sm:gap-6">
          {hasAnalysisArea && (
            <section aria-label="Primeira análise">
              {!assistantConfigured && !closedMonths && !analysis.data ? (
                <p className="text-sm text-muted-foreground">
                  Você recebe uma primeira análise com os dados disponíveis. As
                  próximas acompanham o fechamento de cada mês.
                </p>
              ) : analysis.isError && !analysis.data ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm">
                    A primeira análise não ficou pronta. Suas conversas estão
                    preservadas.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void analysis.refetch()}
                  >
                    Tentar novamente
                  </Button>
                </div>
              ) : analysis.isFetching && !analysis.data ? (
                <div
                  aria-label="Analisando seus dados"
                  className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground"
                >
                  <Spinner />
                  Preparando sua primeira análise…
                </div>
              ) : analysis.data?.analysis ? (
                <AssistantMessage>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {analysis.data.initial
                      ? 'Primeira análise'
                      : `Fechamento de ${analysis.data.month}`}
                  </p>
                  <AnalysisCard analysis={analysis.data.analysis} />
                </AssistantMessage>
              ) : null}
            </section>
          )}
          {hasAnalysisArea && conversation.length > 0 && <Separator />}
          {conversationLoaded &&
            conversation.length === 0 &&
            !analysis.isError &&
            !analysis.isFetching && (
              <p className="text-sm text-muted-foreground">
                Pergunte sobre limites de gastos, compras adiáveis ou ajustes no
                plano mensal.
              </p>
            )}
          {conversation.map((item) => {
            if (item.kind === 'question') {
              return (
                <article key={item.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed">
                    {item.text}
                  </p>
                </article>
              )
            }
            return (
              <AssistantMessage key={item.id}>
                <FinanceAnswerView
                  answer={item.answer}
                  questionnaireResponse={item.questionnaireResponse}
                  onQuestionnaireSubmit={
                    assistantConfigured &&
                    item.id === pendingQuestionnaireId &&
                    !ask.isPending
                      ? (response) => submitQuestionnaire(item.id, response)
                      : undefined
                  }
                />
              </AssistantMessage>
            )
          })}
          {ask.isPending && (
            <AssistantMessage>
              <div
                aria-label="Preparando resposta"
                className="flex min-h-11 items-center gap-2 text-muted-foreground"
              >
                <Spinner />
                Preparando resposta…
              </div>
            </AssistantMessage>
          )}
          {ask.isError && (
            <AssistantMessage>
              <div role="alert" className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  Não consegui preparar essa resposta.
                </p>
                <Button variant="outline" size="sm" onClick={retryQuestion}>
                  Tentar novamente
                </Button>
              </div>
            </AssistantMessage>
          )}
        </div>
      </div>

      <form
        onSubmit={submitQuestion}
        className="shrink-0 border-t bg-background p-panel pb-[max(var(--spacing-panel),env(safe-area-inset-bottom))]"
      >
        <InputGroup className="rounded-2xl">
          <InputGroupTextarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }}
            rows={1}
            placeholder="Pergunte sobre suas finanças…"
            aria-label="Pergunte sobre suas finanças"
            disabled={!assistantConfigured || ask.isPending}
          />
          <InputGroupAddon align="inline-end">
            <Button
              type="submit"
              size="icon"
              aria-label="Enviar pergunta"
              disabled={
                !assistantConfigured ||
                ask.isPending ||
                question.trim().length < 3
              }
            >
              <Send />
            </Button>
          </InputGroupAddon>
        </InputGroup>
        {!assistantConfigured && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Assistente desligado neste servidor: configure OPENROUTER_API_KEY e
            OPENROUTER_MODEL para enviar perguntas.
          </p>
        )}
      </form>
    </aside>
  )
}

export function initialAnalysisRefetchInterval(
  hasFollowUp: boolean,
  analysis?: { initial: boolean },
) {
  return !hasFollowUp && analysis?.initial ? INITIAL_ANALYSIS_REFRESH_MS : false
}

function AssistantMessage({ children }: { children: React.ReactNode }) {
  return (
    <article className="max-w-full text-sm leading-relaxed">{children}</article>
  )
}

function answerAsHistory(answer: FinanceAnswer) {
  const metrics = answer.metrics
    .map((metric) => `${metric.label}: ${formatCurrency(metric.valueCents)}`)
    .join('; ')
  const questionnaire = answer.questionnaire?.items
    .map(
      (item) =>
        `${item.question} Opções: ${item.choices.map((choice) => choice.label).join(', ')}.`,
    )
    .join('\n')
  return [answer.summary, metrics, answer.nextStep, questionnaire]
    .filter(Boolean)
    .join('\n')
}

export function FinanceAnswerView({
  answer,
  questionnaireResponse,
  onQuestionnaireSubmit,
}: {
  answer: FinanceAnswer
  questionnaireResponse?: string
  onQuestionnaireSubmit?: (response: string) => void
}) {
  const largestComparison = Math.max(
    1,
    ...(answer.comparison?.items.map((item) => Math.abs(item.valueCents)) ??
      []),
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="whitespace-pre-line">{answer.summary}</p>
      {answer.metrics.length > 0 && (
        <dl className="grid gap-2 sm:grid-cols-3">
          {answer.metrics.map((metric) => (
            <div key={metric.label} className="rounded-xl bg-muted p-3">
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums">
                {formatCurrency(metric.valueCents)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {answer.comparison && (
        <figure className="flex flex-col gap-3">
          <figcaption className="text-xs font-medium text-muted-foreground">
            {answer.comparison.title}
          </figcaption>
          {answer.comparison.items.map((item) => (
            <Progress
              key={item.label}
              value={(Math.abs(item.valueCents) / largestComparison) * 100}
              aria-label={`${item.label}: ${formatCurrency(item.valueCents)}`}
              className={
                item.valueCents < 0
                  ? '[&_[data-slot=progress-indicator]]:bg-destructive'
                  : undefined
              }
            >
              <span className="text-xs">{item.label}</span>
              <span className="ml-auto text-xs font-medium tabular-nums">
                {formatCurrency(item.valueCents)}
              </span>
            </Progress>
          ))}
        </figure>
      )}
      {answer.nextStep && (
        <p className="border-l-2 border-primary pl-3 text-muted-foreground">
          {answer.nextStep}
        </p>
      )}
      {answer.questionnaire && (
        <FinanceQuestionnaireView
          questionnaire={answer.questionnaire}
          response={questionnaireResponse}
          onSubmit={onQuestionnaireSubmit}
        />
      )}
    </div>
  )
}

function FinanceQuestionnaireView({
  questionnaire,
  response,
  onSubmit,
}: {
  questionnaire: FinanceQuestionnaire
  response?: string
  onSubmit?: (response: string) => void
}) {
  if (response) {
    return (
      <p className="text-xs font-medium text-muted-foreground">
        Respostas enviadas
      </p>
    )
  }

  const enabled = Boolean(onSubmit)
  const items = questionnaire.items.map((item, itemIndex) => ({
    name: `question-${itemIndex}`,
    required: item.required,
    multiple: item.multiple,
    choices: item.choices.map((_, choiceIndex) => ({
      value: `choice-${choiceIndex}`,
      disabled: !enabled,
    })),
  }))

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onSubmit) return
    const formData = new FormData(event.currentTarget)
    const responses = questionnaire.items.flatMap((item, itemIndex) => {
      const values = formData
        .getAll(`question-${itemIndex}`)
        .flatMap((value) =>
          typeof value === 'string' && value.trim() ? [value] : [],
        )
        .map((value) => {
          const choiceIndex = Number(value.replace('choice-', ''))
          return Number.isInteger(choiceIndex) && item.choices[choiceIndex]
            ? item.choices[choiceIndex].label
            : value
        })
      return values.length > 0 ? [`${item.question}\n${values.join(', ')}`] : []
    })
    onSubmit(
      responses.length > 0
        ? responses.join('\n\n')
        : 'Prefiro não responder às perguntas.',
    )
  }

  return (
    <Questionnaire
      defaultItem={items[0]?.name}
      items={items}
      shortcuts="numbers"
      onSubmit={handleSubmit}
    >
      {items.length > 1 && (
        <QuestionnaireProgress
          render={(props, state) => (
            <span {...props}>
              Pergunta {state.current} de {state.total}
            </span>
          )}
        />
      )}
      {questionnaire.items.map((item, itemIndex) => (
        <QuestionnaireItem
          key={`question-${itemIndex}`}
          name={`question-${itemIndex}`}
          multiple={item.multiple}
          required={item.required}
        >
          <QuestionnaireTitle>{item.question}</QuestionnaireTitle>
          {item.description && (
            <QuestionnaireDescription>
              {item.description}
            </QuestionnaireDescription>
          )}
          <QuestionnaireChoices>
            {item.choices.map((choice, choiceIndex) => (
              <QuestionnaireChoice
                key={`choice-${choiceIndex}`}
                value={`choice-${choiceIndex}`}
                disabled={!enabled}
              >
                <span className="font-medium">{choice.label}</span>
                {choice.description && (
                  <QuestionnaireChoiceDescription>
                    {choice.description}
                  </QuestionnaireChoiceDescription>
                )}
              </QuestionnaireChoice>
            ))}
            {item.allowOther && (
              <QuestionnaireInput
                aria-label={`Outra resposta para: ${item.question}`}
                placeholder="Outra resposta…"
                disabled={!enabled}
              />
            )}
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
      ))}
      <QuestionnaireActions>
        <QuestionnairePrevious disabled={!enabled} />
        <QuestionnaireSkip disabled={!enabled} />
        <QuestionnaireNext disabled={!enabled} />
        <QuestionnaireSubmit disabled={!enabled} />
      </QuestionnaireActions>
    </Questionnaire>
  )
}
