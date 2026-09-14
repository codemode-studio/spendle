import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Plus, Search, Target, Trash2, WalletCards } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { EmptyState, Page, PageHeader, ProgressBar } from '#/components/ui'
import { ManualTransactionDialog } from '#/components/manual-transaction-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#/components/ui/sheet'
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
  formatCurrency,
  formatMinorUnitsForInput,
  toMinorUnits,
} from '#/domain/currency'
import { formatShortDate } from '#/domain/period'
import { invalidateFinance } from '#/features/finance/queries'

import {
  classifyInvestmentTransactionFn,
  deleteInvestmentMovementFn,
  updateInvestmentPositionValueFn,
} from './investments.functions'
import type { getInvestmentsSnapshotFn } from './investments.functions'
import { investmentQueryKeys, investmentsOptions } from './queries'

type Snapshot = Awaited<ReturnType<typeof getInvestmentsSnapshotFn>>
type Position = Snapshot['positions'][number]

export function InvestmentsPage() {
  const { data } = useSuspenseQuery(investmentsOptions())
  const [query, setQuery] = useState('')
  const [assetClassId, setAssetClassId] = useState('all')
  const [showAll, setShowAll] = useState(false)
  const [entryOpen, setEntryOpen] = useState(false)
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(
    null,
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('pt-BR')
    return data.positions.filter(
      (position) =>
        (assetClassId === 'all' || position.assetClassId === assetClassId) &&
        `${position.name} ${position.symbol ?? ''} ${position.accountName}`
          .toLocaleLowerCase('pt-BR')
          .includes(needle),
    )
  }, [assetClassId, data.positions, query])
  const visible = showAll ? filtered : filtered.slice(0, 8)

  return (
    <Page>
      <PageHeader
        title="Investimentos"
        actions={
          <Button onClick={() => setEntryOpen(true)}>
            <Plus data-icon="inline-start" />
            Nova entrada
          </Button>
        }
      />

      <StrategyHeader data={data} />

      <Card className="mt-4 min-w-0">
        <CardHeader className="border-b">
          <div>
            <CardTitle>Carteira</CardTitle>
            <CardDescription>
              Valor atual e aportes líquidos por posição
            </CardDescription>
          </div>
          <div className="col-span-full mt-2 flex flex-col gap-2 sm:flex-row">
            <label className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <span className="sr-only">Buscar ativo ou conta</span>
              <Search
                aria-hidden="true"
                className="ml-3 size-4 shrink-0 text-muted-foreground md:ml-2.5"
              />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setShowAll(false)
                }}
                placeholder="Buscar ativo ou conta"
                className="border-0 bg-transparent pl-2 shadow-none focus-visible:ring-0"
              />
            </label>
            <NativeSelect
              aria-label="Filtrar por classe"
              value={assetClassId}
              onChange={(event) => {
                setAssetClassId(event.target.value)
                setShowAll(false)
              }}
              className="sm:w-52"
            >
              <NativeSelectOption value="all">
                Todas as classes
              </NativeSelectOption>
              {data.classes.map((assetClass) => (
                <NativeSelectOption key={assetClass.id} value={assetClass.id}>
                  {assetClass.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {data.positions.length === 0 ? (
            <EmptyState
              icon={WalletCards}
              title="Nenhuma posição cadastrada"
              description="Classifique uma entrada de corretora para criar a primeira posição."
              action={
                <Button onClick={() => setEntryOpen(true)}>Nova entrada</Button>
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Ativo</TableHead>
                    <TableHead>Classe</TableHead>
                    <TableHead className="hidden lg:table-cell">
                      Conta
                    </TableHead>
                    <TableHead className="hidden text-right md:table-cell">
                      Aportes líquidos
                    </TableHead>
                    <TableHead className="text-right">Valor atual</TableHead>
                    <TableHead className="hidden w-28 pr-5 text-right sm:table-cell">
                      Resultado
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((position) => (
                    <PositionRow
                      key={position.id}
                      position={position}
                      onSelect={setSelectedPosition}
                    />
                  ))}
                </TableBody>
              </Table>
              {filtered.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                  Nenhuma posição encontrada.
                </div>
              ) : (
                <div className="flex flex-col gap-3 border-t px-5 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    Mostrando {visible.length} de {filtered.length} posições
                  </span>
                  {filtered.length > 8 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAll((current) => !current)}
                    >
                      {showAll
                        ? 'Mostrar menos'
                        : `Mostrar todas (${filtered.length})`}
                    </Button>
                  ) : null}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <NewEntryDialog
        open={entryOpen}
        onOpenChange={setEntryOpen}
        data={data}
      />
      <PositionSheet
        position={selectedPosition}
        onOpenChange={(open) => !open && setSelectedPosition(null)}
      />
    </Page>
  )
}

function StrategyHeader({ data }: { data: Snapshot }) {
  const { summary } = data
  const ratio =
    summary.reserveTargetCents > 0
      ? Math.min(1, summary.reserveCurrentCents / summary.reserveTargetCents)
      : 0
  const percentage = Math.round(ratio * 100)
  const remaining = Math.max(
    0,
    summary.reserveTargetCents - summary.reserveCurrentCents,
  )
  return (
    <Card>
      <CardContent className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Target className="size-4" aria-hidden="true" />
            Reserva de emergência
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-2">
            <p className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
              {formatCurrency(summary.reserveCurrentCents)}
            </p>
          </div>
          {summary.reserveTargetCents > 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Meta de {formatCurrency(summary.reserveTargetCents)} · faltam{' '}
              {formatCurrency(remaining)}
            </p>
          ) : (
            <Link
              to="/configuracoes"
              search={{ tab: 'orcamento' }}
              className="mt-1 inline-block text-sm text-primary hover:underline"
            >
              Definir meta da reserva
            </Link>
          )}
          <div className="mt-4 max-w-2xl">
            <ProgressBar
              value={summary.reserveCurrentCents}
              max={summary.reserveTargetCents}
            />
            <div className="mt-2 flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{formatCurrency(summary.reserveCurrentCents)}</span>
              <span>{formatCurrency(summary.reserveTargetCents)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-5 rounded-2xl bg-muted/35 px-5 py-4">
          <div
            aria-label={`${percentage}% da reserva concluída`}
            className="grid size-28 shrink-0 place-items-center rounded-full"
            style={{
              background: `conic-gradient(var(--primary) ${percentage * 3.6}deg, var(--muted) 0)`,
            }}
          >
            <div className="grid size-20 place-items-center rounded-full bg-card text-center">
              <span>
                <strong className="block text-xl tabular-nums">
                  {percentage}%
                </strong>
                <small className="text-muted-foreground">concluído</small>
              </span>
            </div>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-1">
            <div>
              <dt className="text-xs text-muted-foreground">Patrimônio</dt>
              <dd className="font-semibold tabular-nums">
                {formatCurrency(summary.totalCents)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Carteira</dt>
              <dd>
                {summary.positionCount}{' '}
                {summary.positionCount === 1 ? 'ativo' : 'ativos'} ·{' '}
                {summary.accountCount}{' '}
                {summary.accountCount === 1 ? 'conta' : 'contas'}
              </dd>
            </div>
          </dl>
        </div>
      </CardContent>
    </Card>
  )
}

function PositionRow({
  position,
  onSelect,
}: {
  position: Position
  onSelect: (position: Position) => void
}) {
  return (
    <TableRow>
      <TableCell className="pl-5">
        <button
          type="button"
          onClick={() => onSelect(position)}
          className="flex max-w-64 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: position.color }}
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">{position.name}</span>
            <span className="block truncate text-xs text-muted-foreground sm:hidden">
              {position.accountName}
            </span>
          </span>
        </button>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{position.assetClassName}</span>
        {position.goalName ? (
          <Badge variant="info" className="ml-2 hidden xl:inline-flex">
            Reserva
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">
        {position.accountName}
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
        {formatCurrency(position.contributionAmountMinor, position.currency)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="block font-medium">
          {formatCurrency(position.currentAmountMinor, position.currency)}
        </span>
        {position.currency !== 'BRL' && position.currentBaseCents !== null ? (
          <span className="block text-xs text-muted-foreground">
            ≈ {formatCurrency(position.currentBaseCents)}
          </span>
        ) : null}
        {position.valueKind === 'estimated' ? (
          <span className="block text-[11px] text-muted-foreground">
            estimado pelos aportes
          </span>
        ) : null}
      </TableCell>
      <TableCell
        className={`hidden pr-5 text-right font-medium tabular-nums sm:table-cell ${position.resultBaseCents !== null && position.resultBaseCents < 0 ? 'text-destructive' : 'text-success'}`}
      >
        {position.resultBaseCents === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${position.resultBaseCents >= 0 ? '+' : '−'}${formatCurrency(Math.abs(position.resultBaseCents))}`
        )}
      </TableCell>
    </TableRow>
  )
}

function NewEntryDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: Snapshot
}) {
  const [transactionId, setTransactionId] = useState('')
  const [positionId, setPositionId] = useState('new')
  const [manualTransactionOpen, setManualTransactionOpen] = useState(false)
  const queryClient = useQueryClient()
  const classify = useServerFn(classifyInvestmentTransactionFn)
  const transaction =
    data.availableTransactions.find((item) => item.id === transactionId) ?? null
  const compatiblePositions = transaction
    ? data.positions.filter(
        (position) =>
          position.accountId === transaction.accountId &&
          position.currency === transaction.currency,
      )
    : []
  const mutation = useMutation({
    mutationFn: classify,
    onSuccess: () => {
      toast.success('Entrada classificada na carteira.')
      onOpenChange(false)
      setTransactionId('')
      setPositionId('new')
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: investmentQueryKeys.all }),
        invalidateFinance(queryClient, 'ledger'),
      ])
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível classificar a entrada.',
      ),
  })
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!transaction) return
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      data:
        positionId === 'new'
          ? {
              transactionId,
              newPosition: {
                name: String(form.get('name')),
                assetClassId: String(form.get('assetClassId')),
                goalId: String(form.get('goalId') || '') || undefined,
              },
            }
          : { transactionId, positionId },
    })
  }
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Nova entrada</DialogTitle>
              <DialogDescription>
                Vincule uma movimentação real da corretora à posição que recebeu
                o dinheiro.
              </DialogDescription>
            </DialogHeader>
            {data.availableTransactions.length === 0 ? (
              <EmptyState
                icon={WalletCards}
                title="Nenhuma movimentação disponível"
                description="Registre uma entrada ou um resgate em uma conta de investimentos."
                action={
                  <Button
                    type="button"
                    onClick={() => {
                      onOpenChange(false)
                      setManualTransactionOpen(true)
                    }}
                  >
                    Nova transação
                  </Button>
                }
              />
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="investment-transaction">
                    Movimentação
                  </FieldLabel>
                  <NativeSelect
                    id="investment-transaction"
                    value={transactionId}
                    onChange={(event) => {
                      setTransactionId(event.target.value)
                      setPositionId('new')
                    }}
                    required
                  >
                    <NativeSelectOption value="">Selecione</NativeSelectOption>
                    {data.availableTransactions.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {item.postedAt} · {item.description} ·{' '}
                        {formatCurrency(item.amountMinor, item.currency)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                {transaction ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="investment-position">
                        Posição
                      </FieldLabel>
                      <NativeSelect
                        id="investment-position"
                        value={positionId}
                        onChange={(event) => setPositionId(event.target.value)}
                      >
                        <NativeSelectOption value="new">
                          Nova posição
                        </NativeSelectOption>
                        {compatiblePositions.map((position) => (
                          <NativeSelectOption
                            key={position.id}
                            value={position.id}
                          >
                            {position.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldDescription>
                        {transaction.accountName} ·{' '}
                        {transaction.kind === 'contribution'
                          ? 'Aporte'
                          : 'Resgate'}{' '}
                        em {transaction.currency}
                      </FieldDescription>
                    </Field>
                    {positionId === 'new' ? (
                      <>
                        <Field>
                          <FieldLabel htmlFor="investment-name">
                            Nome do ativo
                          </FieldLabel>
                          <Input
                            id="investment-name"
                            name="name"
                            placeholder="Ex.: Tesouro Selic 2029"
                            required
                          />
                        </Field>
                        <FieldGroup className="grid gap-4 sm:grid-cols-2">
                          <Field>
                            <FieldLabel htmlFor="investment-class">
                              Classe
                            </FieldLabel>
                            <NativeSelect
                              id="investment-class"
                              name="assetClassId"
                              required
                            >
                              {data.classes.map((assetClass) => (
                                <NativeSelectOption
                                  key={assetClass.id}
                                  value={assetClass.id}
                                >
                                  {assetClass.name}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="investment-goal">
                              Objetivo
                            </FieldLabel>
                            <NativeSelect id="investment-goal" name="goalId">
                              <NativeSelectOption value="">
                                Sem objetivo
                              </NativeSelectOption>
                              {data.goals.map((goal) => (
                                <NativeSelectOption
                                  key={goal.id}
                                  value={goal.id}
                                >
                                  {goal.name}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </Field>
                        </FieldGroup>
                      </>
                    ) : null}
                  </>
                ) : null}
              </FieldGroup>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              {data.availableTransactions.length ? (
                <Button
                  type="submit"
                  disabled={!transaction || mutation.isPending}
                >
                  {mutation.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  Classificar entrada
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ManualTransactionDialog
        accounts={data.brokerageAccounts}
        cards={[]}
        categories={data.categories}
        open={manualTransactionOpen}
        onOpenChange={(nextOpen) => {
          setManualTransactionOpen(nextOpen)
          if (!nextOpen) onOpenChange(true)
        }}
        trigger={null}
        defaultDirection="inflow"
        onCreated={(createdTransactionId) => {
          setTransactionId(createdTransactionId)
          setPositionId('new')
          void queryClient.invalidateQueries({
            queryKey: investmentQueryKeys.all,
          })
        }}
      />
    </>
  )
}

function PositionSheet({
  position,
  onOpenChange,
}: {
  position: Position | null
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const updateValue = useServerFn(updateInvestmentPositionValueFn)
  const deleteMovement = useServerFn(deleteInvestmentMovementFn)
  const [deletingMovement, setDeletingMovement] = useState<
    Position['movements'][number] | null
  >(null)
  const mutation = useMutation({
    mutationFn: updateValue,
    onSuccess: () => {
      toast.success('Valor atual atualizado.')
      onOpenChange(false)
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: investmentQueryKeys.all }),
        invalidateFinance(queryClient, 'ledger'),
      ])
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível atualizar.',
      ),
  })
  const deleteMutation = useMutation({
    mutationFn: deleteMovement,
    onSuccess: () => {
      toast.success('Lançamento removido da carteira.')
      setDeletingMovement(null)
      onOpenChange(false)
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: investmentQueryKeys.all }),
        invalidateFinance(queryClient, 'ledger'),
      ])
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível excluir o lançamento.',
      ),
  })
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!position) return
    const form = new FormData(event.currentTarget)
    try {
      mutation.mutate({
        data: {
          positionId: position.id,
          amountMinor: toMinorUnits(
            String(form.get('amount')),
            position.currency,
          ),
          asOf: String(form.get('asOf')),
        },
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Informe um valor válido.',
      )
    }
  }
  return (
    <>
      <Sheet open={Boolean(position)} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="min-w-0 overflow-x-hidden overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {position ? (
            <>
              <SheetHeader className="border-b">
                <SheetTitle>{position.name}</SheetTitle>
                <SheetDescription>
                  {position.assetClassName} · {position.accountName}
                </SheetDescription>
              </SheetHeader>
              <div className="grid min-w-0 grid-cols-1 gap-5 px-4">
                <div>
                  <p className="text-sm text-muted-foreground">Valor atual</p>
                  <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                    {formatCurrency(
                      position.currentAmountMinor,
                      position.currency,
                    )}
                  </p>
                  {position.currency !== 'BRL' &&
                  position.currentBaseCents !== null ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      ≈ {formatCurrency(position.currentBaseCents)}
                    </p>
                  ) : null}
                </div>
                <form
                  onSubmit={submit}
                  className="grid gap-4 rounded-xl border p-4"
                >
                  <div>
                    <h3 className="font-medium">Atualizar valor</h3>
                    <p className="text-sm text-muted-foreground">
                      Informe o total atual da posição em {position.currency}.
                    </p>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="position-current-value">
                      Valor em {position.currency}
                    </FieldLabel>
                    <Input
                      id="position-current-value"
                      name="amount"
                      inputMode="decimal"
                      defaultValue={formatMinorUnitsForInput(
                        position.currentAmountMinor,
                        position.currency,
                      )}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="position-current-date">
                      Data
                    </FieldLabel>
                    <Input
                      id="position-current-date"
                      name="asOf"
                      type="date"
                      defaultValue={
                        position.currentAt ??
                        new Date().toISOString().slice(0, 10)
                      }
                      required
                    />
                  </Field>
                  <Button type="submit" disabled={mutation.isPending}>
                    {mutation.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    Salvar valor atual
                  </Button>
                </form>
                {position.movements.length ? (
                  <div>
                    <h3 className="mb-2 font-medium">Movimentações</h3>
                    <div className="grid grid-cols-1 gap-2">
                      {position.movements.map((movement) => (
                        <div
                          key={movement.id}
                          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {movement.transaction.description}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatShortDate(movement.transaction.postedAt)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <span className="font-medium tabular-nums">
                              {movement.kind === 'contribution' ? '+' : '−'}
                              {formatCurrency(
                                movement.amountMinor,
                                position.currency,
                              )}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Excluir lançamento ${movement.transaction.description}`}
                              title="Excluir lançamento"
                              onClick={() => setDeletingMovement(movement)}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={Boolean(deletingMovement)}
        onOpenChange={(open) => !open && setDeletingMovement(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir lançamento?</AlertDialogTitle>
            <AlertDialogDescription>
              O vínculo com a carteira será removido. A transação continuará em
              Transações e poderá ser classificada novamente. Se este for o
              único lançamento, a posição também será removida.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deletingMovement &&
                deleteMutation.mutate({
                  data: { movementId: deletingMovement.id },
                })
              }
            >
              {deleteMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
