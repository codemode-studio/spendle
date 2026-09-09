import { CreditCard, Plus } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'
import { Fragment, useState } from 'react'

import { EmptyState, Panel, SectionHeader, StatusBadge } from '#/components/ui'
import { BalanceCheckpointDialog } from '#/components/balance-checkpoint-dialog'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect } from '#/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { CardStatementSummary } from '#/domain/credit-card'
import {
  currencyOptions,
  formatCurrency,
  formatMinorUnitsForInput,
  parseCurrency,
  toMinorUnits as toCents,
} from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatMonthLong, formatShortDate as formatDate } from '#/domain/period'
import {
  createCreditCardFn,
  updateCreditCardFn,
} from '#/features/finance/finance.functions'
import { InstrumentCard } from '#/features/finance/instrument-card'
import {
  configurationOptions,
  invalidateFinance,
} from '#/features/finance/queries'
import type {
  CardSnapshot,
  FinanceSnapshot,
} from '#/features/finance/snapshot.types'

type CardStatusSnapshot = Pick<
  CardSnapshot,
  | 'coverage'
  | 'latestCheckpoint'
  | 'latestVerifiedCheckpoint'
  | 'unverifiedDays'
>
type CardFormSnapshot = Pick<
  CardSnapshot,
  | 'closingDay'
  | 'currency'
  | 'dueDay'
  | 'id'
  | 'institution'
  | 'lastFour'
  | 'limitCents'
  | 'name'
  | 'ownershipScopeId'
>
type OwnershipScopeOption = Pick<
  FinanceSnapshot['scopes'][number],
  'id' | 'name'
>
type StatementCardSnapshot = Pick<
  CardSnapshot,
  'currency' | 'id' | 'name' | 'upcomingStatements'
>

