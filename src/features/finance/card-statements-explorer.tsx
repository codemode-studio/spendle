import {
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  Receipt,
  Search,
  Unlink,
  X,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { SegmentedControl } from '#/components/segmented-control'
import { EmptyState, Panel, StatusBadge } from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Spinner } from '#/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import {
  statementPaymentKindLabels,
  statementStatusLabels,
} from '#/domain/card-statement-ledger'
import type { StatementStatus } from '#/domain/card-statement-ledger'
import { formatCurrency } from '#/domain/currency'
import { formatInstrumentName, normalizeDescription } from '#/domain/finance'
import {
  formatMonthLong,
  formatMonthShort,
  formatShortDate as formatDate,
} from '#/domain/period'
import {
  linkCardStatementPaymentFn,
  setReconciliationStatusFn,
  unlinkCardStatementPaymentFn,
} from '#/features/finance/finance.functions'
import {
  cardStatementCandidatesOptions,
  invalidateFinance,
} from '#/features/finance/queries'
import type { CardSnapshot } from '#/features/finance/snapshot.types'
import { cn } from '#/lib/utils'

type ExplorerCard = Pick<
  CardSnapshot,
  'currency' | 'currentStatement' | 'id' | 'name' | 'statements'
>
type Statement = ExplorerCard['statements'][number]

const statusTone: Record<
  StatementStatus,
  'neutral' | 'success' | 'warning' | 'danger' | 'info'
> = {
  scheduled: 'neutral',
  open: 'info',
  empty: 'neutral',
  closed: 'neutral',
  paid: 'success',
  partial: 'warning',
  suggested: 'warning',
  likely: 'warning',
  overdue: 'warning',
}

const barTone: Record<StatementStatus, string> = {
  scheduled:
    'bg-muted-foreground/20 border border-dashed border-muted-foreground/50',
  open: 'bg-primary/60',
  empty: 'bg-muted-foreground/20',
  closed: 'bg-foreground/50',
  paid: 'bg-muted-foreground/30',
  partial: 'bg-warning',
  suggested: 'bg-warning',
  likely: 'bg-warning',
  overdue: 'bg-warning/70',
}

function compactAmount(cents: number, currency: string) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
    notation: cents >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: cents >= 1_000_000 ? 1 : 0,
  }).format(cents / 100)
}

/** Faturas de um cartão: gráfico por vencimento, detalhe da fatura e seus lançamentos. */
export function CardStatementsExplorer({ cards }: { cards: ExplorerCard[] }) {
  const [cardId, setCardId] = useState(cards[0]?.id ?? '')
  const card = cards.find((item) => item.id === cardId) ?? cards.at(0)
  if (!card) return null
  return (
    <Panel
      title="Faturas"
      description="Navegue pelas faturas, veja o que entrou em cada uma e qual pagamento a quitou."
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
      <StatementExplorer key={card.id} card={card} />
    </Panel>
  )
}

function StatementExplorer({ card }: { card: ExplorerCard }) {
  const statements = card.statements.filter(
    (statement) =>
      statement.amountCents > 0 ||
      statement.transactions.length > 0 ||
      statement.status === 'open',
  )
  const defaultDue =
    statements.find(
      (statement) => statement.dueDate === card.currentStatement.dueDate,
    )?.dueDate ??
    statements.at(-1)?.dueDate ??
    ''
  const [selectedDue, setSelectedDue] = useState(defaultDue)
  const selectedIndex = Math.max(
    0,
    statements.findIndex((statement) => statement.dueDate === selectedDue),
  )
  const selected = statements.at(selectedIndex)

  if (!selected) {
    return (
      <EmptyState
        icon={Receipt}
        title="Nenhuma fatura ainda"
        description="Importe a fatura do cartão para ver os lançamentos por vencimento."
      />
    )
  }

  return (
    <div className="grid gap-5">
      <StatementChart
        statements={statements}
        currency={card.currency}
        selectedDue={selected.dueDate}
        onSelect={setSelectedDue}
      />
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Fatura anterior"
          disabled={selectedIndex === 0}
          onClick={() => setSelectedDue(statements[selectedIndex - 1].dueDate)}
        >
          <ChevronLeft />
        </Button>
        <StatementSummary statement={selected} currency={card.currency} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Próxima fatura"
          disabled={selectedIndex === statements.length - 1}
          onClick={() => setSelectedDue(statements[selectedIndex + 1].dueDate)}
        >
          <ChevronRight />
        </Button>
      </div>
      <StatementPayments
        cardId={card.id}
        statement={selected}
        currency={card.currency}
      />
      <StatementTransactions statement={selected} currency={card.currency} />
    </div>
  )
}

