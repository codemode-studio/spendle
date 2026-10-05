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

import {
  EmptyState,
  Page,
  PageHeader,
  ProgressBar,
  StatusBadge,
} from '#/components/ui'
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
import { Switch } from '#/components/ui/switch'
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
import { formatShortDate, todayIso } from '#/domain/period'
import {
  classifyMovementFn,
  recordValuationFn,
  unclassifyMovementFn,
} from '#/features/v2/investments.functions'
import {
  accountsOptions,
  categoriesOptions,
  investmentsOptions,
  invalidateAfterReactors,
  monthOptions,
} from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'
import { cn } from '#/lib/utils'

import type { InvestmentsSnapshot, Position } from '@spendle/server/api'

type Movement = Position['movements'][number]

export function InvestmentsPage() {
  const { data } = useSuspenseQuery(investmentsOptions())
  const [query, setQuery] = useState('')
  const [assetClassId, setAssetClassId] = useState('all')
  const [showAll, setShowAll] = useState(false)
  const [entryOpen, setEntryOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Follow the position through refetches, so the sheet shows fresh values.
  const selected =
    data.positions.find((position) => position.id === selectedId) ?? null

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

      <PortfolioHeader data={data} />

      <Card className="mt-4 min-w-0">
        <CardHeader className="border-b">
          <div>
            <CardTitle>Carteira</CardTitle>
            <CardDescription>
              Valor em {formatShortDate(data.referenceDate)} e aportes líquidos
              por posição
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
              description="Classifique uma entrada da corretora para criar a primeira posição."
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
                    <TableHead className="hidden sm:table-cell">
                      Classe
                    </TableHead>
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
                      onSelect={() => setSelectedId(position.id)}
                    />
                  ))}
                </TableBody>
              </Table>
              {filtered.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                  Nenhuma posição encontrada. Limpe a busca ou troque a classe.
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
        position={selected}
        onOpenChange={(open) => !open && setSelectedId(null)}
      />
    </Page>
  )
}

