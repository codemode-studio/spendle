import { ChevronLeft, ChevronRight, Receipt } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { SegmentedControl } from '#/components/segmented-control'
import { EmptyState, Panel, StatusBadge } from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { formatCurrency } from '#/lib/currency'
import { formatInstrumentName } from '#/lib/finance'
import {
  formatMonthLong,
  formatMonthShort,
  formatShortDate as formatDate,
} from '#/lib/period'
import type { AccountView } from '#/features/data/accounts'
import { cycleStatusCopy } from '#/features/data/cards'
import {
  cardOverviewOptions,
  cycleEntriesOptions,
} from '#/features/data/queries'
import { errorMessage } from '#/lib/api/errors'
import { cn } from '#/lib/utils'

import type { CardCycle, InstallmentPlan } from '@spendle/server/api'

type Cycle = typeof CardCycle.Type
type Plan = typeof InstallmentPlan.Type

const barTone: Record<Cycle['status'], string> = {
  open: 'bg-primary/50',
  due: 'bg-warning',
  paid: 'bg-muted-foreground/30',
  partially_paid: 'bg-warning',
  overdue: 'bg-destructive/70',
}

const paymentVia: Record<Cycle['payments'][number]['via'], string> = {
  card: 'crédito no cartão',
  bank: 'débito na conta',
  credit: 'crédito de fatura anterior',
}

function compactAmount(cents: number, currency: string) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
    notation: Math.abs(cents) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(cents) >= 1_000_000 ? 1 : 0,
  }).format(cents / 100)
}

/** Bills of a card: chart by due date, the chosen bill, its entries, payments and instalments. */
export function CardCyclesExplorer({
  cards,
}: {
  cards: ReadonlyArray<AccountView>
}) {
  const [cardId, setCardId] = useState(cards[0]?.id ?? '')
  const card = cards.find((item) => item.id === cardId) ?? cards.at(0)
  if (!card) return null
  return (
    <Panel
      title="Faturas"
      description="Escolha a fatura para ver o que entrou nela e como foi paga."
      action={
        cards.length > 1 ? (
          <SegmentedControl
            aria-label="Cartão"
            items={cards.map((item) => ({
              value: item.id,
              label: formatInstrumentName(item.name),
            }))}
            value={card.id}
            onValueChange={setCardId}
          />
        ) : undefined
      }
    >
      <CycleExplorer key={card.id} card={card} />
    </Panel>
  )
}

