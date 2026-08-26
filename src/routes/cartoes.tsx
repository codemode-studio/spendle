import { CalendarDays, CreditCard, Pencil, Plus } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'
import { useState } from 'react'

import {
  EmptyState,
  PageHeader,
  Panel,
  ProgressBar,
  StatusBadge,
} from '#/components/ui'
import { BalanceCheckpointDialog } from '#/components/balance-checkpoint-dialog'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
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
import {
  currencyOptions,
  formatCurrency,
  formatDate,
  formatMinorUnitsForInput,
  formatInstrumentName,
  parseCurrency,
  toCents,
} from '#/domain/finance'
import {
  createCreditCardFn,
  updateCreditCardFn,
} from '#/features/finance/finance.functions'
import {
  financeQueryKeys,
  financeSnapshotOptions,
} from '#/features/finance/queries'

export const Route = createFileRoute('/cartoes')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(financeSnapshotOptions()),
  component: CardsPage,
})

function CardsPage() {
  const { data } = useSuspenseQuery(financeSnapshotOptions())
  const queryClient = useQueryClient()
  const createCard = useServerFn(createCreditCardFn)
  const updateCard = useServerFn(updateCreditCardFn)
  const [error, setError] = useState('')
  const [addCardOpen, setAddCardOpen] = useState(false)
  const [editingCardId, setEditingCardId] = useState<string | null>(null)
  const editingCard = data.cards.find((card) => card.id === editingCardId)
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
  const cardMutation = useMutation({
    mutationFn: createCard,
    onSuccess: () => {
      toast.success('Cartão adicionado.')
      setAddCardOpen(false)
      invalidate()
    },
    onError: (reason) => {
      const message =
        reason instanceof Error ? reason.message : 'Erro ao salvar.'
      setError(message)
      toast.error(message)
    },
  })
  const updateCardMutation = useMutation({
    mutationFn: updateCard,
    onSuccess: () => {
      toast.success('Cartão atualizado.')
      setEditingCardId(null)
      invalidate()
    },
    onError: (reason) => {
      const message =
        reason instanceof Error ? reason.message : 'Erro ao atualizar.'
      setError(message)
      toast.error(message)
    },
  })

  function submitCard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const lastFour = String(form.get('lastFour') || '')
    const currency = parseCurrency(String(form.get('currency')))
    cardMutation.mutate({
      data: {
        name: String(form.get('name')),
        institutionName: String(form.get('institutionName')),
        ownershipScopeId: String(form.get('ownershipScopeId')),
        currency,
        lastFour: lastFour || undefined,
        limitCents: toCents(String(form.get('limit')), currency),
        closingDay: Number(form.get('closingDay')),
        dueDay: Number(form.get('dueDay')),
      },
    })
  }

  function submitCardEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingCard) return
    setError('')
    const form = new FormData(event.currentTarget)
    const lastFour = String(form.get('lastFour') || '')
    const currency = parseCurrency(String(form.get('currency')))
    updateCardMutation.mutate({
      data: {
        id: editingCard.id,
        name: String(form.get('name')),
        institutionName: String(form.get('institutionName')),
        ownershipScopeId: String(form.get('ownershipScopeId')),
        currency,
        lastFour: lastFour || undefined,
        limitCents: toCents(String(form.get('limit')), currency),
        closingDay: Number(form.get('closingDay')),
        dueDay: Number(form.get('dueDay')),
      },
    })
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Faturas"
        title="Cartões"
        description="Acompanhe faturas, limites e parcelas."
        actions={
          <Button
            type="button"
            onClick={() => {
              setError('')
              setAddCardOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Cartão
          </Button>
        }
      />
      <Dialog
        open={addCardOpen}
        onOpenChange={(open) => {
          if (!cardMutation.isPending) setAddCardOpen(open)
          if (!open) setError('')
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submitCard} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar cartão</DialogTitle>
              <DialogDescription>
                Cadastre o cartão para importar compras e acompanhar faturas.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Nome</FieldLabel>
                <Input name="name" placeholder="Cartão principal" required />
              </Field>
              <Field>
                <FieldLabel>Instituição</FieldLabel>
                <Input name="institutionName" required />
              </Field>
              <Field>
                <FieldLabel>Proprietário</FieldLabel>
                <NativeSelect name="ownershipScopeId" className="w-full">
                  {data.scopes.map((scope) => (
                    <option key={scope.id} value={scope.id}>
                      {scope.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Últimos 4 dígitos</FieldLabel>
                <Input name="lastFour" inputMode="numeric" maxLength={4} />
              </Field>
              <Field>
                <FieldLabel>Limite</FieldLabel>
                <Input name="limit" defaultValue="0,00" required />
              </Field>
              <Field>
                <FieldLabel>Moeda</FieldLabel>
                <NativeSelect name="currency" className="w-full">
                  {currencyOptions.map((currency) => (
                    <option key={currency.value} value={currency.value}>
                      {currency.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Dia de fechamento</FieldLabel>
                <Input
                  name="closingDay"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue="1"
                />
              </Field>
              <Field>
                <FieldLabel>Dia de vencimento</FieldLabel>
                <Input
                  name="dueDay"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue="10"
                />
              </Field>
            </FieldGroup>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={cardMutation.isPending}>
                {cardMutation.isPending ? 'Salvando…' : 'Salvar cartão'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {error && !addCardOpen && (
        <FieldError className="mb-3">{error}</FieldError>
      )}
      {data.cards.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {data.cards.map((card) => (
            <Card key={card.id}>
              <CardHeader>
                <CardTitle>{formatInstrumentName(card.name)}</CardTitle>
                <CardDescription>
                  {card.institution?.name} · final {card.lastFour ?? '—'}
                </CardDescription>
                <CardAction>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Editar ${formatInstrumentName(card.name)}`}
                      onClick={() => setEditingCardId(card.id)}
                    >
                      <Pencil />
                    </Button>
                    <CreditCard className="size-5 text-primary" />
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">
                      Fatura atual
                    </span>
                    <strong className="font-mono text-xl tabular-nums">
                      {formatCurrency(card.statementCents, card.currency)}
                    </strong>
                    <span className="text-xs text-muted-foreground">
                      {card.dueDayEstimated
                        ? 'Vencimento será confirmado na primeira fatura'
                        : `Vence ${formatDate(card.currentStatement.dueDate)}`}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 border-l border-border pl-4">
                    <span className="text-xs text-muted-foreground">
                      Próxima fatura
                    </span>
                    <strong className="font-mono text-xl tabular-nums">
                      {formatCurrency(
                        card.nextStatement?.amountCents ?? 0,
                        card.currency,
                      )}
                    </strong>
                    <span className="text-xs text-muted-foreground">
                      {card.nextStatement
                        ? `Vence ${formatDate(card.nextStatement.dueDate)}`
                        : 'Sem lançamentos previstos'}
                    </span>
                  </div>
                </div>
                <ProgressBar
                  value={card.outstandingCents}
                  max={card.limitCents}
                  className="mt-4"
                />
                <div className="mt-4 grid gap-2 border-t pt-4 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <span>Atualizada até</span>
                    <StatusBadge
                      tone={
                        card.coverage.freshness.status === 'current'
                          ? 'success'
                          : card.coverage.freshness.status === 'recommended'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {card.coverage.latestCoverageEnd
                        ? formatDate(card.coverage.latestCoverageEnd)
                        : 'Sem cobertura'}
                    </StatusBadge>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Fatura conferida em</span>
                    <span className="font-medium text-foreground">
                      {card.latestVerifiedCheckpoint
                        ? formatDate(card.latestVerifiedCheckpoint.asOf)
                        : 'Ainda não'}
                    </span>
                  </div>
                  {card.unverifiedDays > 0 ? (
                    <p>
                      {card.unverifiedDays}{' '}
                      {card.unverifiedDays === 1
                        ? 'dia coberto ainda não foi conferido'
                        : 'dias cobertos ainda não foram conferidos'}{' '}
                      por uma fatura fechada.
                    </p>
                  ) : null}
                  {card.latestCheckpoint?.reviewState === 'observed' ? (
                    <p>
                      Total registrado em{' '}
                      {formatDate(card.latestCheckpoint.asOf)}; a fatura ainda
                      não foi reconciliada.
                    </p>
                  ) : null}
                  {card.coverage.gaps.length ? (
                    <div className="grid gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-warning">
                      <p className="font-medium">Período ausente</p>
                      {card.coverage.gaps.map((gap) => (
                        <p key={`${gap.start}-${gap.end}`}>
                          Importe a fatura ou atividade de{' '}
                          {formatDate(gap.start)} a {formatDate(gap.end)}.
                        </p>
                      ))}
                      <Button
                        nativeButton={false}
                        variant="outline"
                        size="sm"
                        className="mt-1 w-fit"
                        render={
                          <Link to="/importar" search={{ view: 'upload' }} />
                        }
                      >
                        Importar período ausente
                      </Button>
                    </div>
                  ) : null}
                </div>
              </CardContent>
              <CardFooter className="justify-between gap-3 border-border">
                <BalanceCheckpointDialog
                  targetType="card"
                  targetId={card.id}
                  targetName={formatInstrumentName(card.name)}
                  targetCurrency={card.currency}
                />
                <StatusBadge>
                  {formatCurrency(card.availableLimitCents, card.currency)}{' '}
                  livre
                </StatusBadge>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <Panel>
          <EmptyState
            icon={CreditCard}
            title="Nenhum cartão cadastrado"
            description="Cadastre seus cartões para organizar faturas e identificar pagamentos automaticamente."
          />
        </Panel>
      )}
      <Dialog
        open={Boolean(editingCard)}
        onOpenChange={(open) => {
          if (!open && !updateCardMutation.isPending) setEditingCardId(null)
        }}
      >
        {editingCard && (
          <DialogContent className="sm:max-w-lg">
            <form onSubmit={submitCardEdit} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Editar cartão</DialogTitle>
                <DialogDescription>
                  Atualize os dados usados no limite e no calendário de faturas.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Nome</FieldLabel>
                  <Input name="name" defaultValue={editingCard.name} required />
                </Field>
                <Field>
                  <FieldLabel>Instituição</FieldLabel>
                  <Input
                    name="institutionName"
                    defaultValue={editingCard.institution?.name ?? ''}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel>Proprietário</FieldLabel>
                  <NativeSelect
                    name="ownershipScopeId"
                    className="w-full"
                    defaultValue={editingCard.ownershipScopeId}
                  >
                    {data.scopes.map((scope) => (
                      <option key={scope.id} value={scope.id}>
                        {scope.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel>Últimos 4 dígitos</FieldLabel>
                  <Input
                    name="lastFour"
                    inputMode="numeric"
                    maxLength={4}
                    defaultValue={editingCard.lastFour ?? ''}
                  />
                </Field>
                <Field>
                  <FieldLabel>Limite</FieldLabel>
                  <Input
                    name="limit"
                    defaultValue={formatMinorUnitsForInput(
                      editingCard.limitCents,
                      editingCard.currency,
                    )}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel>Moeda</FieldLabel>
                  <NativeSelect
                    name="currency"
                    className="w-full"
                    defaultValue={editingCard.currency}
                  >
                    {currencyOptions.map((currency) => (
                      <option key={currency.value} value={currency.value}>
                        {currency.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel>Dia de fechamento</FieldLabel>
                  <Input
                    name="closingDay"
                    type="number"
                    min="1"
                    max="31"
                    defaultValue={editingCard.closingDay}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel>Dia de vencimento</FieldLabel>
                  <Input
                    name="dueDay"
                    type="number"
                    min="1"
                    max="31"
                    defaultValue={editingCard.dueDay ?? ''}
                    required
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  Cancelar
                </DialogClose>
                <Button type="submit" disabled={updateCardMutation.isPending}>
                  {updateCardMutation.isPending
                    ? 'Salvando…'
                    : 'Salvar alterações'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
      {data.cards.some((card) => card.upcomingStatements.length > 0) && (
        <Panel
          title="Calendário de faturas"
          description="Compras importadas e parcelas projetadas por vencimento."
          className="mt-[18px]"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cartão</TableHead>
                <TableHead>Fechamento</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Lançamentos</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.cards.flatMap((card) =>
                card.upcomingStatements.map((statement) => (
                  <TableRow key={`${card.id}-${statement.dueDate}`}>
                    <TableCell className="font-medium">
                      {formatInstrumentName(card.name)}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <CalendarDays className="size-4" />
                        {formatDate(statement.closingDate)}
                      </span>
                    </TableCell>
                    <TableCell>{formatDate(statement.dueDate)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {statement.transactionCount} confirmados
                      {statement.projectedInstallmentCount > 0 &&
                        ` · ${statement.projectedInstallmentCount} parcelas previstas`}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCurrency(statement.amountCents, card.currency)}
                    </TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </Panel>
      )}
      {data.installmentPlans.length > 0 && (
        <Panel
          title="Parcelas futuras"
          description="Compromissos já assumidos nos cartões."
          className="mt-[18px]"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Descrição</TableHead>
                <TableHead>Cartão</TableHead>
                <TableHead>Progresso</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Parcela</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.installmentPlans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell>{plan.description}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {
                      data.cards.find((card) => card.id === plan.creditCardId)
                        ?.name
                    }
                  </TableCell>
                  <TableCell>
                    {plan.currentInstallment}/{plan.totalInstallments}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={plan.autoDetected ? 'info' : 'neutral'}>
                      {plan.autoDetected ? 'Detectada' : 'Manual'}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="font-mono">
                    {formatCurrency(
                      plan.installmentAmountCents,
                      data.cards.find((card) => card.id === plan.creditCardId)
                        ?.currency,
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </div>
  )
}
