import { Archive, CreditCard, Plug, Plus } from 'lucide-react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'
import { useState } from 'react'

import { EmptyState, Panel, SectionHeader, StatusBadge } from '#/components/ui'
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
  currencyOptions,
  formatCurrency,
  formatMinorUnitsForInput,
  toMinorUnits,
} from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatMonthLong, formatShortDate as formatDate } from '#/domain/period'
import { CardCyclesExplorer } from '#/features/finance/card-cycles-explorer'
import { InstrumentCard } from '#/features/finance/instrument-card'
import type { InstrumentMetric } from '#/features/finance/instrument-card'
import {
  archiveAccountFn,
  openAccountFn,
  updateAccountFn,
} from '#/features/v2/accounts.functions'
import { isCard } from '#/features/v2/accounts'
import type { AccountView, Owner } from '#/features/v2/accounts'
import { summarizeCard } from '#/features/v2/cards'
import {
  accountsOptions,
  cardOverviewOptions,
  invalidateAfterReactors,
  ownersOptions,
} from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'

export function CardsSection() {
  const { data: accounts } = useSuspenseQuery(accountsOptions(true))
  const { data: owners } = useSuspenseQuery(ownersOptions())
  const queryClient = useQueryClient()
  const openAccount = useServerFn(openAccountFn)
  const updateAccount = useServerFn(updateAccountFn)
  const archiveAccount = useServerFn(archiveAccountFn)
  const [error, setError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const cards = accounts.filter(
    (account) => isCard(account) && !account.archived,
  )
  const editing = cards.find((card) => card.id === editingId)
  const invalidate = () => invalidateAfterReactors(queryClient)
  const fail = (fallback: string) => (reason: unknown) => {
    const message = errorMessage(reason, fallback)
    setError(message)
    toast.error(message)
  }
  const createMutation = useMutation({
    mutationFn: openAccount,
    onSuccess: () => {
      toast.success('Cartão adicionado.')
      setAddOpen(false)
      void invalidate()
    },
    onError: fail('Não foi possível salvar.'),
  })
  const updateMutation = useMutation({
    mutationFn: updateAccount,
    onSuccess: () => {
      toast.success('Cartão atualizado. As faturas são recalculadas.')
      setEditingId(null)
      void invalidate()
    },
    onError: fail('Não foi possível atualizar.'),
  })
  const archiveMutation = useMutation({
    mutationFn: archiveAccount,
    onSuccess: (card) => {
      toast.success(`${card.name} arquivado. O histórico continua salvo.`)
      setEditingId(null)
      void invalidate()
    },
    onError: fail('Não foi possível arquivar.'),
  })

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const currency = String(form.get('currency'))
    createMutation.mutate({
      data: {
        ownerId: String(form.get('ownerId')),
        name: String(form.get('name')).trim(),
        institutionName: String(form.get('institutionName')).trim(),
        kind: 'credit_card',
        purpose: 'operating',
        currency,
        card: readTerms(form, currency),
      },
    })
  }

  function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    setError('')
    const form = new FormData(event.currentTarget)
    updateMutation.mutate({
      data: {
        accountId: editing.id,
        changes: {
          name: String(form.get('name')).trim(),
          institutionName: String(form.get('institutionName')).trim(),
          card: readTerms(form, editing.currency),
        },
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
      {cards.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {cards.map((card) => (
            <CardInstrument
              key={card.id}
              card={card}
              onEdit={() => {
                setError('')
                setEditingId(card.id)
              }}
            />
          ))}
        </div>
      ) : (
        <Panel>
          <EmptyState
            icon={CreditCard}
            title="Nenhum cartão cadastrado"
            description="Adicione o cartão ou conecte o banco para acompanhar as faturas."
            action={
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link to="/configuracoes" search={{ tab: 'open-finance' }} />
                }
              >
                <Plug data-icon="inline-start" />
                Conectar banco
              </Button>
            }
          />
        </Panel>
      )}

      {cards.length > 0 && <CardCyclesExplorer cards={cards} />}

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
                Fechamento e vencimento definem o calendário das faturas.
              </DialogDescription>
            </DialogHeader>
            <CardFormFields owners={owners} />
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
                  Mudar fechamento ou vencimento recalcula as faturas.
                </DialogDescription>
              </DialogHeader>
              <CardFormFields owners={owners} card={editing} />
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={archiveMutation.isPending}
                  onClick={() =>
                    archiveMutation.mutate({ data: { accountId: editing.id } })
                  }
                >
                  <Archive data-icon="inline-start" />
                  Arquivar
                </Button>
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <DialogClose
                    render={<Button type="button" variant="outline" />}
                  >
                    Cancelar
                  </DialogClose>
                  <Button type="submit" disabled={updateMutation.isPending}>
                    {updateMutation.isPending
                      ? 'Salvando…'
                      : 'Salvar alterações'}
                  </Button>
                </div>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

function CardInstrument({
  card,
  onEdit,
}: {
  card: AccountView
  onEdit: () => void
}) {
  const overview = useQuery(cardOverviewOptions(card.id))
  const summary = overview.data
    ? summarizeCard({
        limitCents: card.card?.limitCents ?? null,
        cycles: overview.data.cycles.cycles,
        unappliedCents: overview.data.cycles.unappliedCents,
        installments: overview.data.installments,
      })
    : null
  const metrics: Array<InstrumentMetric> = summary
    ? [
        {
          label: 'Fatura aberta',
          value: formatCurrency(summary.open?.billedCents ?? 0, card.currency),
          caption: summary.open
            ? `Fecha ${formatDate(summary.open.closingOn)}${summary.open.closing === 'forecast' ? ' (previsto)' : ''}`
            : 'Sem fatura aberta',
        },
        {
          label: summary.overdue ? 'Vencido' : 'A pagar',
          value: formatCurrency(summary.dueCents, card.currency),
          caption: summary.nextDue
            ? `Vence ${formatDate(summary.nextDue)}`
            : 'Nada pendente',
        },
        ...(summary.availableLimitCents !== null && card.card?.limitCents
          ? [
              {
                label: 'Limite livre',
                value: formatCurrency(
                  summary.availableLimitCents,
                  card.currency,
                ),
                caption: `de ${formatCurrency(card.card.limitCents, card.currency)}`,
              },
            ]
          : []),
      ]
    : [
        {
          label: 'Fatura aberta',
          value: overview.isError ? '—' : '…',
          caption: overview.isError
            ? errorMessage(overview.error, 'Faturas indisponíveis')
            : 'Calculando faturas',
        },
      ]
  return (
    <InstrumentCard
      title={formatInstrumentName(card.name)}
      subtitle={`${card.institutionName} · final ${card.card?.lastFour ?? '—'} · fecha dia ${card.card?.closingDay ?? '—'}, vence dia ${card.card?.dueDay ?? '—'}`}
      editLabel={`Editar ${formatInstrumentName(card.name)}`}
      onEdit={onEdit}
      metrics={metrics}
      status={
        <>
          {card.link ? (
            <StatusBadge tone="info">
              <Plug />
              Open Finance
            </StatusBadge>
          ) : null}
          {summary?.overdue ? (
            <StatusBadge tone="warning">Fatura vencida</StatusBadge>
          ) : null}
          {summary?.statementGaps.map((cycle) => (
            <StatusBadge key={cycle.closingOn} tone="warning">
              Fatura de {formatMonthLong(cycle.dueOn)} difere em{' '}
              {formatCurrency(
                Math.abs(cycle.statement?.differenceCents ?? 0),
                card.currency,
              )}
            </StatusBadge>
          ))}
        </>
      }
    />
  )
}

function CardFormFields({
  owners,
  card,
}: {
  owners: ReadonlyArray<Owner>
  card?: AccountView
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
          defaultValue={card?.institutionName ?? ''}
          required
        />
      </Field>
      {card ? null : (
        <>
          <Field>
            <FieldLabel htmlFor={`${prefix}-owner`}>Titular</FieldLabel>
            <NativeSelect
              id={`${prefix}-owner`}
              name="ownerId"
              className="w-full"
            >
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-currency`}>Moeda</FieldLabel>
            <NativeSelect
              id={`${prefix}-currency`}
              name="currency"
              className="w-full"
              defaultValue="BRL"
            >
              {currencyOptions.map((currency) => (
                <option key={currency.value} value={currency.value}>
                  {currency.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </>
      )}
      <Field>
        <FieldLabel htmlFor={`${prefix}-last-four`}>
          Últimos 4 dígitos
        </FieldLabel>
        <Input
          id={`${prefix}-last-four`}
          name="lastFour"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          defaultValue={card?.card?.lastFour ?? ''}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-limit`}>Limite</FieldLabel>
        <Input
          id={`${prefix}-limit`}
          name="limit"
          inputMode="decimal"
          placeholder="Opcional"
          defaultValue={
            card?.card?.limitCents != null
              ? formatMinorUnitsForInput(card.card.limitCents, card.currency)
              : ''
          }
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-closing`}>Dia de fechamento</FieldLabel>
        <Input
          id={`${prefix}-closing`}
          name="closingDay"
          type="number"
          min="1"
          max="31"
          defaultValue={card?.card?.closingDay ?? ''}
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
          defaultValue={card?.card?.dueDay ?? ''}
          required
        />
      </Field>
    </FieldGroup>
  )
}

function readTerms(form: FormData, currency: string) {
  const limit = String(form.get('limit') ?? '').trim()
  const lastFour = String(form.get('lastFour') ?? '').trim()
  return {
    closingDay: Number(form.get('closingDay')),
    dueDay: Number(form.get('dueDay')),
    limitCents: limit ? toMinorUnits(limit, currency) : null,
    lastFour: lastFour || null,
  }
}