function CycleExplorer({ card }: { card: AccountView }) {
  const overview = useQuery(cardOverviewOptions(card.id))
  const cycles = (overview.data?.cycles.cycles ?? []).filter(
    (cycle) =>
      cycle.entryIds.length > 0 ||
      cycle.projectedCents !== 0 ||
      cycle.status === 'open',
  )
  const [selectedClosing, setSelectedClosing] = useState<string | null>(null)
  const defaultIndex = Math.max(
    0,
    cycles.findLastIndex((cycle) => cycle.status !== 'open'),
  )
  const selectedIndex =
    selectedClosing === null
      ? defaultIndex
      : Math.max(
          0,
          cycles.findIndex((cycle) => cycle.closingOn === selectedClosing),
        )
  const selected = cycles.at(selectedIndex)

  if (overview.isPending) return <Skeleton className="h-48" />
  if (overview.isError)
    return (
      <EmptyState
        icon={Receipt}
        title="Faturas indisponíveis"
        description={errorMessage(overview.error, 'Tente de novo.')}
        action={
          <Button variant="outline" onClick={() => void overview.refetch()}>
            Tentar de novo
          </Button>
        }
      />
    )
  if (!selected)
    return (
      <EmptyState
        icon={Receipt}
        title="Nenhuma fatura ainda"
        description="Importe a fatura ou vincule o cartão pelo Open Finance para ver as faturas."
      />
    )

  return (
    <div className="grid gap-5">
      <CycleChart
        cycles={cycles}
        currency={card.currency}
        selected={selected.closingOn}
        onSelect={setSelectedClosing}
      />
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Fatura anterior"
          disabled={selectedIndex === 0}
          onClick={() =>
            setSelectedClosing(cycles[selectedIndex - 1]?.closingOn ?? null)
          }
        >
          <ChevronLeft />
        </Button>
        <CycleSummary cycle={selected} currency={card.currency} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Próxima fatura"
          disabled={selectedIndex === cycles.length - 1}
          onClick={() =>
            setSelectedClosing(cycles[selectedIndex + 1]?.closingOn ?? null)
          }
        >
          <ChevronRight />
        </Button>
      </div>
      {selected.payments.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Pagamentos</h3>
          <ul className="divide-y rounded-lg border text-sm">
            {selected.payments.map((payment) => (
              <li
                key={`${payment.entryId}-${payment.paidOn}`}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  {formatDate(payment.paidOn)}
                  <span className="text-muted-foreground">
                    {' '}
                    · {paymentVia[payment.via]}
                  </span>
                </span>
                <span className="font-medium tabular-nums text-emerald-700">
                  {formatCurrency(payment.amountCents, card.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <CycleEntries card={card} cycle={selected} />
      {overview.data.installments.length > 0 && (
        <Installments
          plans={overview.data.installments}
          currency={card.currency}
        />
      )}
    </div>
  )
}

function CycleChart({
  cycles,
  currency,
  selected,
  onSelect,
}: {
  cycles: ReadonlyArray<Cycle>
  currency: string
  selected: string
  onSelect: (closingOn: string) => void
}) {
  const max = Math.max(1, ...cycles.map((cycle) => cycle.projectedCents))
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    })
  }, [selected])
  return (
    <div
      role="listbox"
      aria-label="Faturas por vencimento"
      className="flex snap-x gap-1 overflow-x-auto pb-1"
    >
      {cycles.map((cycle) => {
        const active = cycle.closingOn === selected
        const height = Math.max(
          6,
          (Math.max(0, cycle.projectedCents) / max) * 88,
        )
        return (
          <button
            key={cycle.closingOn}
            ref={active ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={active}
            aria-label={`${formatMonthLong(cycle.dueOn, { capitalize: true })}: ${formatCurrency(cycle.projectedCents, currency)}, ${cycleStatusCopy[cycle.status].label}`}
            onClick={() => onSelect(cycle.closingOn)}
            className={cn(
              'flex min-w-[4.5rem] flex-1 snap-center flex-col items-center gap-1.5 rounded-lg px-1 pt-2 pb-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-muted' : 'pointer-fine:hover:bg-muted/60',
            )}
          >
            <span
              className={cn(
                'text-[0.7rem] whitespace-nowrap tabular-nums',
                active
                  ? 'font-semibold text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {compactAmount(cycle.projectedCents, currency)}
            </span>
            <span className="flex h-[88px] items-end">
              <span
                aria-hidden="true"
                className={cn(
                  'block w-3 rounded-full transition-colors',
                  active ? 'bg-primary' : barTone[cycle.status],
                  cycle.closing === 'forecast' &&
                    !active &&
                    'border border-dashed border-primary bg-transparent',
                )}
                style={{ height }}
              />
            </span>
            <span
              className={cn(
                'text-xs capitalize',
                active ? 'font-medium text-primary' : 'text-muted-foreground',
              )}
            >
              {formatMonthShort(cycle.dueOn)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function CycleSummary({ cycle, currency }: { cycle: Cycle; currency: string }) {
  const status = cycleStatusCopy[cycle.status]
  const remaining = Math.max(0, cycle.projectedCents - cycle.paidCents)
  return (
    <div className="grid flex-1 gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">
            {formatMonthLong(cycle.dueOn, { capitalize: true })}
          </strong>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        </div>
        <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
          {formatCurrency(cycle.projectedCents, currency)}
        </p>
        {cycle.pendingCents !== 0 ? (
          <p className="text-xs text-muted-foreground">
            Inclui {formatCurrency(cycle.pendingCents, currency)} ainda
            provisório no banco
          </p>
        ) : null}
        {cycle.paidCents > 0 && remaining > 0 ? (
          <p className="text-xs text-muted-foreground">
            Pago {formatCurrency(cycle.paidCents, currency)} · faltam{' '}
            {formatCurrency(remaining, currency)}
          </p>
        ) : null}
        {cycle.carriedCents !== 0 ? (
          <p className="text-xs text-muted-foreground">
            Inclui {formatCurrency(cycle.carriedCents, currency)} de faturas
            anteriores
          </p>
        ) : null}
        {cycle.statement && cycle.statement.differenceCents !== 0 ? (
          <p className="text-xs text-warning-foreground">
            A fatura emitida diz{' '}
            {formatCurrency(-cycle.statement.observedCents, currency)}
            {cycle.statement.differenceCents < 0 ? ': faltam ' : ': sobram '}
            {formatCurrency(
              Math.abs(cycle.statement.differenceCents),
              currency,
            )}{' '}
            nos lançamentos.{' '}
            {cycle.statement.differenceCents < 0
              ? 'Importe a fatura ou sincronize o cartão.'
              : 'Confira a fatura no app do banco.'}
          </p>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:text-right">
        <dt className="text-muted-foreground">Período</dt>
        <dd className="tabular-nums">
          {formatDate(cycle.startsOn)} – {formatDate(cycle.closingOn)}
        </dd>
        <dt className="text-muted-foreground">Fechamento</dt>
        <dd className="tabular-nums">
          {formatDate(cycle.closingOn)}
          {cycle.closing === 'forecast' ? ' (previsto)' : ''}
        </dd>
        <dt className="text-muted-foreground">Vencimento</dt>
        <dd className="tabular-nums">
          {formatDate(cycle.dueOn)}
          {cycle.due === 'forecast' ? ' (previsto)' : ''}
        </dd>
      </dl>
    </div>
  )
}

function CycleEntries({ card, cycle }: { card: AccountView; cycle: Cycle }) {
  const entries = useQuery(cycleEntriesOptions(card.id, cycle))
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium">
        Lançamentos{' '}
        <span className="font-normal text-muted-foreground">
          · {cycle.entryIds.length}
        </span>
      </h3>
      {entries.isPending ? (
        <Skeleton className="h-24" />
      ) : entries.data?.length ? (
        <ul className="divide-y rounded-lg border text-sm">
          {entries.data.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">
                  <span className="text-muted-foreground tabular-nums">
                    {formatDate(entry.bookedOn)}
                  </span>{' '}
                  {entry.description}
                </span>
                {entry.status === 'pending' ? (
                  <StatusBadge tone="warning">Provisória</StatusBadge>
                ) : null}
              </span>
              <span
                className={cn(
                  'shrink-0 font-medium tabular-nums',
                  entry.amountCents > 0 && 'text-emerald-700',
                )}
              >
                {formatCurrency(entry.amountCents, entry.currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nenhum lançamento nesta fatura.
        </p>
      )}
    </section>
  )
}

function Installments({
  plans,
  currency,
}: {
  plans: ReadonlyArray<Plan>
  currency: string
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium">Parcelamentos</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Compra</TableHead>
            <TableHead className="text-right">Parcelas</TableHead>
            <TableHead className="hidden text-right sm:table-cell">
              Parcela
            </TableHead>
            <TableHead className="text-right">Falta</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((plan) => {
            const paid = Math.max(0, ...plan.seen)
            return (
              <TableRow key={plan.key}>
                <TableCell className="max-w-[16rem] truncate">
                  {plan.description}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-muted sm:block"
                    >
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${(paid / plan.total) * 100}%` }}
                      />
                    </span>
                    {paid}/{plan.total}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {formatCurrency(Math.abs(plan.amountCents), currency)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {plan.remaining > 0
                    ? formatCurrency(Math.abs(plan.remainingCents), currency)
                    : 'Quitado'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
