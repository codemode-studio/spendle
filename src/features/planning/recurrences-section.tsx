import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  CircleOff,
  Link2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { EmptyState, Panel, ProgressBar, StatusBadge } from '#/components/ui'
import { Button } from '#/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { formatCurrency } from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatShortDate as formatDate } from '#/domain/period'
import { isAcceptedRecurrenceMatchStatus } from '#/domain/recurrence-book'
import type {
  PlanningSnapshot,
  RecurrenceSnapshot,
} from '#/features/finance/snapshot.types'
import { cn } from '#/lib/utils'
import { DetectedRecurrencesPanel } from './detection-section'
import { LinkPaymentDialog } from './recurrence-dialogs'
import { buildRecurrenceGroups } from './recurrence-groups'
import type { RecurrenceDisplayRow } from './recurrence-groups'
import { recurrenceStatusBadge } from './presentation'

type DisplayRow = RecurrenceDisplayRow

function RecurrencesSection({
  data,
  pending,
  openNew,
  openEdit,
  toggleActive,
  requestDelete,
  refresh,
  confirmMatch,
  rejectMatch,
  unlinkMatch,
  skipOccurrence,
  linkOccurrence,
  completeOccurrence,
}: {
  data: PlanningSnapshot
  pending: boolean
  openNew: () => void
  openEdit: (id: string) => void
  toggleActive: (id: string, active: boolean) => void
  requestDelete: (id: string) => void
  refresh: () => void
  confirmMatch: (matchId: string) => void
  rejectMatch: (matchId: string) => void
  unlinkMatch: (matchId: string) => void
  skipOccurrence: (occurrenceId: string) => void
  linkOccurrence: (occurrenceId: string, transactionIds: string[]) => void
  completeOccurrence: (occurrenceId: string) => void
}) {
  const [linkRecurrenceId, setLinkRecurrenceId] = useState<string | null>(null)
  const {
    active,
    missingConversionCount,
    monthlyIncome,
    monthlyExpense,
    sections,
  } = buildRecurrenceGroups(data, {
    today: new Date().toISOString().slice(0, 10),
  })

  const renderRow = (entry: DisplayRow) => {
    if (entry.type === 'group') {
      return (
        <div
          key={`group:${entry.group.id}`}
          className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-3"
        >
          <div>
            <strong className="text-sm">{entry.group.name}</strong>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {entry.items.length}{' '}
              {entry.items.length === 1 ? 'recorrência' : 'recorrências'}
            </p>
          </div>
          <span className="text-sm font-medium tabular-nums">
            {formatCurrency(entry.monthlyTotal)}/mês
            {entry.missingConversions > 0 && ' + valor sem cotação'}
          </span>
        </div>
      )
    }
    const item = entry.item
    const account = data.accounts.find(
      (candidate) => candidate.id === item.accountId,
    )
    const card = data.cards.find(
      (candidate) => candidate.id === item.creditCardId,
    )
    const category = data.categories.find(
      (candidate) => candidate.id === item.categoryId,
    )
    const {
      recurrenceBook,
      openOccurrences,
      occurrence,
      acceptedMatch,
      latestAcceptedOccurrence,
      suggestedMatch,
    } = entry
    const statusBadge = recurrenceStatusBadge(recurrenceBook.status)
    const displayName = item.groupId
      ? item.participantLabel || item.name
      : item.name
    return (
      <div key={item.id} className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="truncate text-sm">{displayName}</strong>
              <StatusBadge tone={item.active ? 'success' : 'neutral'}>
                {item.active ? 'Ativa' : 'Pausada'}
              </StatusBadge>
              {statusBadge && (
                <StatusBadge tone={statusBadge.tone}>
                  {statusBadge.label}
                </StatusBadge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {item.groupId && item.name !== displayName
                ? `${item.name} · `
                : ''}
              {formatInstrumentName(
                account?.name ?? card?.name ?? 'Sem destino',
              )}{' '}
              · {category?.name ?? 'Sem categoria'} ·{' '}
              {item.frequency === 'monthly' ? 'Mensal' : 'Anual'} · Próxima{' '}
              {new Date(`${item.nextDate}T12:00:00`).toLocaleDateString(
                'pt-BR',
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <strong
              className={
                item.direction === 'income'
                  ? 'mr-1 tabular-nums text-success'
                  : 'mr-1 tabular-nums text-destructive'
              }
            >
              {item.direction === 'expense' ? '−' : '+'}
              {formatCurrency(item.amountCents, item.currency)}
            </strong>
            {item.active && openOccurrences.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={
                        item.matchMode === 'aggregate'
                          ? 'Vincular lançamentos'
                          : 'Vincular pagamento'
                      }
                      disabled={pending}
                      onClick={() => setLinkRecurrenceId(item.id)}
                    />
                  }
                >
                  <Link2 aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>
                  {item.matchMode === 'aggregate'
                    ? 'Vincular lançamentos'
                    : 'Vincular pagamento'}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Editar ${item.name}`}
                    onClick={() => openEdit(item.id)}
                  />
                }
              >
                <Pencil aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Editar</TooltipContent>
            </Tooltip>
            {item.active &&
              occurrence?.status === 'expected' &&
              !suggestedMatch &&
              !(
                item.matchMode === 'aggregate' &&
                occurrence.matches.some((match) =>
                  isAcceptedRecurrenceMatchStatus(match.status),
                )
              ) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Ignorar ocorrência"
                        disabled={pending}
                        onClick={() => skipOccurrence(occurrence.id)}
                      />
                    }
                  >
                    <CircleOff aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Ignorar ocorrência</TooltipContent>
                </Tooltip>
              )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      item.active
                        ? `Pausar ${item.name}`
                        : `Retomar ${item.name}`
                    }
                    disabled={pending}
                    onClick={() => toggleActive(item.id, !item.active)}
                  />
                }
              >
                {item.active ? (
                  <Pause aria-hidden="true" />
                ) : (
                  <Play aria-hidden="true" />
                )}
              </TooltipTrigger>
              <TooltipContent>
                {item.active ? 'Pausar' : 'Retomar'}
              </TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Excluir ${item.name}`}
              onClick={() => requestDelete(item.id)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
        {item.matchMode === 'aggregate' && occurrence ? (
          <AggregateOccurrenceBlock
            occurrence={occurrence}
            currency={item.currency}
            pending={pending}
            confirmMatch={confirmMatch}
            rejectMatch={rejectMatch}
            unlinkMatch={unlinkMatch}
            completeOccurrence={completeOccurrence}
            openLink={() => setLinkRecurrenceId(item.id)}
          />
        ) : (
          <>
            {suggestedMatch?.transaction && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-sm">
                  <strong>{suggestedMatch.transaction.description}</strong> ·{' '}
                  {formatCurrency(
                    Math.abs(suggestedMatch.transaction.amountCents),
                    suggestedMatch.transaction.currency,
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Confiança {suggestedMatch.score}% · {suggestedMatch.reason}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => confirmMatch(suggestedMatch.id)}
                  >
                    Confirmar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => rejectMatch(suggestedMatch.id)}
                  >
                    Não corresponde
                  </Button>
                </div>
              </div>
            )}
            {acceptedMatch?.transaction && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    Último pagamento: {acceptedMatch.transaction.description} ·{' '}
                    {formatCurrency(
                      Math.abs(acceptedMatch.transaction.amountCents),
                      acceptedMatch.transaction.currency,
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => unlinkMatch(acceptedMatch.id)}
                  >
                    Desvincular
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {recurrenceBook.acceptedMatches.length} pagamento(s)
                  confirmado(s) ·{' '}
                  {latestAcceptedOccurrence
                    ? new Date(
                        `${latestAcceptedOccurrence.expectedDate}T12:00:00`,
                      ).toLocaleDateString('pt-BR')
                    : 'data não identificada'}
                  {' · '}
                  Pago por{' '}
                  {formatInstrumentName(
                    acceptedMatch.transaction.account?.name ??
                      acceptedMatch.transaction.creditCard?.name ??
                      'destino não identificado',
                  )}
                </p>
                {acceptedMatch.categoryConflict && (
                  <p className="mt-2 text-xs text-warning-foreground">
                    A categoria diverge da recorrência.{' '}
                    <Link
                      to="/transacoes"
                      className="font-medium underline underline-offset-2"
                    >
                      Revisar transação
                    </Link>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Panel>
          <p className="text-xs text-muted-foreground">Receitas mensais</p>
          <strong className="mt-1 block text-lg tabular-nums text-success">
            {formatCurrency(monthlyIncome)}
          </strong>
        </Panel>
        <Panel>
          <p className="text-xs text-muted-foreground">Despesas mensais</p>
          <strong className="mt-1 block text-lg tabular-nums text-destructive">
            {formatCurrency(monthlyExpense)}
          </strong>
        </Panel>
        <Panel className="col-span-2 sm:col-span-1">
          <p className="text-xs text-muted-foreground">Recorrências ativas</p>
          <strong className="mt-1 block text-lg tabular-nums">
            {active.length}
          </strong>
        </Panel>
      </div>
      {missingConversionCount > 0 && (
        <p className="text-xs text-warning-foreground">
          {missingConversionCount} recorrência(s) sem cotação para BRL não
          entram nos totais mensais.
        </p>
      )}
      <DetectedRecurrencesPanel data={data} />
      <section className="grid gap-4" aria-labelledby="recurrences-heading">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <h2
              id="recurrences-heading"
              className="font-heading text-base leading-snug font-medium"
            >
              Receitas e despesas recorrentes
            </h2>
            <p className="text-sm text-muted-foreground">
              Compromissos previstos para os próximos meses.
            </p>
          </div>
          {data.recurrences.length ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={refresh} disabled={pending}>
                Buscar pagamentos
              </Button>
              <Button onClick={openNew}>
                <Plus data-icon="inline-start" />
                Nova recorrência
              </Button>
            </div>
          ) : null}
        </header>
        {data.recurrences.length ? (
          <div className="grid gap-5">
            {sections.map((section) => {
              const income = section.direction === 'income'
              const Icon = income ? ArrowDownLeft : ArrowUpRight
              return (
                <section
                  key={section.direction}
                  aria-labelledby={`recurrences-${section.direction}`}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3
                      id={`recurrences-${section.direction}`}
                      className={cn(
                        'flex items-center gap-1.5 text-sm font-semibold',
                        income ? 'text-success' : 'text-destructive',
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {section.label}
                      <span className="font-normal text-muted-foreground">
                        ·{' '}
                        {
                          section.rows.filter(
                            (row) => row.type === 'recurrence',
                          ).length
                        }
                      </span>
                    </h3>
                    <span
                      className={cn(
                        'text-sm font-medium tabular-nums',
                        income ? 'text-success' : 'text-destructive',
                      )}
                    >
                      {income ? '+' : '−'}
                      {formatCurrency(section.monthlyTotal)}/mês
                    </span>
                  </div>
                  {section.rows.length ? (
                    <div className="divide-y rounded-lg border">
                      {section.rows.map(renderRow)}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                      {section.empty}
                    </p>
                  )}
                </section>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="Nenhuma recorrência"
            description="Cadastre salários, assinaturas e outros compromissos previstos."
            action={<Button onClick={openNew}>Criar recorrência</Button>}
          />
        )}
      </section>
      <LinkPaymentDialog
        key={linkRecurrenceId ?? 'none'}
        recurrence={
          data.recurrences.find((item) => item.id === linkRecurrenceId) ?? null
        }
        pending={pending}
        open={linkRecurrenceId !== null}
        onOpenChange={(open) => {
          if (!open) setLinkRecurrenceId(null)
        }}
        onLink={(occurrenceId, transactionIds) => {
          linkOccurrence(occurrenceId, transactionIds)
          setLinkRecurrenceId(null)
        }}
      />
    </div>
  )
}
function AggregateOccurrenceBlock({
  occurrence,
  currency,
  pending,
  confirmMatch,
  rejectMatch,
  unlinkMatch,
  completeOccurrence,
  openLink,
}: {
  occurrence: RecurrenceSnapshot['occurrences'][number]
  currency: string
  pending: boolean
  confirmMatch: (matchId: string) => void
  rejectMatch: (matchId: string) => void
  unlinkMatch: (matchId: string) => void
  completeOccurrence: (occurrenceId: string) => void
  openLink: () => void
}) {
  const linked = occurrence.matches.filter((match) =>
    isAcceptedRecurrenceMatchStatus(match.status),
  )
  const suggested = occurrence.matches.filter(
    (match) => match.status === 'suggested',
  )
  const linkedCents = linked.reduce(
    (sum, match) => sum + Math.abs(match.transaction?.amountCents ?? 0),
    0,
  )
  const open = occurrence.status === 'expected'
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong className="tabular-nums">
            {formatCurrency(linkedCents, currency)}
          </strong>{' '}
          <span className="text-muted-foreground">
            de {formatCurrency(occurrence.expectedAmountCents, currency)} ·{' '}
            {linked.length} {linked.length === 1 ? 'lançamento' : 'lançamentos'}
            {' · '}período de {formatDate(occurrence.expectedDate)}
          </span>
        </span>
        {open && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={openLink}
            >
              <Link2 data-icon="inline-start" /> Vincular
            </Button>
            {linked.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => completeOccurrence(occurrence.id)}
              >
                Concluir período
              </Button>
            )}
          </div>
        )}
      </div>
      <ProgressBar
        value={linkedCents}
        max={Math.max(occurrence.expectedAmountCents, 1)}
        className="mt-2"
      />
      {open && suggested.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Sugeridos neste período ({suggested.length})
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                suggested.forEach((match) => confirmMatch(match.id))
              }
            >
              <Check data-icon="inline-start" /> Confirmar todos
            </Button>
          </div>
          <ul className="mt-1 divide-y rounded-md border bg-background">
            {suggested.map((match) => (
              <li
                key={match.id}
                className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">
                    {match.transaction
                      ? formatDate(match.transaction.postedAt)
                      : ''}
                  </span>{' '}
                  {match.transaction?.description}
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatCurrency(
                    Math.abs(match.transaction?.amountCents ?? 0),
                    match.transaction?.currency ?? currency,
                  )}
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Confirmar"
                    disabled={pending}
                    onClick={() => confirmMatch(match.id)}
                  >
                    <Check />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Não corresponde"
                    disabled={pending}
                    onClick={() => rejectMatch(match.id)}
                  >
                    <X />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {linked.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border bg-background">
          {linked.slice(0, 8).map((match) => (
            <li
              key={match.id}
              className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">
                  {match.transaction
                    ? formatDate(match.transaction.postedAt)
                    : ''}
                </span>{' '}
                {match.transaction?.description}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatCurrency(
                  Math.abs(match.transaction?.amountCents ?? 0),
                  match.transaction?.currency ?? currency,
                )}
              </span>
              {open && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Desvincular"
                  disabled={pending}
                  onClick={() => unlinkMatch(match.id)}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
          {linked.length > 8 && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              + {linked.length - 8} lançamentos
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

export { RecurrencesSection }
