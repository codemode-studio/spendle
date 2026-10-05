import {
  ArrowLeftRight,
  CalendarDays,
  Check,
  Layers,
  Link2,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import {
  createFileRoute,
  Link,
  stripSearchParams,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Fragment, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import type { DateRange } from 'react-day-picker'
import { toast } from 'sonner'

import {
  EmptyState,
  Page,
  PageHeader,
  Panel,
  StatusBadge,
} from '#/components/ui'
import { CategorySelect } from '#/components/category-select'
import { SegmentedControl } from '#/components/segmented-control'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Calendar } from '#/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Input } from '#/components/ui/input'
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '#/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { groupCategoryOptions } from '#/domain/categories'
import { formatCurrency } from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatDayLabel, formatLongDate, formatPeriod } from '#/domain/period'
import {
  parseAmountInput,
  transactionSearchDefaults,
  transactionSearchSchema,
  transactionSearchToFilters,
} from '#/features/finance/transactions.search'
import {
  LinkEntryDialog,
  ReconciliationReview,
} from '#/features/finance/reconciliation-review'
import { accountOptionLabel } from '#/features/v2/accounts'
import {
  confirmCategoryFn,
  correctCategoryFn,
  decideCategoryFn,
} from '#/features/v2/entries.functions'
import {
  accountsOptions,
  categoriesOptions,
  entriesPageOptions,
  entryCountsOptions,
  invalidateAfterReactors,
  orphanedDecisionsOptions,
  patchEntryCategory,
  relationsOptions,
} from '#/features/v2/queries'
import { useIsMobile } from '#/hooks/use-mobile'
import { errorMessage } from '#/lib/v2/errors'
import { cn } from '#/lib/utils'

import type { Category, Entry } from '@spendle/server/api'

export const Route = createFileRoute('/transacoes')({
  validateSearch: transactionSearchSchema,
  search: { middlewares: [stripSearchParams(transactionSearchDefaults)] },
  loaderDeps: ({ search }) => transactionSearchToFilters(search),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(entriesPageOptions(deps)),
      context.queryClient.ensureQueryData(entryCountsOptions()),
      context.queryClient.ensureQueryData(categoriesOptions(true)),
      context.queryClient.ensureQueryData(accountsOptions(true)),
      context.queryClient.ensureQueryData(relationsOptions()),
      context.queryClient.ensureQueryData(orphanedDecisionsOptions()),
    ]),
  component: TransactionsPage,
})