function StatementChart({
  statements,
  currency,
  selectedDue,
  onSelect,
}: {
  statements: Statement[]
  currency: string
  selectedDue: string
  onSelect: (dueDate: string) => void
}) {
  const max = Math.max(1, ...statements.map((s) => s.amountCents))
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    })
  }, [selectedDue])
  return (
    <div
      role="listbox"
      aria-label="Faturas por vencimento"
      className="flex snap-x gap-1 overflow-x-auto pb-1"
    >
      {statements.map((statement) => {
        const active = statement.dueDate === selectedDue
        const height = Math.max(6, (statement.amountCents / max) * 88)
        const showYear =
          statement.dueDate.slice(0, 4) !== selectedDue.slice(0, 4)
        return (
          <button
            key={statement.dueDate}
            ref={active ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={active}
            aria-label={`${formatMonthLong(statement.dueDate, { capitalize: true })}: ${formatCurrency(statement.amountCents, currency)}, ${statementStatusLabels[statement.status]}`}
            onClick={() => onSelect(statement.dueDate)}
            className={cn(
              'flex min-w-[4.5rem] flex-1 snap-center flex-col items-center gap-1.5 rounded-lg px-1 pt-2 pb-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-muted' : 'pointer-fine:hover:bg-muted/60',
            )}
          >
            <span
              className={cn(
                'text-[0.7rem] tabular-nums whitespace-nowrap',
                active
                  ? 'font-semibold text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {compactAmount(statement.amountCents, currency)}
            </span>
            <span className="flex h-[88px] items-end">
              <span
                aria-hidden="true"
                className={cn(
                  'block w-3 rounded-full transition-colors',
                  active ? 'bg-primary' : barTone[statement.status],
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
              {formatMonthShort(statement.dueDate)}
              {showYear ? `/${statement.dueDate.slice(2, 4)}` : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function StatementSummary({
  statement,
  currency,
}: {
  statement: Statement
  currency: string
}) {
  const remaining = Math.max(0, statement.amountCents - statement.paidCents)
  return (
    <div className="grid flex-1 gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">
            {formatMonthLong(statement.dueDate, { capitalize: true })}
          </strong>
          <StatusBadge tone={statusTone[statement.status]}>
            {statementStatusLabels[statement.status]}
          </StatusBadge>
        </div>
        <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
          {formatCurrency(statement.amountCents, currency)}
        </p>
        {statement.status === 'partial' && (
          <p className="text-xs text-muted-foreground">
            Faltam {formatCurrency(remaining, currency)}
          </p>
        )}
        {statement.status === 'paid' &&
          statement.paidCents > 0 &&
          statement.paidCents !== statement.amountCents && (
            <p className="text-xs text-muted-foreground">
              Pago {formatCurrency(statement.paidCents, currency)},{' '}
              {formatCurrency(
                Math.abs(statement.amountCents - statement.paidCents),
                currency,
              )}{' '}
              {statement.paidCents < statement.amountCents ? 'abaixo' : 'acima'}{' '}
              do total calculado. Créditos e ajustes no fechamento explicam a
              diferença.
            </p>
          )}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:text-right">
        <dt className="text-muted-foreground">Fechamento</dt>
        <dd className="tabular-nums">{formatDate(statement.closingDate)}</dd>
        <dt className="text-muted-foreground">Vencimento</dt>
        <dd className="tabular-nums">{formatDate(statement.dueDate)}</dd>
      </dl>
    </div>
  )
}

function StatementPayments({
  cardId,
  statement,
  currency,
}: {
  cardId: string
  statement: Statement
  currency: string
}) {
  const queryClient = useQueryClient()
  const setStatus = useServerFn(setReconciliationStatusFn)
  const linkPayment = useServerFn(linkCardStatementPaymentFn)
  const unlinkPayment = useServerFn(unlinkCardStatementPaymentFn)
  const [linkOpen, setLinkOpen] = useState(false)
  const fail = (error: unknown) =>
    toast.error(
      error instanceof Error ? error.message : 'Não foi possível atualizar.',
    )
  const statusMutation = useMutation({
    mutationFn: setStatus,
    onSuccess: (_, variables) => {
      toast.success(
        variables.data.status === 'confirmed'
          ? 'Pagamento vinculado à fatura.'
          : 'Sugestão descartada.',
      )
      void invalidateFinance(queryClient, 'ledger')
    },
    onError: fail,
  })
  const linkMutation = useMutation({
    mutationFn: linkPayment,
    onSuccess: () => {
      toast.success('Pagamento vinculado à fatura.')
      setLinkOpen(false)
      void invalidateFinance(queryClient, 'ledger')
    },
    onError: fail,
  })
  const unlinkMutation = useMutation({
    mutationFn: unlinkPayment,
    onSuccess: () => {
      toast.success('Vínculo desfeito.')
      void invalidateFinance(queryClient, 'ledger')
    },
    onError: fail,
  })
  const pending =
    statusMutation.isPending ||
    linkMutation.isPending ||
    unlinkMutation.isPending
  const link = (transactionId: string, partial = false) =>
    linkMutation.mutate({
      data: {
        creditCardId: cardId,
        dueDate: statement.dueDate,
        transactionId,
        partial,
      },
    })
  const canLink = !['open', 'scheduled', 'empty', 'paid'].includes(
    statement.status,
  )

  const emptyMessage =
    statement.status === 'open'
      ? 'A fatura ainda está aberta; o pagamento aparece aqui depois do fechamento.'
      : statement.status === 'scheduled'
        ? 'Valor previsto a partir das parcelas conhecidas.'
        : statement.status === 'empty'
          ? 'Nenhum lançamento entrou nesta fatura.'
          : 'Nenhum pagamento identificado. Quando o débito aparecer no extrato da conta, o vínculo é feito automaticamente. Se já estiver lá, vincule manualmente.'

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Pagamento</h3>
        {canLink && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setLinkOpen(true)}
          >
            <Link2 data-icon="inline-start" />
            Vincular pagamento
          </Button>
        )}
      </div>
      {statement.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {statement.payments.map((payment) => (
            <li
              key={`${payment.kind}-${payment.transactionId}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{payment.description}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(payment.postedAt)}
                  {payment.accountName ? ` · ${payment.accountName}` : ''}
                  {' · '}
                  {statementPaymentKindLabels[payment.kind]}
                  {payment.kind === 'manual' && payment.partial
                    ? ' (parcial)'
                    : ''}
                </p>
              </div>
              <span className="font-mono text-sm tabular-nums">
                {formatCurrency(payment.amountCents, currency)}
              </span>
              {payment.kind === 'suggested' && payment.groupId && (
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      statusMutation.mutate({
                        data: {
                          groupId: payment.groupId!,
                          status: 'confirmed',
                        },
                      })
                    }
                  >
                    <Check data-icon="inline-start" />
                    Confirmar
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      statusMutation.mutate({
                        data: {
                          groupId: payment.groupId!,
                          status: 'rejected',
                        },
                      })
                    }
                  >
                    <X data-icon="inline-start" />
                    Não é este
                  </Button>
                </div>
              )}
              {payment.kind === 'candidate' && (
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() => link(payment.transactionId)}
                >
                  <Check data-icon="inline-start" />É este
                </Button>
              )}
              {payment.kind === 'manual' && payment.linkId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    unlinkMutation.mutate({ data: { id: payment.linkId! } })
                  }
                >
                  <Unlink data-icon="inline-start" />
                  Desvincular
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <LinkStatementPaymentDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        cardId={cardId}
        statement={statement}
        currency={currency}
        pending={linkMutation.isPending}
        onLink={link}
      />
    </div>
  )
}

/** Escolha manual do débito bancário que pagou a fatura, como o vínculo de recorrências. */
function LinkStatementPaymentDialog({
  open,
  onOpenChange,
  cardId,
  statement,
  currency,
  pending,
  onLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardId: string
  statement: Statement
  currency: string
  pending: boolean
  onLink: (transactionId: string, partial: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [partial, setPartial] = useState(false)
  const candidatesQuery = useQuery(
    cardStatementCandidatesOptions(
      open
        ? {
            creditCardId: cardId,
            dueDate: statement.dueDate,
            amountCents: statement.amountCents,
          }
        : undefined,
    ),
  )
  const query = normalizeDescription(search)
  const candidates = (candidatesQuery.data ?? [])
    .filter(
      (candidate) =>
        !query || normalizeDescription(candidate.description).includes(query),
    )
    .slice(0, 60)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setSearch('')
          setSelectedId(null)
          setPartial(false)
        }
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Vincular pagamento</DialogTitle>
          <DialogDescription>
            Fatura de {formatMonthLong(statement.dueDate)} ·{' '}
            {formatCurrency(statement.amountCents, currency)} com vencimento em{' '}
            {formatDate(statement.dueDate)}. Débitos de conta até 45 dias do
            vencimento.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por descrição…"
            aria-label="Buscar transação"
            className="pl-8 md:pl-8"
          />
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          {candidatesQuery.isPending ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> Buscando débitos…
            </div>
          ) : candidatesQuery.isError ? (
            <p className="p-4 text-sm text-destructive">
              Não foi possível buscar os débitos da conta.
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nenhum débito de conta perto do vencimento. Importe o extrato do
              período.
            </p>
          ) : (
            <ul className="divide-y">
              {candidates.map((candidate) => {
                const selected = selectedId === candidate.id
                const hints = [
                  candidate.amountDifferenceCents === 0 ? 'valor exato' : null,
                  candidate.daysApart <= 3 ? 'data próxima' : null,
                  candidate.linkedToDueDate
                    ? `já vinculado a ${formatMonthLong(candidate.linkedToDueDate)}`
                    : null,
                  candidate.categoryName,
                ].filter(Boolean)
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setSelectedId(selected ? null : candidate.id)
                      }
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors pointer-fine:hover:bg-muted/50',
                        selected &&
                          'bg-primary/5 ring-1 ring-primary/40 ring-inset',
                      )}
                    >
                      <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatDate(candidate.postedAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {candidate.description}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {candidate.accountLabel ?? '—'}
                          {hints.length > 0 && ` · ${hints.join(' · ')}`}
                        </span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatCurrency(
                          Math.abs(candidate.amountCents),
                          candidate.currency,
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={partial}
            onCheckedChange={(checked) => setPartial(checked === true)}
            className="mt-0.5"
          />
          <span>
            Pagamento parcial
            <span className="block text-xs text-muted-foreground">
              Só marque se pagou parte da fatura de propósito. Diferenças
              pequenas por crédito ou ajuste no fechamento não são parciais.
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!selectedId || pending || candidatesQuery.isPending}
            onClick={() => selectedId && onLink(selectedId, partial)}
          >
            <Check data-icon="inline-start" />
            Vincular pagamento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StatementTransactions({
  statement,
  currency,
}: {
  statement: Statement
  currency: string
}) {
  if (!statement.transactions.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {statement.status === 'scheduled'
          ? 'Os lançamentos aparecem quando a fatura for importada.'
          : 'Nenhum lançamento importado nesta fatura.'}
      </p>
    )
  }
  const rows = [...statement.transactions].sort(
    (a, b) =>
      b.postedAt.localeCompare(a.postedAt) ||
      a.description.localeCompare(b.description),
  )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">Data</TableHead>
          <TableHead>Lançamento</TableHead>
          <TableHead className="hidden sm:table-cell">Parcela</TableHead>
          <TableHead className="text-right">Valor</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((transaction) => (
          <TableRow key={transaction.id}>
            <TableCell className="text-muted-foreground tabular-nums">
              {formatDate(transaction.postedAt)}
            </TableCell>
            <TableCell className="max-w-[18rem]">
              <p className="truncate">{transaction.description}</p>
              {transaction.categoryName && (
                <p className="truncate text-xs text-muted-foreground">
                  {transaction.categoryName}
                </p>
              )}
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              {transaction.installment && (
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">
                    {transaction.installment}
                  </span>
                  {transaction.temporaryFixed && (
                    <StatusBadge tone="warning">Fixa temporária</StatusBadge>
                  )}
                </span>
              )}
            </TableCell>
            <TableCell
              className={cn(
                'text-right font-mono tabular-nums',
                transaction.amountCents > 0 && 'text-success',
              )}
            >
              {formatCurrency(transaction.amountCents, currency)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
