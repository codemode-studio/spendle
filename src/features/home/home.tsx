import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
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
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
import { toast } from 'sonner'

import { EmptyState, Page, Panel } from '#/components/ui'
import { Button, buttonVariants } from '#/components/ui/button'
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
import { formatCurrency } from '#/domain/currency'
import { todayIso } from '#/domain/period'
import type { FinanceSnapshot } from '#/features/finance/snapshot.types'
import { cn } from '#/lib/utils'
import {
  askFinanceQuestionFn,
  generateFortnightAnalysisFn,
} from './analysis.functions'
import type { FortnightAnalysis } from './analysis.server'
import { CategoryBar } from './charts'
import { ForecastOutlook } from './forecast-outlook'
import { buildHomeView, buildInsights } from './insights'
import type { HomeView, Insight } from './insights'

// ─── Página ──────────────────────────────────────────────────────────────────

export function Home({
  snapshot,
  assistantConfigured,
}: {
  snapshot: FinanceSnapshot
  assistantConfigured: boolean
}) {
  const [showAnalysis, setShowAnalysis] = useState(false)
  const view = useMemo(() => buildHomeView(snapshot), [snapshot])
  const insights = useMemo(() => buildInsights(view, formatCurrency), [view])

  return (
    <Page className="home-page max-w-[1120px]">
      <CashHeader snapshot={snapshot} analysis={showAnalysis}>
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
        <Sheet>
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
              insights={insights}
              assistantConfigured={assistantConfigured}
            />
          </SheetContent>
        </Sheet>
      </CashHeader>
      {snapshot.accounts.length === 0 ? (
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
          <ForecastOutlook snapshot={snapshot} view={view} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <ReviewCard items={pendingReviewItems(snapshot)} />
          <MonthlyOverview
            dashboard={snapshot.dashboard}
            assistantConfigured={assistantConfigured}
            currentClosed={snapshot.monthlyBudgets.some(
              (budget) =>
                budget.month === snapshot.dashboard.currentMonth &&
                budget.closed,
            )}
          />
          <div className="grid items-stretch gap-6 md:grid-cols-2">
            <CategorySummaryCard view={view} />
            <CommitmentsCard view={view} />
          </div>
        </div>
      )}
    </Page>
  )
}

// ─── Cabeçalho ───────────────────────────────────────────────────────────────

