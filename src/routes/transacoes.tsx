import { baseAmount } from '#/domain/ledger'
import {
  transactionSearchDefaults,
  transactionSearchSchema,
  transactionSearchToFilters,
  parseAmountInput,
} from '#/features/finance/transactions.search'
import {
  ArrowLeftRight,
  CalendarDays,
  Check,
  ReceiptText,
  StickyNote,
  RefreshCw,
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
  Page,
  EmptyState,
  PageHeader,
  Panel,
  StatusBadge,
} from '#/components/ui'
import { CategorySelect } from '#/components/category-select'
import { ManualTransactionDialog } from '#/components/manual-transaction-dialog'
import { SegmentedControl } from '#/components/segmented-control'
import { TransferAccountSelect } from '#/components/transfer-account-select'
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
import { Spinner } from '#/components/ui/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { formatInstrumentName } from '#/domain/finance'
import { formatCurrency } from '#/domain/currency'
import { formatDayLabel, formatLongDate, formatPeriod } from '#/domain/period'
import {
  applyKnowledgeSyncFn,
  categorizeUncategorizedTransactionsWithAiFn,
  previewKnowledgeSyncFn,
  setReconciliationStatusFn,
  updateTransactionCategoryFn,
  updateTransactionNoteFn,
} from '#/features/finance/finance.functions'
import {
  transactionsPageOptions,
  invalidateFinance,
  patchTransactionCategory,
  patchTransactionNote,
} from '#/features/finance/queries'
import { groupCategoryOptions } from '#/domain/categories'
import { cn } from '#/lib/utils'
import { useIsMobile } from '#/hooks/use-mobile'

export const Route = createFileRoute('/transacoes')({
  validateSearch: transactionSearchSchema,
  search: { middlewares: [stripSearchParams(transactionSearchDefaults)] },
  loaderDeps: ({ search }) => transactionSearchToFilters(search),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(transactionsPageOptions(deps)),
  component: TransactionsPage,
})