/** Total invested, how it splits across asset classes, and the emergency reserve. */
function PortfolioHeader({ data }: { data: InvestmentsSnapshot }) {
  const { summary } = data
  const byClass = data.classes
    .map((assetClass) => ({
      ...assetClass,
      cents: data.positions
        .filter((position) => position.assetClassId === assetClass.id)
        .reduce((sum, position) => sum + (position.currentBrlCents ?? 0), 0),
    }))
    .filter((item) => item.cents > 0)
  const share = (cents: number) =>
    summary.totalBrlCents > 0
      ? Math.round((cents / summary.totalBrlCents) * 100)
      : 0
  return (
    <Card>
      <CardContent className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Patrimônio investido</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
            {formatCurrency(summary.totalBrlCents)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.positionCount}{' '}
            {summary.positionCount === 1 ? 'ativo' : 'ativos'} ·{' '}
            {summary.accountCount}{' '}
            {summary.accountCount === 1 ? 'conta' : 'contas'}
            {summary.missingQuoteCount > 0
              ? ` · ${summary.missingQuoteCount} sem cotação, fora do total`
              : ''}
          </p>
          {byClass.length > 0 ? (
            <div className="mt-4 max-w-2xl">
              <div
                className="flex h-2.5 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`Divisão por classe: ${byClass
                  .map((item) => `${item.name} ${share(item.cents)}%`)
                  .join(', ')}`}
              >
                {byClass.map((item) => (
                  <span
                    key={item.id}
                    style={{
                      width: `${(item.cents / summary.totalBrlCents) * 100}%`,
                      background: item.color,
                    }}
                  />
                ))}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {byClass.map((item) => (
                  <li key={item.id} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-2 rounded-full"
                      style={{ background: item.color }}
                    />
                    {item.name}{' '}
                    <span className="tabular-nums">{share(item.cents)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <ReserveProgress
          currentCents={summary.reserveBrlCents}
          positionCount={summary.reservePositionCount}
          shareOfPortfolio={share(summary.reserveBrlCents)}
        />
      </CardContent>
    </Card>
  )
}

/**
 * The emergency reserve the positions marked as reserve hold, against the
 * target the plan sets (the goal's own target, or months of essentials).
 */
function ReserveProgress({
  currentCents,
  positionCount,
  shareOfPortfolio,
}: {
  currentCents: number
  positionCount: number
  shareOfPortfolio: number
}) {
  const { data: month } = useSuspenseQuery(monthOptions())
  const targetCents = month.reserve.targetCents
  const percentage =
    targetCents > 0
      ? Math.min(100, Math.round((currentCents / targetCents) * 100))
      : 0
  const remaining = Math.max(0, targetCents - currentCents)
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-muted/35 px-5 py-4 lg:w-80">
      <Target
        className="mt-0.5 size-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-muted-foreground">Reserva de emergência</p>
        <p className="text-xl font-semibold tabular-nums">
          {formatCurrency(currentCents)}
          {targetCents > 0 ? (
            <span className="text-sm font-normal text-muted-foreground">
              {' '}
              de {formatCurrency(targetCents)}
            </span>
          ) : null}
        </p>
        {targetCents > 0 ? (
          <div className="mt-2">
            <ProgressBar value={currentCents} max={targetCents} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {percentage}%{' '}
              {remaining > 0
                ? `· faltam ${formatCurrency(remaining)}`
                : '· meta atingida'}
            </p>
          </div>
        ) : (
          <Link
            to="/planejamento"
            className="mt-1 inline-block text-xs text-primary hover:underline"
          >
            Definir a meta da reserva
          </Link>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {positionCount > 0
            ? `${positionCount} ${positionCount === 1 ? 'posição' : 'posições'} · ${shareOfPortfolio}% da carteira`
            : 'Marque uma posição como reserva ao criá-la'}
        </p>
      </div>
    </div>
  )
}

function PositionRow({
  position,
  onSelect,
}: {
  position: Position
  onSelect: () => void
}) {
  return (
    <TableRow>
      <TableCell className="pl-5">
        <button
          type="button"
          onClick={onSelect}
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
              {position.assetClassName} · {position.accountName}
            </span>
          </span>
        </button>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="text-muted-foreground">{position.assetClassName}</span>
        {position.reserve ? (
          <Badge variant="info" className="ml-2 hidden xl:inline-flex">
            Reserva
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">
        {position.accountName}
      </TableCell>
      <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
        {formatCurrency(position.contributedCents, position.currency)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="block font-medium">
          {formatCurrency(position.currentCents, position.currency)}
        </span>
        {position.currency !== 'BRL' && position.currentBrlCents !== null ? (
          <span className="block text-xs text-muted-foreground">
            ≈ {formatCurrency(position.currentBrlCents)}
          </span>
        ) : null}
        <span className="block text-[11px] text-muted-foreground">
          {position.valueKind === 'valuation' && position.valuedOn
            ? `informado em ${formatShortDate(position.valuedOn)}`
            : 'estimado pelos aportes'}
        </span>
      </TableCell>
      <TableCell
        className={cn(
          'hidden pr-5 text-right font-medium tabular-nums sm:table-cell',
          position.resultCents < 0 ? 'text-destructive' : 'text-success',
        )}
      >
        {position.valueKind === 'contributions' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `${position.resultCents >= 0 ? '+' : '−'}${formatCurrency(Math.abs(position.resultCents), position.currency)}`
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
  data: InvestmentsSnapshot
}) {
  const [entryId, setEntryId] = useState('')
  const [positionId, setPositionId] = useState('new')
  const [reserve, setReserve] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  // Swapping dialogs waits for this one to finish closing, or the new one
  // takes the closing click as a press outside and closes too.
  const [manualNext, setManualNext] = useState(false)
  const queryClient = useQueryClient()
  const classify = useServerFn(classifyMovementFn)
  const { data: accounts } = useSuspenseQuery(accountsOptions())
  const { data: categories } = useSuspenseQuery(categoriesOptions())
  const brokerageIds = new Set(data.accounts.map((account) => account.id))
  const brokerage = accounts.filter((account) => brokerageIds.has(account.id))
  const movement =
    data.available.find((item) => item.entryId === entryId) ?? null
  const compatible = movement
    ? data.positions.filter(
        (position) => position.accountId === movement.accountId,
      )
    : []
  const accountName = (id: string) =>
    data.accounts.find((account) => account.id === id)?.name ?? 'Conta'
  const reset = () => {
    setEntryId('')
    setPositionId('new')
    setReserve(false)
  }
  const mutation = useMutation({
    mutationFn: classify,
    onSuccess: () => {
      toast.success('Entrada classificada na carteira.')
      onOpenChange(false)
      reset()
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(
        errorMessage(error, 'Não foi possível classificar a entrada.'),
      ),
  })
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!movement) return
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      data:
        positionId === 'new'
          ? {
              entryId,
              newPosition: {
                name: String(form.get('name')).trim(),
                assetClassId: String(form.get('assetClassId')),
                reserve,
              },
            }
          : { entryId, positionId },
    })
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={(isOpen) => {
          if (isOpen || !manualNext) return
          setManualNext(false)
          setManualOpen(true)
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Nova entrada</DialogTitle>
              <DialogDescription>
                Coloque uma movimentação da corretora na posição que recebeu o
                dinheiro.
              </DialogDescription>
            </DialogHeader>
            {data.available.length === 0 ? (
              <EmptyState
                icon={WalletCards}
                title="Nenhuma movimentação livre"
                description={
                  brokerage.length
                    ? 'Registre o aporte ou o resgate na corretora, ou importe o extrato dela.'
                    : 'Cadastre uma conta do tipo corretora em Configurações.'
                }
                action={
                  brokerage.length ? (
                    <Button
                      type="button"
                      onClick={() => {
                        setManualNext(true)
                        onOpenChange(false)
                      }}
                    >
                      Registrar movimentação
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="investment-movement">
                    Movimentação
                  </FieldLabel>
                  <NativeSelect
                    id="investment-movement"
                    value={entryId}
                    onChange={(event) => {
                      setEntryId(event.target.value)
                      setPositionId('new')
                    }}
                    required
                  >
                    <NativeSelectOption value="">Selecione</NativeSelectOption>
                    {data.available.map((item) => (
                      <NativeSelectOption
                        key={item.entryId}
                        value={item.entryId}
                      >
                        {formatShortDate(item.bookedOn)} · {item.description} ·{' '}
                        {formatCurrency(item.amountCents, item.currency)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {brokerage.length ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto justify-start px-0"
                      onClick={() => {
                        setManualNext(true)
                        onOpenChange(false)
                      }}
                    >
                      Não está na lista? Registrar movimentação
                    </Button>
                  ) : null}
                </Field>
                {movement ? (
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
                        {compatible.map((position) => (
                          <NativeSelectOption
                            key={position.id}
                            value={position.id}
                          >
                            {position.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldDescription>
                        {accountName(movement.accountId)} ·{' '}
                        {movement.amountCents > 0 ? 'Aporte' : 'Resgate'} em{' '}
                        {movement.currency}
                        {movement.status === 'pending'
                          ? ' · conta quando o banco confirmar'
                          : ''}
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
                            minLength={2}
                            maxLength={100}
                            placeholder="Ex.: Tesouro Selic 2029"
                            required
                          />
                        </Field>
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
                        <Field orientation="horizontal">
                          <Switch
                            id="investment-reserve"
                            checked={reserve}
                            onCheckedChange={setReserve}
                          />
                          <FieldLabel htmlFor="investment-reserve">
                            Faz parte da reserva de emergência
                          </FieldLabel>
                        </Field>
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
              {data.available.length ? (
                <Button
                  type="submit"
                  disabled={!movement || mutation.isPending}
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
        accounts={brokerage}
        categories={categories.filter((category) => !category.system)}
        open={manualOpen}
        onOpenChange={setManualOpen}
        trigger={null}
        defaultDirection="inflow"
        onSaved={({ entryId: created }) => {
          // Back to classifying, with the movement just registered chosen.
          if (created) setEntryId(created)
          setPositionId('new')
          onOpenChange(true)
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
  const recordValuation = useServerFn(recordValuationFn)
  const unclassify = useServerFn(unclassifyMovementFn)
  const [removing, setRemoving] = useState<Movement | null>(null)
  const mutation = useMutation({
    mutationFn: recordValuation,
    onSuccess: () => {
      toast.success('Valor atual atualizado.')
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível atualizar.')),
  })
  const removal = useMutation({
    mutationFn: unclassify,
    onSuccess: (result) => {
      toast.success(
        result.positionDeleted
          ? 'Lançamento e posição removidos da carteira.'
          : 'Lançamento removido da carteira.',
      )
      setRemoving(null)
      if (result.positionDeleted) onOpenChange(false)
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(
        errorMessage(error, 'Não foi possível remover o lançamento.'),
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
          amountCents: toMinorUnits(
            String(form.get('amount')),
            position.currency,
          ),
          asOf: String(form.get('asOf')),
        },
      })
    } catch (error) {
      toast.error(errorMessage(error, 'Informe um valor válido.'))
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
                  {position.reserve ? ' · Reserva' : ''}
                </SheetDescription>
              </SheetHeader>
              <div className="grid min-w-0 grid-cols-1 gap-5 px-4 pb-6">
                <dl className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      Valor atual
                    </dt>
                    <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                      {formatCurrency(position.currentCents, position.currency)}
                    </dd>
                    <dd className="text-xs text-muted-foreground">
                      {position.valueKind === 'valuation' && position.valuedOn
                        ? `informado em ${formatShortDate(position.valuedOn)}`
                        : 'estimado pelos aportes'}
                      {position.currency !== 'BRL' &&
                      position.currentBrlCents !== null
                        ? ` · ≈ ${formatCurrency(position.currentBrlCents)}`
                        : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      Aportes líquidos
                    </dt>
                    <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-muted-foreground">
                      {formatCurrency(
                        position.contributedCents,
                        position.currency,
                      )}
                    </dd>
                    {position.openingCents ? (
                      <dd className="text-xs text-muted-foreground">
                        inclui{' '}
                        {formatCurrency(
                          position.openingCents,
                          position.currency,
                        )}{' '}
                        de abertura
                      </dd>
                    ) : null}
                  </div>
                </dl>
                <form
                  key={`${position.id}-${position.valuedOn ?? ''}-${position.currentCents}`}
                  onSubmit={submit}
                  className="grid gap-4 rounded-xl border p-4"
                >
                  <h3 className="font-medium">Informar valor atual</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="position-current-value">
                        Total em {position.currency}
                      </FieldLabel>
                      <Input
                        id="position-current-value"
                        name="amount"
                        inputMode="decimal"
                        defaultValue={formatMinorUnitsForInput(
                          position.currentCents,
                          position.currency,
                        )}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="position-current-date">
                        Em
                      </FieldLabel>
                      <Input
                        id="position-current-date"
                        name="asOf"
                        type="date"
                        defaultValue={todayIso()}
                        required
                      />
                    </Field>
                  </div>
                  <Button type="submit" disabled={mutation.isPending}>
                    {mutation.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    Salvar valor
                  </Button>
                </form>
                {position.movements.length ? (
                  <section>
                    <h3 className="mb-2 font-medium">Movimentações</h3>
                    <ul className="grid grid-cols-1 gap-2">
                      {position.movements.map((movement) => (
                        <li
                          key={movement.entryId}
                          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {movement.description}
                            </span>
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              {formatShortDate(movement.bookedOn)}
                              {movement.counted ? null : (
                                <StatusBadge tone="warning">
                                  {movement.status === 'pending'
                                    ? 'Provisória'
                                    : 'Agendada'}
                                </StatusBadge>
                              )}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <span
                              className={cn(
                                'font-medium tabular-nums',
                                !movement.counted && 'text-muted-foreground',
                              )}
                            >
                              {movement.amountCents > 0 ? '+' : '−'}
                              {formatCurrency(
                                Math.abs(movement.amountCents),
                                position.currency,
                              )}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Tirar ${movement.description} da carteira`}
                              title="Tirar da carteira"
                              onClick={() => setRemoving(movement)}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {position.valuations.length ? (
                  <section>
                    <h3 className="mb-2 font-medium">Valores informados</h3>
                    <ul className="divide-y rounded-lg border text-sm">
                      {position.valuations
                        .slice(0, 6)
                        .map((valuation, index) => (
                          <li
                            key={`${valuation.asOf}-${index}`}
                            className="flex justify-between px-3 py-2"
                          >
                            <span className="text-muted-foreground">
                              {formatShortDate(valuation.asOf)}
                            </span>
                            <span className="tabular-nums">
                              {formatCurrency(
                                valuation.amountCents,
                                position.currency,
                              )}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tirar da carteira?</AlertDialogTitle>
            <AlertDialogDescription>
              O lançamento continua em Transações e pode ser classificado de
              novo. Uma posição sem lançamentos, valores ou abertura também sai.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removal.isPending}
              onClick={() =>
                removing &&
                removal.mutate({ data: { entryId: removing.entryId } })
              }
            >
              {removal.isPending ? <Spinner data-icon="inline-start" /> : null}
              Tirar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