function CashHeader({
  snapshot,
  children,
  analysis,
}: {
  snapshot: FinanceSnapshot
  children: React.ReactNode
  analysis: boolean
}) {
  const cash = snapshot.dashboard.familyMonth.cashFlow.cashCents

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

function CommitmentsCard({ view }: { view: HomeView }) {
  const due = view.commitments30.filter((item) => item.amountCents < 0)
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
      {view.commitments30.length === 0 ? (
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
          {view.commitments30.slice(0, 5).map((item) => {
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
  | { id: string; kind: 'insight'; insight: Insight }
  | { id: string; kind: 'question'; text: string }
  | { id: string; kind: 'answer'; text: string }
  | { id: string; kind: 'analysis'; analysis: FortnightAnalysis; at: string }

const toneStyles: Record<Insight['tone'], string> = {
  alert: 'bg-red-100 text-red-700',
  warn: 'bg-amber-100 text-amber-700',
  good: 'bg-emerald-100 text-emerald-700',
  neutral: 'bg-sky-100 text-sky-700',
}

function ActivityColumn({
  insights,
  assistantConfigured,
}: {
  insights: Array<Insight>
  assistantConfigured: boolean
}) {
  const [conversation, setConversation] = useState<Array<FeedItem>>([])
  const [question, setQuestion] = useState('')
  const [reactions, setReactions] = useState<Record<string, 'up' | 'down'>>({})

  const push = (item: FeedItem) =>
    setConversation((current) => [...current, item])

  const analysis = useMutation({
    mutationFn: () => generateFortnightAnalysisFn(),
    onSuccess: (data) =>
      push({
        id: `analysis-${Date.now()}`,
        kind: 'analysis',
        analysis: data,
        at: todayIso(),
      }),
    onError: (error) => toast.error(error.message),
  })

  const ask = useMutation({
    mutationFn: (text: string) =>
      askFinanceQuestionFn({ data: { question: text } }),
    onSuccess: (text) =>
      push({ id: `answer-${Date.now()}`, kind: 'answer', text }),
    onError: (error) => toast.error(error.message),
  })

  const submitQuestion = (event: React.FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (text.length < 3 || ask.isPending) return
    push({ id: `question-${Date.now()}`, kind: 'question', text })
    setQuestion('')
    ask.mutate(text)
  }

  const feed: Array<FeedItem> = [
    ...insights.map((insight) => ({
      id: insight.id,
      kind: 'insight' as const,
      insight,
    })),
    ...conversation,
  ]

  return (
    <aside className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <SheetHeader className="shrink-0 flex-row flex-wrap items-center justify-between gap-3 pr-14">
        <SheetTitle className="text-xl font-semibold tracking-tight">
          Atividade
        </SheetTitle>
        <Button
          variant="outline"
          size="sm"
          disabled={!assistantConfigured || analysis.isPending}
          onClick={() => analysis.mutate()}
        >
          <Sparkles
            className={analysis.isPending ? 'animate-pulse' : undefined}
          />
          {analysis.isPending ? 'Analisando…' : 'Análise da quinzena'}
        </Button>
      </SheetHeader>

      <div
        aria-label="Conversa com o assistente"
        role="region"
        tabIndex={0}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-panel pb-panel sm:space-y-6"
      >
        {feed.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Importe extratos para o assistente começar a observar seus gastos.
          </p>
        )}
        {feed.map((item) => {
          if (item.kind === 'insight') {
            const reaction = reactions[item.id]
            return (
              <Message
                key={item.id}
                author="Assistente"
                avatar={
                  <span
                    className={`flex size-7 items-center justify-center rounded-lg ${toneStyles[item.insight.tone]}`}
                  >
                    <Sparkles className="size-3.5" />
                  </span>
                }
              >
                <p className="font-medium">{item.insight.title}</p>
                <p className="mt-1 text-muted-foreground">
                  {item.insight.body}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {item.insight.to && item.insight.cta && (
                    <Link
                      to={item.insight.to}
                      search={item.insight.search}
                      className="inline-flex items-center rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 pointer-coarse:min-h-11 pointer-coarse:px-3"
                    >
                      {item.insight.cta}
                    </Link>
                  )}
                  <ReactionButton
                    active={reaction === 'up'}
                    onClick={() =>
                      setReactions((current) => ({
                        ...current,
                        [item.id]: 'up',
                      }))
                    }
                    icon={ThumbsUp}
                    label="Útil"
                  />
                  <ReactionButton
                    active={reaction === 'down'}
                    onClick={() =>
                      setReactions((current) => ({
                        ...current,
                        [item.id]: 'down',
                      }))
                    }
                    icon={ThumbsDown}
                    label="Não ajuda"
                  />
                </div>
              </Message>
            )
          }
          if (item.kind === 'question') {
            return (
              <Message
                key={item.id}
                author="Você"
                avatar={
                  <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-xs font-semibold">
                    V
                  </span>
                }
              >
                <p>{item.text}</p>
              </Message>
            )
          }
          if (item.kind === 'answer') {
            return (
              <Message
                key={item.id}
                author="Assistente"
                avatar={<AssistantAvatar />}
              >
                <p className="whitespace-pre-line">
                  {item.text.replace(/\*\*/g, '')}
                </p>
              </Message>
            )
          }
          return (
            <Message
              key={item.id}
              author="Análise quinzenal"
              avatar={<AssistantAvatar />}
            >
              <AnalysisCard analysis={item.analysis} />
            </Message>
          )
        })}
        {(ask.isPending || analysis.isPending) && (
          <Message author="Assistente" avatar={<AssistantAvatar />}>
            <p className="animate-pulse text-muted-foreground">
              {analysis.isPending ? 'Analisando a quinzena…' : 'Pensando…'}
            </p>
          </Message>
        )}
      </div>

      <form
        onSubmit={submitQuestion}
        className="shrink-0 border-t bg-background p-panel pb-[max(var(--spacing-panel),env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center gap-2 rounded-xl border bg-background px-3 py-1.5 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Pergunte sobre suas finanças…"
            aria-label="Pergunte sobre suas finanças"
            disabled={!assistantConfigured || ask.isPending}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60 pointer-coarse:h-11"
          />
          <button
            type="submit"
            aria-label="Enviar pergunta"
            disabled={
              !assistantConfigured ||
              ask.isPending ||
              question.trim().length < 3
            }
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 pointer-coarse:size-11"
          >
            <Send className="size-4" />
          </button>
        </div>
        {!assistantConfigured && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Para usar o assistente, ative o uso de IA em Configurações e
            configure OPENROUTER_API_KEY em .env.local.
          </p>
        )}
      </form>
    </aside>
  )
}

function AssistantAvatar() {
  return (
    <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
      <Sparkles className="size-3.5" />
    </span>
  )
}

function Message({
  author,
  avatar,
  children,
  className,
}: {
  author: string
  avatar: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <article
      className={cn('grid grid-cols-[28px_minmax(0,1fr)] gap-x-3', className)}
    >
      <div>{avatar}</div>
      <div className="pt-1 text-sm leading-relaxed">
        <p className="text-xs text-muted-foreground">{author}</p>
        <div className="mt-1">{children}</div>
      </div>
    </article>
  )
}

function ReactionButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof ThumbsUp
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={`flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-muted pointer-coarse:size-11 ${
        active ? 'border-foreground/30 bg-muted text-foreground' : ''
      }`}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

const severityDot: Record<'alta' | 'media' | 'baixa', string> = {
  alta: 'bg-red-500',
  media: 'bg-amber-500',
  baixa: 'bg-slate-400',
}

function AnalysisCard({ analysis }: { analysis: FortnightAnalysis }) {
  const scoreTone =
    analysis.healthScore >= 70
      ? 'bg-emerald-100 text-emerald-700'
      : analysis.healthScore >= 45
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700'
  return (
    <div className="rounded-xl border bg-muted/30 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{analysis.headline}</p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${scoreTone}`}
        >
          {analysis.healthScore} · {analysis.healthLabel}
        </span>
      </div>
      <p className="mt-2 text-muted-foreground">{analysis.summary}</p>
      {analysis.findings.length > 0 && (
        <ul className="mt-3 space-y-2">
          {analysis.findings.map((finding) => (
            <li key={finding.title} className="flex gap-2">
              <span
                className={`mt-1.5 size-2 shrink-0 rounded-full ${severityDot[finding.severity]}`}
              />
              <span>
                <span className="font-medium">{finding.title}</span>{' '}
                <span className="text-muted-foreground">{finding.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {analysis.actions.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            O que fazer nas próximas duas semanas
          </p>
          <ol className="mt-2 space-y-2">
            {analysis.actions.map((action, index) => (
              <li key={action.title} className="flex gap-2">
                <span className="w-4 shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">
                  {index + 1}.
                </span>
                <span>
                  <span className="font-medium">{action.title}</span>
                  {action.estimatedMonthlySavingsReais !== null &&
                    action.estimatedMonthlySavingsReais > 0 && (
                      <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 tabular-nums">
                        ~
                        {formatCurrency(
                          Math.round(action.estimatedMonthlySavingsReais * 100),
                        )}
                        /mês
                      </span>
                    )}{' '}
                  <span className="text-muted-foreground">{action.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