export function CardsSection() {
  const { data } = useSuspenseQuery(configurationOptions())
  const queryClient = useQueryClient()
  const createCard = useServerFn(createCreditCardFn)
  const updateCard = useServerFn(updateCreditCardFn)
  const [error, setError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = data.cards.find((card) => card.id === editingId)
  const cardById = new Map(data.cards.map((card) => [card.id, card]))
  const statementMonths = groupStatementsByMonth(data.cards)
  const invalidate = () => invalidateFinance(queryClient, 'ledger')
  const fail = (fallback: string) => (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : fallback
    setError(message)
    toast.error(message)
  }
  const createMutation = useMutation({
    mutationFn: createCard,
    onSuccess: () => {
      toast.success('Cartão adicionado.')
      setAddOpen(false)
      invalidate()
    },
    onError: fail('Erro ao salvar.'),
  })
  const updateMutation = useMutation({
    mutationFn: updateCard,
    onSuccess: () => {
      toast.success('Cartão atualizado.')
      setEditingId(null)
      invalidate()
    },
    onError: fail('Erro ao atualizar.'),
  })

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    createMutation.mutate({
      data: readCardForm(new FormData(event.currentTarget)),
    })
  }

  function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    setError('')
    updateMutation.mutate({
      data: {
        id: editing.id,
        ...readCardForm(new FormData(event.currentTarget)),
      },
    })
  }

  return (
    <div className="grid gap-6">
      <SectionHeader
        title="Cartões de crédito"
        action={
          <Button
            type="button"
            onClick={() => {
              setError('')
              setAddOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Cartão
          </Button>
        }
      />
      {data.cards.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {data.cards.map((card) => {
            const hasLimit = card.limitCents > 0
            return (
              <InstrumentCard
                key={card.id}
                title={formatInstrumentName(card.name)}
                subtitle={`${card.institution?.name ?? 'Sem instituição'} · final ${card.lastFour ?? '—'}`}
                editLabel={`Editar ${formatInstrumentName(card.name)}`}
                onEdit={() => {
                  setError('')
                  setEditingId(card.id)
                }}
                metrics={[
                  {
                    label:
                      card.currentStatement.certainty === 'installment_schedule'
                        ? 'Parcelas conhecidas'
                        : 'Fatura atual',
                    value: formatCurrency(card.statementCents, card.currency),
                    caption: card.dueDayEstimated
                      ? 'Vencimento a confirmar'
                      : `Vence ${formatDate(card.currentStatement.dueDate)}`,
                  },
                  {
                    label:
                      card.nextStatement?.certainty === 'installment_schedule'
                        ? 'Saldo futuro conhecido'
                        : 'Próxima fatura',
                    value: formatCurrency(
                      card.nextStatement?.amountCents ?? 0,
                      card.currency,
                    ),
                    caption: card.nextStatement
                      ? `Vence ${formatDate(card.nextStatement.dueDate)}`
                      : 'Sem lançamentos',
                  },
                  ...(hasLimit
                    ? [
                        {
                          label: 'Limite livre',
                          value: formatCurrency(
                            card.availableLimitCents,
                            card.currency,
                          ),
                          caption: `de ${formatCurrency(card.limitCents, card.currency)}`,
                        },
                      ]
                    : []),
                ]}
                status={<CardStatus card={card} />}
                actions={
                  <BalanceCheckpointDialog
                    targetType="card"
                    targetId={card.id}
                    targetName={formatInstrumentName(card.name)}
                    targetCurrency={card.currency}
                    trigger="icon"
                  />
                }
              />
            )
          })}
        </div>
      ) : (
        <Panel>
          <EmptyState
            icon={CreditCard}
            title="Nenhum cartão cadastrado"
            description="Adicione um cartão para acompanhar as faturas."
          />
        </Panel>
      )}

      {statementMonths.length > 0 && (
        <Panel
          title="Calendário de faturas"
          description="Compras importadas e parcelas projetadas por vencimento."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cartão</TableHead>
                <TableHead className="hidden md:table-cell">
                  Fechamento
                </TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead className="hidden sm:table-cell">
                  Lançamentos
                </TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statementMonths.map((month) => (
                <Fragment key={month.key}>
                  <TableRow className="bg-muted/40 pointer-fine:hover:bg-muted/40">
                    <TableCell colSpan={5} className="py-1.5">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium">{month.label}</span>
                        <span className="font-mono text-muted-foreground tabular-nums">
                          {month.totals
                            .map(([currency, cents]) =>
                              formatCurrency(cents, currency),
                            )
                            .join(' · ')}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                  {month.rows.map(({ card, statement }) => (
                    <TableRow key={`${card.id}-${statement.dueDate}`}>
                      <TableCell className="font-medium">
                        {formatInstrumentName(card.name)}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {formatDate(statement.closingDate)}
                      </TableCell>
                      <TableCell>{formatDate(statement.dueDate)}</TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {describeStatementItems(statement)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatCurrency(statement.amountCents, card.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}

      {data.cards
        .filter((card) => card.unexplainedNextStatementCents > 0)
        .map((card) => (
          <p key={card.id} className="text-sm text-muted-foreground">
            {formatInstrumentName(card.name)}: o saldo futuro documentado inclui{' '}
            {formatCurrency(card.unexplainedNextStatementCents, card.currency)}{' '}
            cuja composição não aparece nas parcelas identificadas. Esse valor
            já está incluído na próxima fatura projetada.
          </p>
        ))}

      {data.installmentPlans.length > 0 && (
        <Panel title="Histórico de parcelas identificadas">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Descrição</TableHead>
                <TableHead className="hidden sm:table-cell">Cartão</TableHead>
                <TableHead className="text-right">Parcela</TableHead>
                <TableHead className="hidden md:table-cell">Tipo</TableHead>
                <TableHead className="hidden lg:table-cell">Origem</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.installmentPlans.map((plan) => {
                const card = cardById.get(plan.creditCardId)
                return (
                  <TableRow key={plan.id}>
                    <TableCell className="max-w-[16rem] truncate">
                      {plan.description}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {card ? formatInstrumentName(card.name) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {plan.currentInstallment}/{plan.totalInstallments}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <StatusBadge
                        tone={
                          plan.commitmentType === 'temporary_fixed'
                            ? 'warning'
                            : 'neutral'
                        }
                      >
                        {plan.commitmentType === 'temporary_fixed'
                          ? 'Fixa temporária'
                          : 'Parcelamento curto'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {plan.autoDetected ? 'Detectada' : 'Manual'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCurrency(
                        plan.installmentAmountCents,
                        card?.currency,
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Panel>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!createMutation.isPending) setAddOpen(open)
          if (!open) setError('')
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submitCreate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar cartão</DialogTitle>
              <DialogDescription>
                Cadastre o cartão para importar compras e acompanhar faturas.
              </DialogDescription>
            </DialogHeader>
            <CardFormFields scopes={data.scopes} />
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Salvando…' : 'Salvar cartão'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !updateMutation.isPending) setEditingId(null)
          if (!open) setError('')
        }}
      >
        {editing && (
          <DialogContent className="sm:max-w-lg">
            <form onSubmit={submitEdit} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Editar cartão</DialogTitle>
                <DialogDescription>
                  Atualize os dados usados no limite e no calendário de faturas.
                </DialogDescription>
              </DialogHeader>
              <CardFormFields scopes={data.scopes} card={editing} />
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  Cancelar
                </DialogClose>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Salvando…' : 'Salvar alterações'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

function CardStatus({ card }: { card: CardStatusSnapshot }) {
  const coverageEnd = card.coverage.latestCoverageEnd
  const verifiedAt = card.latestVerifiedCheckpoint?.asOf ?? null
  const freshness = card.coverage.freshness.status
  const tone =
    freshness === 'current'
      ? 'success'
      : freshness === 'recommended'
        ? 'warning'
        : 'neutral'
  return (
    <>
      {coverageEnd ? (
        <StatusBadge tone={tone}>
          {verifiedAt && verifiedAt >= coverageEnd ? 'Conferido' : 'Dados'} até{' '}
          {formatDate(coverageEnd)}
        </StatusBadge>
      ) : (
        <StatusBadge>Sem importações</StatusBadge>
      )}
      {card.latestCheckpoint?.reviewState === 'observed' ? (
        <StatusBadge tone="warning">Fatura não conferida</StatusBadge>
      ) : card.unverifiedDays > 0 ? (
        <StatusBadge>
          {card.unverifiedDays} {card.unverifiedDays === 1 ? 'dia' : 'dias'} sem
          conferência
        </StatusBadge>
      ) : null}
      {card.coverage.gaps.map((gap) => (
        <StatusBadge
          key={`${gap.start}-${gap.end}`}
          tone="warning"
          render={<Link to="/importar" search={{ view: 'upload' }} />}
        >
          Falta {formatDate(gap.start)} a {formatDate(gap.end)}
        </StatusBadge>
      ))}
    </>
  )
}

function CardFormFields({
  scopes,
  card,
}: {
  scopes: ReadonlyArray<OwnershipScopeOption>
  card?: CardFormSnapshot
}) {
  const prefix = card ? `card-${card.id}` : 'card-new'
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Nome</FieldLabel>
        <Input
          id={`${prefix}-name`}
          name="name"
          placeholder="Cartão principal"
          defaultValue={card?.name}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-bank`}>Instituição</FieldLabel>
        <Input
          id={`${prefix}-bank`}
          name="institutionName"
          defaultValue={card?.institution?.name ?? ''}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-owner`}>Proprietário</FieldLabel>
        <NativeSelect
          id={`${prefix}-owner`}
          name="ownershipScopeId"
          className="w-full"
          defaultValue={card?.ownershipScopeId}
        >
          {scopes.map((scope) => (
            <option key={scope.id} value={scope.id}>
              {scope.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-last-four`}>
          Últimos 4 dígitos
        </FieldLabel>
        <Input
          id={`${prefix}-last-four`}
          name="lastFour"
          inputMode="numeric"
          maxLength={4}
          defaultValue={card?.lastFour ?? ''}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-limit`}>Limite</FieldLabel>
        <Input
          id={`${prefix}-limit`}
          name="limit"
          defaultValue={
            card
              ? formatMinorUnitsForInput(card.limitCents, card.currency)
              : '0,00'
          }
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-currency`}>Moeda</FieldLabel>
        <NativeSelect
          id={`${prefix}-currency`}
          name="currency"
          className="w-full"
          defaultValue={card?.currency}
        >
          {currencyOptions.map((currency) => (
            <option key={currency.value} value={currency.value}>
              {currency.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-closing`}>Dia de fechamento</FieldLabel>
        <Input
          id={`${prefix}-closing`}
          name="closingDay"
          type="number"
          min="1"
          max="31"
          defaultValue={card?.closingDay ?? 1}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-due`}>Dia de vencimento</FieldLabel>
        <Input
          id={`${prefix}-due`}
          name="dueDay"
          type="number"
          min="1"
          max="31"
          defaultValue={card ? (card.dueDay ?? '') : 10}
          required
        />
      </Field>
    </FieldGroup>
  )
}

function readCardForm(form: FormData) {
  const lastFour = String(form.get('lastFour') || '')
  const currency = parseCurrency(String(form.get('currency')))
  return {
    name: String(form.get('name')),
    institutionName: String(form.get('institutionName')),
    ownershipScopeId: String(form.get('ownershipScopeId')),
    currency,
    lastFour: lastFour || undefined,
    limitCents: toCents(String(form.get('limit')), currency),
    closingDay: Number(form.get('closingDay')),
    dueDay: Number(form.get('dueDay')),
  }
}

function describeStatementItems(statement: CardStatementSummary) {
  const parts: string[] = []
  if (statement.transactionCount > 0) {
    parts.push(
      `${statement.transactionCount} ${
        statement.transactionCount === 1 ? 'confirmado' : 'confirmados'
      }`,
    )
  }
  if (statement.projectedInstallmentCount > 0) {
    parts.push(
      `${statement.projectedInstallmentCount} ${
        statement.projectedInstallmentCount === 1
          ? 'parcela prevista'
          : 'parcelas previstas'
      }`,
    )
  }
  return parts.length ? parts.join(' · ') : 'Sem lançamentos'
}

/** Achata as faturas de todos os cartões, ordena por vencimento e agrupa por mês. */
function groupStatementsByMonth(cards: ReadonlyArray<StatementCardSnapshot>) {
  const rows = cards
    .flatMap((card) =>
      card.upcomingStatements.map((statement) => ({ card, statement })),
    )
    .sort(
      (a, b) =>
        a.statement.dueDate.localeCompare(b.statement.dueDate) ||
        a.card.name.localeCompare(b.card.name),
    )
  const months = new Map<
    string,
    {
      key: string
      label: string
      rows: typeof rows
      totals: Map<string, number>
    }
  >()
  for (const row of rows) {
    const key = row.statement.dueDate.slice(0, 7)
    let month = months.get(key)
    if (!month) {
      month = {
        key,
        label: formatMonthLong(key, { capitalize: true }),
        rows: [],
        totals: new Map(),
      }
      months.set(key, month)
    }
    month.rows.push(row)
    month.totals.set(
      row.card.currency,
      (month.totals.get(row.card.currency) ?? 0) + row.statement.amountCents,
    )
  }
  return [...months.values()].map((month) => ({
    ...month,
    totals: [...month.totals.entries()],
  }))
}