function TransactionsPage() {
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const updateCategory = useServerFn(updateTransactionCategoryFn)
  const updateNote = useServerFn(updateTransactionNoteFn)
  const categorizeWithAi = useServerFn(
    categorizeUncategorizedTransactionsWithAiFn,
  )
  const setReconciliation = useServerFn(setReconciliationStatusFn)
  const previewKnowledgeSync = useServerFn(previewKnowledgeSyncFn)
  const applyKnowledgeSync = useServerFn(applyKnowledgeSyncFn)
  const [syncPlan, setSyncPlan] = useState<Awaited<
    ReturnType<typeof previewKnowledgeSync>
  > | null>(null)
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
  const { search, target, direction, minAmount, maxAmount, dateFrom, dateTo } =
    urlState
  const onlyUncategorized = urlState.category === 'uncategorized'
  const categoryFilter = onlyUncategorized ? 'all' : urlState.category
  const minCents = parseAmountInput(minAmount)
  const maxCents = parseAmountInput(maxAmount)
  const updateFilters = (updates: Partial<typeof urlState>) =>
    void setUrlState({ ...updates, page: 1 })
  const setSearch = (value: string) =>
    void setUrlState({ search: value, page: 1 }, { replace: true })
  const setTarget = (value: string) => updateFilters({ target: value })
  const setCategoryFilter = (value: string) =>
    updateFilters({ category: value })
  const setMinAmount = (value: string) =>
    void setUrlState({ minAmount: value, page: 1 }, { replace: true })
  const setMaxAmount = (value: string) =>
    void setUrlState({ maxAmount: value, page: 1 }, { replace: true })
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
    transactionsPageOptions(deferredFilters),
  )
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
  const hasActiveFilters =
    search !== '' ||
    target !== 'all' ||
    onlyUncategorized ||
    categoryFilter !== 'all' ||
    direction !== 'all' ||
    minCents !== null ||
    maxCents !== null ||
    dateFrom !== '' ||
    dateTo !== ''
  const clearFilters = () => void setUrlState(null)
  const clearAdvancedFilters = () =>
    updateFilters({
      target: 'all',
      category: onlyUncategorized ? 'uncategorized' : 'all',
      minAmount: '',
      maxAmount: '',
    })
  const segment = onlyUncategorized ? 'uncategorized' : direction
  const advancedFilterCount =
    Number(target !== 'all') +
    Number(categoryFilter !== 'all') +
    Number(minCents !== null || maxCents !== null)
  const invalidate = () => invalidateFinance(queryClient, 'ledger')
  const categoryMutation = useMutation({
    mutationFn: updateCategory,
    // Atualização otimista: a linha muda na hora, sem travar as outras.
    onMutate: async (variables) => {
      const rollback = await patchTransactionCategory(queryClient, {
        transactionId: variables.data.transactionId,
        categoryId: variables.data.categoryId,
      })
      return { rollback }
    },
    onSuccess: () => invalidate(),
    onError: (error, _variables, context) => {
      context?.rollback()
      toast.error(error instanceof Error ? error.message : 'Erro ao atualizar.')
    },
  })
  const noteMutation = useMutation({
    mutationFn: updateNote,
    onMutate: async (variables) => {
      const rollback = await patchTransactionNote(queryClient, {
        transactionId: variables.data.transactionId,
        note: variables.data.note,
      })
      return { rollback }
    },
    onSuccess: () => invalidate(),
    onError: (error, _variables, context) => {
      context?.rollback()
      toast.error(
        error instanceof Error ? error.message : 'Erro ao salvar a nota.',
      )
    },
  })
  const reconciliationMutation = useMutation({
    mutationFn: setReconciliation,
    onSuccess: () => {
      toast.success('Reconciliação atualizada.')
      invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Erro ao atualizar.',
      ),
  })
  const aiCategorizationMutation = useMutation({
    mutationFn: categorizeWithAi,
    onSuccess: async (result) => {
      if (!result.processed) {
        toast.success('Não há transações sem categoria.')
      } else if (!result.categorized) {
        toast.info(
          'A IA não encontrou sugestões com confiança suficiente. Nada foi alterado.',
        )
      } else {
        toast.success(
          `${result.categorized} transações categorizadas. ${result.remaining} ainda pendentes.`,
        )
      }
      await invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Falha ao categorizar transações com IA.',
      ),
  })

  const syncPreviewMutation = useMutation({
    mutationFn: previewKnowledgeSync,
    onSuccess: (plan) => {
      if (!plan.changes.length) {
        toast.success('As categorias já refletem a base de conhecimento.')
        return
      }
      setSyncPlan(plan)
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível calcular a sincronização.',
      ),
  })
  const syncApplyMutation = useMutation({
    mutationFn: applyKnowledgeSync,
    onSuccess: async (result) => {
      setSyncPlan(null)
      toast.success(
        `${result.changed} lançamentos atualizados pela base de conhecimento.`,
      )
      await invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível sincronizar.',
      ),
  })

  const uncategorizedCount = data.uncategorizedCount

  // Só categorias com lançamentos no período aparecem no filtro (com a
  // contagem), para a lista não virar a taxonomia inteira.
  const categoryGroups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of data.categoryCounts) {
      if (item.categoryId && item.categoryId !== 'uncategorized')
        counts.set(item.categoryId, item.count)
    }
    const groups = groupCategoryOptions(data.categories)
    const withCount = (items: typeof groups.income) =>
      items
        .filter((item) => counts.has(item.id) || item.id === categoryFilter)
        .map((item) => ({ ...item, count: counts.get(item.id) ?? 0 }))
    return {
      income: withCount(groups.income),
      expenses: withCount(groups.expenses),
    }
  }, [data.categoryCounts, data.categories, categoryFilter])

  const transactions = data.transactions
  const dayGroups = useMemo(() => {
    const groups = new Map<string, typeof transactions>()
    for (const transaction of transactions) {
      const list = groups.get(transaction.postedAt) ?? []
      list.push(transaction)
      groups.set(transaction.postedAt, list)
    }
    return [...groups.entries()]
  }, [transactions])
  const transactionPeriod = data.period
  const periodLabel = transactionPeriod
    ? formatPeriod(transactionPeriod, 'month-range')
    : ''

  const targetOptions = [
    ...data.accounts.map((account) => ({
      id: account.id,
      name: `Conta · ${formatInstrumentName(account.name)}`,
    })),
    ...data.cards.map((card) => ({
      id: card.id,
      name: `Cartão · ${formatInstrumentName(card.name)}`,
    })),
  ]
  const activeChips = [
    target !== 'all' && {
      key: 'target',
      label:
        targetOptions.find((option) => option.id === target)?.name ?? 'Origem',
      clear: () => setTarget('all'),
    },
    categoryFilter !== 'all' && {
      key: 'category',
      label:
        data.categories.find((item) => item.id === categoryFilter)?.name ??
        'Categoria',
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
  const suggestedReconciliations = data.reconciliations.filter(
    (item) => item.status === 'suggested',
  )
  const reconciliationHistory = data.reconciliations.filter(
    (item) => item.status !== 'suggested',
  )
  const hasTransactions = data.totalCount > 0

  return (
    <Page>
      <PageHeader
        title="Transações"
        description={
          hasTransactions
            ? `${data.totalCount} lançamentos · ${periodLabel}`
            : 'Nenhum lançamento registrado ainda.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <ManualTransactionDialog
              accounts={data.accounts}
              cards={data.cards}
              categories={data.categories}
            />
            {hasTransactions ? (
              <Button
                variant="outline"
                onClick={() => syncPreviewMutation.mutate({})}
                disabled={syncPreviewMutation.isPending}
              >
                {syncPreviewMutation.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                Sincronizar com a base
              </Button>
            ) : null}
            {uncategorizedCount > 0 ? (
              <Button
                variant="outline"
                onClick={() => aiCategorizationMutation.mutate({})}
                disabled={aiCategorizationMutation.isPending}
              >
                {aiCategorizationMutation.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Sparkles data-icon="inline-start" />
                )}
                {aiCategorizationMutation.isPending
                  ? 'Categorizando…'
                  : `Categorizar com IA (${uncategorizedCount})`}
              </Button>
            ) : null}
          </div>
        }
      />
      <AlertDialog
        open={syncPlan !== null}
        onOpenChange={(open) => !open && setSyncPlan(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Sincronizar {syncPlan?.changes.length ?? 0} lançamentos com a base
              de conhecimento?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Cada lançamento recebe a categoria do padrão que o cobre.
              Transferências e pagamentos de fatura não mudam.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {syncPlan ? (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
              {syncPlan.changes.slice(0, 8).map((change) => (
                <li
                  key={change.transactionId}
                  className="flex flex-col gap-0.5 px-3 py-2"
                >
                  <span className="truncate font-medium">
                    {change.description}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDayLabel(change.postedAt)} ·{' '}
                    {change.fromCategoryName} → {change.toCategoryName}
                  </span>
                </li>
              ))}
              {syncPlan.changes.length > 8 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  e mais {syncPlan.changes.length - 8} lançamentos
                </li>
              ) : null}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncApplyMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncApplyMutation.isPending}
              onClick={() => syncApplyMutation.mutate({})}
            >
              {syncApplyMutation.isPending ? 'Sincronizando…' : 'Sincronizar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!hasTransactions ? (
        <Panel>
          <EmptyState
            icon={ReceiptText}
            title={
              data.dashboard.reviewTransactionCount
                ? `${data.dashboard.reviewTransactionCount} lançamentos aguardam revisão`
                : 'Nenhuma transação ainda'
            }
            description={
              data.dashboard.reviewTransactionCount
                ? 'Revise e consolide o lote importado para ver os lançamentos aqui.'
                : 'Importe um extrato ou use Nova transação para registrar um lançamento manual.'
            }
            action={
              <Button
                nativeButton={false}
                render={
                  <Link
                    to="/importar"
                    search={{
                      view: data.dashboard.reviewTransactionCount
                        ? 'review'
                        : 'upload',
                    }}
                  />
                }
              >
                {data.dashboard.reviewTransactionCount
                  ? 'Revisar importação'
                  : 'Importar extrato'}
              </Button>
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
                  if (value === 'uncategorized') {
                    updateFilters({
                      category: 'uncategorized',
                      direction: 'all',
                    })
                    return
                  }
                  updateFilters({
                    category: onlyUncategorized ? 'all' : categoryFilter,
                    direction: value as 'all' | 'in' | 'out',
                  })
                }}
                items={[
                  { value: 'all', label: 'Tudo' },
                  { value: 'in', label: 'Entradas', tone: 'success' },
                  { value: 'out', label: 'Saídas', tone: 'destructive' },
                  ...(uncategorizedCount > 0 || onlyUncategorized
                    ? [
                        {
                          value: 'uncategorized',
                          label: 'Sem categoria',
                          count: uncategorizedCount,
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
                          : 'Período'}
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
                    <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
                      <span className="text-xs text-muted-foreground">
                        {dateFrom && !dateTo
                          ? 'Selecione a data final'
                          : 'Datas inicial e final inclusas'}
                      </span>
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
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Buscar descrição ou nota…"
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
                        onChange={(event) => {
                          setCategoryFilter(event.target.value)
                        }}
                        className="w-full"
                      >
                        <NativeSelectOption value="all">
                          Todas as categorias
                        </NativeSelectOption>
                        {categoryGroups.expenses.length > 0 && (
                          <NativeSelectOptGroup label="Despesas">
                            {categoryGroups.expenses.map((item) => (
                              <NativeSelectOption key={item.id} value={item.id}>
                                {item.name} ({item.count})
                              </NativeSelectOption>
                            ))}
                          </NativeSelectOptGroup>
                        )}
                        {categoryGroups.income.length > 0 && (
                          <NativeSelectOptGroup label="Receitas">
                            {categoryGroups.income.map((item) => (
                              <NativeSelectOption key={item.id} value={item.id}>
                                {item.name} ({item.count})
                              </NativeSelectOption>
                            ))}
                          </NativeSelectOptGroup>
                        )}
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
                          onChange={(event) => setMinAmount(event.target.value)}
                          placeholder="R$ mín"
                          aria-label="Valor mínimo"
                          aria-invalid={minAmount !== '' && minCents === null}
                        />
                        <span className="text-xs text-muted-foreground">a</span>
                        <Input
                          inputMode="decimal"
                          value={maxAmount}
                          onChange={(event) => setMaxAmount(event.target.value)}
                          placeholder="R$ máx"
                          aria-label="Valor máximo"
                          aria-invalid={maxAmount !== '' && maxCents === null}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {data.filteredCount} de {data.totalCount}
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
                  Limpar tudo · {data.filteredCount} de {data.totalCount}
                </Button>
              </div>
            )}
          </div>
          {transactions.length ? (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead className="w-44">Origem</TableHead>
                  <TableHead className="w-72">Categoria</TableHead>
                  <TableHead className="w-36 text-right">Valor</TableHead>
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
                    {items.map((transaction) => (
                      <TableRow key={transaction.id}>
                        <TableCell className="font-medium">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate">
                              {displayDescription(transaction.description)}
                            </span>
                            {transaction.status !== 'confirmed' ? (
                              <StatusBadge
                                tone={
                                  transaction.status === 'pending'
                                    ? 'warning'
                                    : 'neutral'
                                }
                              >
                                {transaction.status === 'pending'
                                  ? 'Provisória'
                                  : 'Excluída'}
                              </StatusBadge>
                            ) : null}
                            <TransactionNoteEditor
                              note={transaction.notes}
                              description={transaction.description}
                              pending={
                                noteMutation.isPending &&
                                noteMutation.variables.data.transactionId ===
                                  transaction.id
                              }
                              onSave={(note) =>
                                noteMutation.mutate({
                                  data: { transactionId: transaction.id, note },
                                })
                              }
                            />
                          </div>
                          {transaction.notes ? (
                            <p className="mt-1 truncate text-xs font-normal text-muted-foreground">
                              {transaction.notes}
                            </p>
                          ) : null}
                          {transaction.sourceDocument && (
                            <p
                              className="mt-1 text-xs font-normal text-muted-foreground"
                              title={`${transaction.sourceDocument.file} · página ${transaction.sourceDocument.page ?? '?'}`}
                            >
                              Data no documento:{' '}
                              {transaction.sourceDocument.date
                                .split('-')
                                .reverse()
                                .join('/')}
                              {transaction.sourceDocument.dueDate &&
                                ` · Fatura: ${transaction.sourceDocument.dueDate.split('-').reverse().join('/')}`}
                              {transaction.sourceDocument.date !==
                                transaction.postedAt &&
                                ' · agrupada pela cobrança'}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="truncate text-muted-foreground">
                          {formatInstrumentName(
                            transaction.account?.name ??
                              transaction.creditCard?.name ??
                              '—',
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 flex-col items-start gap-1.5">
                            <CategorySelect
                              variant="ghost"
                              categories={data.categories}
                              value={transaction.categoryId ?? 'uncategorized'}
                              onValueChange={(categoryId) =>
                                categoryMutation.mutate({
                                  data: {
                                    transactionId: transaction.id,
                                    categoryId,
                                    counterpartyAccountId:
                                      categoryId === 'transfer'
                                        ? transaction.counterpartyAccountId
                                        : null,
                                    saveRule: false,
                                  },
                                })
                              }
                              disabled={
                                categoryMutation.isPending &&
                                categoryMutation.variables.data
                                  .transactionId === transaction.id
                              }
                              aria-label={`Categoria de ${transaction.description}`}
                              allowTransfer={Boolean(transaction.accountId)}
                            />
                            {transaction.categoryId === 'transfer' &&
                            transaction.accountId ? (
                              <TransferAccountSelect
                                accounts={data.accounts}
                                sourceAccountId={transaction.accountId}
                                amountCents={transaction.amountCents}
                                value={transaction.counterpartyAccountId}
                                disabled={categoryMutation.isPending}
                                onValueChange={(accountId) =>
                                  categoryMutation.mutate({
                                    data: {
                                      transactionId: transaction.id,
                                      categoryId: 'transfer',
                                      counterpartyAccountId: accountId,
                                      saveRule: true,
                                    },
                                  })
                                }
                              />
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <AmountCell
                            amountCents={transaction.amountCents}
                            currency={transaction.currency}
                            baseAmountCents={transaction.baseAmountCents}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={ReceiptText}
              title="Nenhum lançamento encontrado"
              description="Ajuste os filtros ou importe um extrato para começar."
            />
          )}
          {data.filteredCount > 50 && (
            <div
              className="flex items-center justify-end gap-3 p-3"
              aria-label="Paginação"
            >
              <span className="text-sm text-muted-foreground">
                Página {data.page + 1} de {Math.ceil(data.filteredCount / 50)}
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
                disabled={
                  changingPage || (data.page + 1) * 50 >= data.filteredCount
                }
                onClick={() => void setUrlState({ page: data.page + 2 })}
              >
                Próxima
              </Button>
            </div>
          )}
        </Panel>
      )}

      {suggestedReconciliations.length > 0 && (
        <Panel
          title="Matches sugeridos"
          description="Confirme apenas quando as duas pontas representarem a mesma movimentação."
          className="mt-4"
        >
          {
            <div className="flex flex-col gap-3">
              {suggestedReconciliations.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col justify-between gap-3 rounded-lg border p-3 md:flex-row md:items-center"
                >
                  <div className="flex items-start gap-3">
                    <ArrowLeftRight className="mt-0.5 size-4 text-primary" />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm">
                          {item.type === 'card_payment'
                            ? 'Pagamento de cartão'
                            : item.type === 'fx_transfer'
                              ? 'Transferência cambial'
                              : item.type === 'refund'
                                ? 'Estorno'
                                : item.type === 'profit_distribution'
                                  ? 'Distribuição de lucros'
                                  : 'Transferência'}
                        </strong>
                        <StatusBadge tone="info">
                          Regra {item.confidence}%
                        </StatusBadge>
                        {item.aiValidation ? (
                          <StatusBadge
                            tone={
                              item.aiValidation === 'confirmed'
                                ? 'success'
                                : item.aiValidation === 'rejected'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {item.aiValidation === 'confirmed'
                              ? 'IA confirmou'
                              : item.aiValidation === 'rejected'
                                ? 'IA divergiu'
                                : 'IA inconclusiva'}
                            {item.aiConfidence !== null
                              ? ` · ${item.aiConfidence}%`
                              : ''}
                          </StatusBadge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.reason}
                      </p>
                      {item.aiReason ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          IA: {item.aiReason}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-col gap-1">
                        {item.links.map((link) => (
                          <div
                            key={link.id}
                            className="flex flex-wrap items-center gap-2 text-xs"
                          >
                            <StatusBadge
                              tone={
                                link.role === 'source' ? 'warning' : 'success'
                              }
                            >
                              {link.role === 'source' ? 'Saída' : 'Entrada'}
                            </StatusBadge>
                            <span>
                              {formatInstrumentName(
                                link.transaction?.account?.name ??
                                  link.transaction?.creditCard?.name ??
                                  'Destino removido',
                              )}
                            </span>
                            <span className="text-muted-foreground tabular-nums">
                              {link.transaction?.postedAt}
                            </span>
                            <strong className="tabular-nums">
                              {link.transaction
                                ? formatCurrency(
                                    link.transaction.amountCents,
                                    link.transaction.currency,
                                  )
                                : '—'}
                            </strong>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        reconciliationMutation.mutate({
                          data: { groupId: item.id, status: 'rejected' },
                        })
                      }
                    >
                      <X data-icon="inline-start" />
                      Rejeitar
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        reconciliationMutation.mutate({
                          data: { groupId: item.id, status: 'confirmed' },
                        })
                      }
                    >
                      <Check data-icon="inline-start" />
                      Confirmar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          }
        </Panel>
      )}

      {reconciliationHistory.length > 0 && (
        <Panel
          title="Histórico de conciliações"
          description="Confirmações preservam as duas pontas e podem voltar para revisão."
          className="mt-4"
        >
          {
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Pontas</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconciliationHistory.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.reason}</TableCell>
                    <TableCell>
                      {item.links
                        .map((link) =>
                          formatInstrumentName(
                            link.transaction?.account?.name ??
                              link.transaction?.creditCard?.name ??
                              'Destino removido',
                          ),
                        )
                        .join(' ↔ ')}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={
                          item.status === 'confirmed' ? 'success' : 'neutral'
                        }
                      >
                        {item.status === 'confirmed'
                          ? 'Confirmada'
                          : 'Rejeitada'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          reconciliationMutation.mutate({
                            data: { groupId: item.id, status: 'suggested' },
                          })
                        }
                      >
                        Voltar para revisão
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          }
        </Panel>
      )}
    </Page>
  )
}

// ─── Apresentação ────────────────────────────────────────────────────────────

function AmountCell({
  amountCents,
  currency,
  baseAmountCents,
}: {
  amountCents: number
  currency: string
  baseAmountCents: number | null
}) {
  const baseCents = baseAmount({ amountCents, currency, baseAmountCents })
  const primary =
    baseCents !== null
      ? formatCurrency(baseCents)
      : formatCurrency(amountCents, currency)
  return (
    <>
      <span
        className={cn(
          'font-medium',
          (baseCents ?? amountCents) > 0 && 'text-emerald-700',
        )}
      >
        {primary}
      </span>
      {currency !== 'BRL' && baseCents !== null && (
        <span className="block text-xs text-muted-foreground">
          {formatCurrency(amountCents, currency)}
        </span>
      )}
    </>
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

function TransactionNoteEditor({
  note,
  description,
  pending,
  onSave,
}: {
  note: string | null
  description: string
  pending: boolean
  onSave: (note: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note ?? '')

  const setEditorOpen = (nextOpen: boolean) => {
    if (nextOpen) setDraft(note ?? '')
    setOpen(nextOpen)
  }

  return (
    <Popover open={open} onOpenChange={setEditorOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              'shrink-0 text-muted-foreground',
              note && 'text-foreground',
            )}
            aria-label={`${note ? 'Editar' : 'Adicionar'} nota para ${displayDescription(description)}`}
          />
        }
      >
        <StickyNote />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 p-3">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const nextNote = draft.trim() || null
            if (nextNote !== note) onSave(nextNote)
            setOpen(false)
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Nota</span>
            <Input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ex.: jantar de aniversário"
              maxLength={320}
              aria-label="Nota da transação"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {draft.length}/200
            </span>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Salvar
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