function TransactionsPage() {
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const decideCategory = useServerFn(decideCategoryFn)
  const correctCategory = useServerFn(correctCategoryFn)
  const confirmCategory = useServerFn(confirmCategoryFn)
  const [linking, setLinking] = useState<Entry | null>(null)
  const urlState = Route.useSearch()
  const navigate = Route.useNavigate()
  const setUrlState = (
    updates: Partial<typeof urlState> | null,
    options?: { replace: boolean },
  ) =>
    navigate({
      search: (previous) =>
        updates === null
          ? transactionSearchDefaults
          : { ...previous, ...updates },
      replace: options?.replace,
      resetScroll: false,
    })
  const {
    search,
    target,
    direction,
    minAmount,
    maxAmount,
    dateFrom,
    dateTo,
    category,
  } = urlState
  const decisionFilter =
    category === 'uncategorized' || category === 'review' ? category : null
  const categoryFilter = decisionFilter ? 'all' : category
  const minCents = parseAmountInput(minAmount)
  const maxCents = parseAmountInput(maxAmount)
  const updateFilters = (updates: Partial<typeof urlState>) =>
    void setUrlState({ ...updates, page: 1 })
  const setTarget = (value: string) => updateFilters({ target: value })
  const setCategoryFilter = (value: string) =>
    updateFilters({ category: value })
  const setDateRange = (range: DateRange | undefined) =>
    updateFilters({
      dateFrom: range?.from ? format(range.from, 'yyyy-MM-dd') : '',
      dateTo: range?.to ? format(range.to, 'yyyy-MM-dd') : '',
    })
  const selectedDateRange = useMemo<DateRange | undefined>(() => {
    if (!dateFrom && !dateTo) return undefined
    return {
      from: dateFrom ? new Date(`${dateFrom}T12:00:00`) : undefined,
      to: dateTo ? new Date(`${dateTo}T12:00:00`) : undefined,
    }
  }, [dateFrom, dateTo])
  const filters = useMemo(
    () => transactionSearchToFilters(urlState),
    [urlState],
  )
  const deferredFilters = useDeferredValue(filters)
  const { data, isFetching } = useSuspenseQuery(
    entriesPageOptions(deferredFilters),
  )
  const { data: counts } = useSuspenseQuery(entryCountsOptions())
  const { data: categories } = useSuspenseQuery(categoriesOptions(true))
  const { data: accounts } = useSuspenseQuery(accountsOptions(true))
  const changingPage = isFetching || deferredFilters !== filters
  useEffect(() => {
    if (!changingPage && data.page !== filters.page) {
      void navigate({
        search: (previous) => ({ ...previous, page: data.page + 1 }),
        replace: true,
        resetScroll: false,
      })
    }
  }, [changingPage, data.page, filters.page, navigate])

  const categoryById = useMemo(
    () => new Map(categories.map((item) => [item.id, item])),
    [categories],
  )
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  )
  /** Categories a person may choose: active and not owned by reconciliation. */
  const assignable = useMemo(
    () => categories.filter((item) => item.active && !item.system),
    [categories],
  )

  const hasActiveFilters =
    search !== '' ||
    target !== 'all' ||
    category !== 'all' ||
    direction !== 'all' ||
    minCents !== null ||
    maxCents !== null ||
    dateFrom !== '' ||
    dateTo !== ''
  const clearFilters = () => void setUrlState(null)
  const clearAdvancedFilters = () =>
    updateFilters({
      target: 'all',
      category: decisionFilter ?? 'all',
      minAmount: '',
      maxAmount: '',
    })
  const segment = decisionFilter ?? direction
  const advancedFilterCount =
    Number(target !== 'all') +
    Number(categoryFilter !== 'all') +
    Number(minCents !== null || maxCents !== null)

  const invalidate = () => invalidateAfterReactors(queryClient)
  const categoryMutation = useMutation({
    mutationFn: (input: {
      entry: Entry
      categoryId: string
      action: 'decide' | 'correct' | 'confirm'
    }) => {
      const entryId = input.entry.id
      if (input.action === 'confirm')
        return confirmCategory({ data: { entryId } })
      if (input.action === 'correct')
        return correctCategory({
          data: { entryId, categoryId: input.categoryId },
        })
      return decideCategory({
        data: { entryId, categoryId: input.categoryId },
      })
    },
    // Atualização otimista: a linha muda na hora, em todas as páginas em cache.
    onMutate: async (variables) => {
      const rollback = await patchEntryCategory(queryClient, {
        entryId: variables.entry.id,
        categoryId: variables.categoryId,
      })
      return { rollback }
    },
    onSuccess: () => void invalidate(),
    onError: (error, _variables, context) => {
      context?.rollback()
      toast.error(errorMessage(error, 'Não foi possível salvar a categoria.'))
    },
  })

  const categoryGroups = useMemo(
    () => groupCategoryOptions(assignable),
    [assignable],
  )
  const dayGroups = useMemo(() => {
    const groups = new Map<string, Array<Entry>>()
    for (const entry of data.entries) {
      const list = groups.get(entry.bookedOn) ?? []
      list.push(entry)
      groups.set(entry.bookedOn, list)
    }
    return [...groups.entries()]
  }, [data.entries])

  const targetOptions = accounts
    .filter((account) => !account.archived || account.id === target)
    .map((account) => ({
      id: account.id,
      name: formatInstrumentName(accountOptionLabel(account)),
    }))
  const activeChips = [
    target !== 'all' && {
      key: 'target',
      label:
        targetOptions.find((option) => option.id === target)?.name ?? 'Origem',
      clear: () => setTarget('all'),
    },
    categoryFilter !== 'all' && {
      key: 'category',
      label: categoryById.get(categoryFilter)?.name ?? 'Categoria',
      clear: () => setCategoryFilter('all'),
    },
    (minCents !== null || maxCents !== null) && {
      key: 'amount',
      label:
        minCents !== null && maxCents !== null
          ? `${formatCurrency(minCents, 'BRL')} a ${formatCurrency(maxCents, 'BRL')}`
          : minCents !== null
            ? `≥ ${formatCurrency(minCents, 'BRL')}`
            : `≤ ${formatCurrency(maxCents ?? 0, 'BRL')}`,
      clear: () => updateFilters({ minAmount: '', maxAmount: '' }),
    },
    (dateFrom !== '' || dateTo !== '') && {
      key: 'date',
      label:
        dateFrom && dateTo
          ? formatPeriod({ start: dateFrom, end: dateTo }, 'day-range')
          : dateFrom
            ? `Desde ${formatLongDate(dateFrom)}`
            : `Até ${formatLongDate(dateTo)}`,
      clear: () => updateFilters({ dateFrom: '', dateTo: '' }),
    },
  ].filter((chip): chip is Exclude<typeof chip, false> => Boolean(chip))
  const hasTransactions = counts.total > 0
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize))

  return (
    <Page>
      <PageHeader
        title="Transações"
        description={
          hasTransactions
            ? `${counts.total} lançamentos`
            : 'Nenhum lançamento registrado ainda.'
        }
      />
      {!hasTransactions ? (
        <Panel>
          <EmptyState
            icon={ReceiptText}
            title="Nenhuma transação ainda"
            description="Importe um extrato ou conecte o banco pelo Open Finance para ver os lançamentos aqui."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button nativeButton={false} render={<Link to="/importar" />}>
                  Importar extrato
                </Button>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      to="/configuracoes"
                      search={{ tab: 'open-finance' }}
                    />
                  }
                >
                  Conectar banco
                </Button>
              </div>
            }
          />
        </Panel>
      ) : (
        <Panel>
          <div className="mb-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SegmentedControl
                aria-label="Filtrar por tipo de lançamento"
                value={segment}
                onValueChange={(value) => {
                  if (value === 'uncategorized' || value === 'review') {
                    updateFilters({ category: value, direction: 'all' })
                    return
                  }
                  updateFilters({
                    category: categoryFilter,
                    direction: value as 'all' | 'in' | 'out',
                  })
                }}
                items={[
                  { value: 'all', label: 'Tudo' },
                  { value: 'in', label: 'Entradas', tone: 'success' },
                  { value: 'out', label: 'Saídas', tone: 'destructive' },
                  ...(counts.review > 0 || decisionFilter === 'review'
                    ? [
                        {
                          value: 'review',
                          label: 'A revisar',
                          count: counts.review,
                          tone: 'warning' as const,
                        },
                      ]
                    : []),
                  ...(counts.uncategorized > 0 ||
                  decisionFilter === 'uncategorized'
                    ? [
                        {
                          value: 'uncategorized',
                          label: 'Sem categoria',
                          count: counts.uncategorized,
                          tone: 'warning' as const,
                        },
                      ]
                    : []),
                ]}
              />
              <div className="flex flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        className={cn(
                          'w-full justify-start font-normal sm:w-auto',
                          !dateFrom && !dateTo && 'text-muted-foreground',
                        )}
                        aria-label={
                          dateFrom || dateTo
                            ? `Período selecionado: ${
                                dateFrom && dateTo
                                  ? formatPeriod(
                                      { start: dateFrom, end: dateTo },
                                      'day-range',
                                    )
                                  : dateFrom
                                    ? `desde ${formatLongDate(dateFrom)}`
                                    : `até ${formatLongDate(dateTo)}`
                              }`
                            : 'Filtrar por período'
                        }
                      />
                    }
                  >
                    <CalendarDays data-icon="inline-start" />
                    {dateFrom && dateTo
                      ? formatPeriod(
                          { start: dateFrom, end: dateTo },
                          'day-range',
                        )
                      : dateFrom
                        ? `Desde ${formatLongDate(dateFrom)}`
                        : dateTo
                          ? `Até ${formatLongDate(dateTo)}`
                          : 'Todo período'}
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-auto max-w-[calc(100vw-2rem)] gap-0 overflow-x-auto p-0"
                  >
                    <Calendar
                      mode="range"
                      locale={ptBR}
                      selected={selectedDateRange}
                      onSelect={setDateRange}
                      numberOfMonths={isMobile ? 1 : 2}
                      defaultMonth={selectedDateRange?.from}
                      autoFocus
                    />
                    <div className="flex justify-end border-t px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!dateFrom && !dateTo}
                        onClick={() =>
                          updateFilters({ dateFrom: '', dateTo: '' })
                        }
                      >
                        Limpar
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
                <div className="relative w-full sm:w-64">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) =>
                      void setUrlState(
                        { search: event.target.value, page: 1 },
                        { replace: true },
                      )
                    }
                    placeholder="Buscar descrição…"
                    className="pl-8 md:pl-8"
                    aria-label="Buscar transações"
                    maxLength={200}
                  />
                </div>
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        aria-label={
                          advancedFilterCount
                            ? `Filtros, ${advancedFilterCount} ativos`
                            : 'Filtros'
                        }
                      />
                    }
                  >
                    <SlidersHorizontal data-icon="inline-start" />
                    Filtros
                    {advancedFilterCount > 0 && (
                      <Badge className="h-4.5 min-w-4.5 px-1 tabular-nums">
                        {advancedFilterCount}
                      </Badge>
                    )}
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80 gap-4 p-4">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        Origem
                      </span>
                      <NativeSelect
                        value={target}
                        onChange={(event) => setTarget(event.target.value)}
                        className="w-full"
                      >
                        <NativeSelectOption value="all">
                          Todas as origens
                        </NativeSelectOption>
                        {targetOptions.map((option) => (
                          <NativeSelectOption key={option.id} value={option.id}>
                            {option.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        Categoria
                      </span>
                      <NativeSelect
                        value={categoryFilter}
                        onChange={(event) =>
                          setCategoryFilter(event.target.value)
                        }
                        className="w-full"
                      >
                        <NativeSelectOption value="all">
                          Todas as categorias
                        </NativeSelectOption>
                        <NativeSelectOptGroup label="Despesas">
                          {categoryGroups.expenses.map((item) => (
                            <NativeSelectOption key={item.id} value={item.id}>
                              {item.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelectOptGroup>
                        <NativeSelectOptGroup label="Receitas">
                          {categoryGroups.income.map((item) => (
                            <NativeSelectOption key={item.id} value={item.id}>
                              {item.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelectOptGroup>
                      </NativeSelect>
                    </label>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        Valor
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Input
                          inputMode="decimal"
                          value={minAmount}
                          onChange={(event) =>
                            void setUrlState(
                              { minAmount: event.target.value, page: 1 },
                              { replace: true },
                            )
                          }
                          placeholder="R$ mín"
                          aria-label="Valor mínimo"
                          aria-invalid={minAmount !== '' && minCents === null}
                        />
                        <span className="text-xs text-muted-foreground">a</span>
                        <Input
                          inputMode="decimal"
                          value={maxAmount}
                          onChange={(event) =>
                            void setUrlState(
                              { maxAmount: event.target.value, page: 1 },
                              { replace: true },
                            )
                          }
                          placeholder="R$ máx"
                          aria-label="Valor máximo"
                          aria-invalid={maxAmount !== '' && maxCents === null}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {data.total} de {counts.total}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={advancedFilterCount === 0}
                        onClick={clearAdvancedFilters}
                      >
                        Limpar filtros
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            {hasActiveFilters && (
              <div className="flex flex-wrap items-center gap-2">
                {activeChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={chip.clear}
                    aria-label={`Remover filtro ${chip.label}`}
                    className="inline-flex h-7 items-center gap-1 rounded-full border bg-background pr-1.5 pl-2.5 text-xs font-medium transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none pointer-fine:hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transform-none"
                  >
                    {chip.label}
                    <X className="size-3 text-muted-foreground" />
                  </button>
                ))}
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Limpar tudo · {data.total} de {counts.total}
                </Button>
              </div>
            )}
          </div>
          {data.entries.length ? (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead className="hidden w-44 md:table-cell">
                    Origem
                  </TableHead>
                  <TableHead className="w-44 sm:w-72">Categoria</TableHead>
                  <TableHead className="w-28 text-right sm:w-36">
                    Valor
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dayGroups.map(([date, items]) => (
                  <Fragment key={date}>
                    <TableRow className="bg-muted/30 pointer-fine:hover:bg-muted/30">
                      <TableCell
                        colSpan={4}
                        className="py-1.5 text-xs font-medium text-muted-foreground"
                      >
                        {formatDayLabel(date)}
                        <span className="font-normal">
                          {' '}
                          · {items.length}{' '}
                          {items.length === 1 ? 'lançamento' : 'lançamentos'}
                        </span>
                      </TableCell>
                    </TableRow>
                    {items.map((entry) => {
                      const account = accountById.get(entry.accountId)
                      return (
                        <TableRow key={entry.id}>
                          <TableCell className="font-medium">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate">
                                {displayDescription(entry.description)}
                              </span>
                              {entry.status === 'pending' ? (
                                <StatusBadge tone="warning">
                                  Provisória
                                </StatusBadge>
                              ) : null}
                              {entry.sources > 1 ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <span
                                        className="inline-flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted-foreground"
                                        aria-label={`Confirmado por ${entry.sources} fontes`}
                                      />
                                    }
                                  >
                                    <Layers className="size-3.5" />
                                    {entry.sources}
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Visto em {entry.sources} fontes (extrato e
                                    Open Finance)
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                              {entry.category?.excludedFromSpending ? null : (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 text-muted-foreground"
                                        aria-label={`Vincular ${displayDescription(entry.description)} a outro lançamento`}
                                        onClick={() => setLinking(entry)}
                                      />
                                    }
                                  >
                                    <Link2 />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Vincular transferência, fatura ou estorno
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-xs font-normal text-muted-foreground md:hidden">
                              {formatInstrumentName(account?.name ?? '—')}
                            </p>
                          </TableCell>
                          <TableCell className="hidden truncate text-muted-foreground md:table-cell">
                            {formatInstrumentName(account?.name ?? '—')}
                          </TableCell>
                          <TableCell>
                            <EntryCategoryCell
                              entry={entry}
                              categories={assignable}
                              category={
                                entry.category?.categoryId
                                  ? categoryById.get(entry.category.categoryId)
                                  : undefined
                              }
                              pending={
                                categoryMutation.isPending &&
                                categoryMutation.variables.entry.id === entry.id
                              }
                              onChoose={(categoryId) =>
                                categoryMutation.mutate({
                                  entry,
                                  categoryId,
                                  action:
                                    entry.category?.status === 'review'
                                      ? 'correct'
                                      : 'decide',
                                })
                              }
                              onConfirm={(categoryId) =>
                                categoryMutation.mutate({
                                  entry,
                                  categoryId,
                                  action: 'confirm',
                                })
                              }
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span
                              className={cn(
                                'font-medium',
                                entry.amountCents > 0 && 'text-emerald-700',
                              )}
                            >
                              {formatCurrency(
                                entry.amountCents,
                                entry.currency,
                              )}
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={ReceiptText}
              title="Nenhum lançamento encontrado"
              description="Ajuste ou limpe os filtros para ver mais lançamentos."
              action={
                <Button variant="outline" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              }
            />
          )}
          {data.total > data.pageSize && (
            <nav
              className="flex items-center justify-end gap-3 p-3"
              aria-label="Paginação"
            >
              <span className="text-sm text-muted-foreground">
                Página {data.page + 1} de {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={changingPage || data.page === 0}
                onClick={() => void setUrlState({ page: data.page })}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={changingPage || data.page + 1 >= pageCount}
                onClick={() => void setUrlState({ page: data.page + 2 })}
              >
                Próxima
              </Button>
            </nav>
          )}
        </Panel>
      )}
      <ReconciliationReview />
      <LinkEntryDialog entry={linking} onClose={() => setLinking(null)} />
    </Page>
  )
}

/**
 * The entry's category: chosen by the person, suggested for review, owned by
 * reconciliation (transfers and bill payments), or still being computed.
 */
function EntryCategoryCell({
  entry,
  categories,
  category,
  pending,
  onChoose,
  onConfirm,
}: {
  entry: Entry
  categories: ReadonlyArray<Category>
  category: Category | undefined
  pending: boolean
  onChoose: (categoryId: string) => void
  onConfirm: (categoryId: string) => void
}) {
  if (!entry.category) {
    return <span className="text-xs text-muted-foreground">Categorizando…</span>
  }
  if (category?.system) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <ArrowLeftRight className="size-3.5 shrink-0" />
        <span className="truncate">{category.name}</span>
      </span>
    )
  }
  const review = entry.category.status === 'review'
  const suggested = entry.category.categoryId
  return (
    <div className="flex min-w-0 items-center gap-1">
      <CategorySelect
        variant="ghost"
        categories={[...categories]}
        value={suggested ?? 'uncategorized'}
        onValueChange={onChoose}
        disabled={pending}
        aria-label={`Categoria de ${displayDescription(entry.description)}`}
        allowTransfer={false}
        className={cn(
          review &&
            'border-dashed border-amber-300 bg-amber-50/60 text-amber-950',
        )}
      />
      {review && suggested ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={pending}
                aria-label={`Confirmar ${category?.name ?? 'categoria sugerida'} para ${displayDescription(entry.description)}`}
                onClick={() => onConfirm(suggested)}
              />
            }
          >
            {entry.category.origin === 'model' ? <Sparkles /> : <Check />}
          </TooltipTrigger>
          <TooltipContent>
            Confirmar sugestão
            {entry.category.origin === 'model' ? ' do assistente' : ''}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

/** Descrições em caixa alta vindas do banco ficam em capitalização normal só na tela. */
function displayDescription(text: string) {
  const trimmed = text.trim()
  if (trimmed !== trimmed.toUpperCase() || !/[A-Z]/.test(trimmed)) {
    return trimmed
  }
  return trimmed
    .toLowerCase()
    .replace(
      /(^|[\s(/-])([a-zà-ú])/g,
      (_, prefix, letter: string) => `${prefix}${letter.toUpperCase()}`,
    )
}
