import {
  ArrowLeftRight,
  CalendarDays,
  Check,
  Layers,
  Link2,
  PencilLine,
  Plus,
  ReceiptText,
  Search,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  X,
  Zap,
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
import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import { ConvertedAmount } from '#/components/exchange'
import { ManualTransactionDialog } from '#/components/manual-transaction-dialog'
import type { ManualTransactionDraft } from '#/components/manual-transaction-dialog'
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
import { Spinner } from '#/components/ui/spinner'
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
import { groupCategoryOptions } from '#/lib/categories'
import { formatCurrency } from '#/lib/currency'
import { formatInstrumentName } from '#/lib/finance'
import { formatDayLabel, formatLongDate, formatPeriod } from '#/lib/period'
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
import { accountOptionLabel } from '#/features/data/accounts'
import {
  confirmCategoryFn,
  correctCategoryFn,
  decideCategoryFn,
} from '#/features/data/entries.functions'
import {
  setEntryNoteFn,
  setEntryOneOffFn,
} from '#/features/data/manual.functions'
import {
  accountsOptions,
  categoriesOptions,
  entriesPageOptions,
  entryCountsOptions,
  orphanedDecisionsOptions,
  patchEntryCategory,
  patchEntry,
  relationsOptions,
} from '#/features/data/queries'
import { useIsMobile } from '#/hooks/use-mobile'
import { errorMessage } from '#/lib/api/errors'
import { invalidateFinance } from '#/features/finance/queries'
import { cn } from '#/lib/utils'

import type { Category, Entry } from '@spendle/server/api'

export const Route = createFileRoute('/transacoes')({
  validateSearch: transactionSearchSchema,
  search: { middlewares: [stripSearchParams(transactionSearchDefaults)] },
  loaderDeps: ({ search }) => transactionSearchToFilters(search),
  loader: ({ context, deps, cause }) =>
    Promise.all([
      // Another page or filter keeps the current list on screen while it
      // loads (`useDeferredValue` below) instead of holding the navigation.
      cause === 'stay'
        ? void context.queryClient.prefetchQuery(entriesPageOptions(deps))
        : context.queryClient.ensureQueryData(entriesPageOptions(deps)),
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
  const setEntryNote = useServerFn(setEntryNoteFn)
  const setEntryOneOff = useServerFn(setEntryOneOffFn)
  const [linking, setLinking] = useState<Entry | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [editing, setEditing] = useState<ManualTransactionDraft | null>(null)
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
  const { data } = useSuspenseQuery(entriesPageOptions(deferredFilters))
  const { data: counts } = useSuspenseQuery(entryCountsOptions())
  const { data: categories } = useSuspenseQuery(categoriesOptions(true))
  const { data: accounts } = useSuspenseQuery(accountsOptions(true))
  // The list on screen still answers older filters while the new ones load.
  const changingPage = deferredFilters !== filters
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize))
  useEffect(() => {
    if (changingPage) return
    // A page past the end comes back as the last one; show that in the URL.
    if (data.page !== filters.page) {
      void navigate({
        search: (previous) => ({ ...previous, page: data.page + 1 }),
        replace: true,
        resetScroll: false,
      })
      return
    }
    // The next page is usually the next request; have it ready.
    if (data.page + 1 < pageCount) {
      void queryClient.prefetchQuery(
        entriesPageOptions({ ...filters, page: data.page + 1 }),
      )
    }
  }, [changingPage, data.page, filters, navigate, pageCount, queryClient])
  const listTop = useRef<HTMLDivElement>(null)
  const goToPage = (page: number) => {
    void setUrlState({ page: page + 1 })
    listTop.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const categoryById = useMemo(
    () => new Map(categories.map((item) => [item.id, item])),
    [categories],
  )
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  )
  const assignable = useMemo(
    () => categories.filter((item) => item.assignable),
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

  // Decisions answer once the ledger reflects them, and notes are stored as
  // they are: one refetch is enough.
  const invalidate = () => invalidateFinance(queryClient, 'ledger')
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

  const noteMutation = useMutation({
    mutationFn: (input: { entryId: string; note: string | null }) =>
      setEntryNote({ data: input }),
    onMutate: async (variables) => ({
      rollback: await patchEntry(queryClient, variables),
    }),
    onSuccess: () => void invalidate(),
    onError: (error, _variables, context) => {
      context?.rollback()
      toast.error(errorMessage(error, 'Não foi possível salvar a nota.'))
    },
  })
  const oneOffMutation = useMutation({
    mutationFn: (input: { entryId: string; oneOff: boolean }) =>
      setEntryOneOff({ data: input }),
    onMutate: async (variables) => ({
      rollback: await patchEntry(queryClient, variables),
    }),
    onSuccess: () => void invalidate(),
    onError: (error, _variables, context) => {
      context?.rollback()
      toast.error(errorMessage(error, 'Não foi possível marcar como pontual.'))
    },
  })
  const typable = accounts.filter((account) => !account.archived)

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

  return (
    <Page>
      <PageHeader
        title="Transações"
        description={
          hasTransactions
            ? `${counts.total} lançamentos`
            : 'Nenhum lançamento registrado ainda.'
        }
        actions={
          <Button onClick={() => setNewOpen(true)} disabled={!typable.length}>
            <Plus data-icon="inline-start" />
            Nova transação
          </Button>
        }
      />
      {!hasTransactions ? (
        <Panel>
          <EmptyState
            icon={ReceiptText}
            title="Nenhuma transação ainda"
            description="Importe um extrato, conecte o banco pelo Open Finance ou registre um lançamento à mão."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button nativeButton={false} render={<Link to="/importar" />}>
                  Importar extrato
                </Button>
                <Button
                  variant="outline"
                  disabled={!typable.length}
                  onClick={() => setNewOpen(true)}
                >
                  Nova transação
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
          <div ref={listTop} className="scroll-mt-4" />
          {data.entries.length ? (
            <Table
              className={cn(
                'transition-opacity duration-150 sm:table-fixed',
                changingPage && 'opacity-60',
              )}
              aria-busy={changingPage}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead className="hidden w-44 md:table-cell">
                    Origem
                  </TableHead>
                  <TableHead className="hidden w-72 sm:table-cell">
                    Categoria
                  </TableHead>
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
                      const categoryCell = (
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
                      )
                      // Note, correction and link: in the title row on wider
                      // screens, beside the category on phones.
                      const rowActions = (
                        <>
                          <EntryNoteEditor
                            note={entry.note}
                            description={entry.description}
                            pending={
                              noteMutation.isPending &&
                              noteMutation.variables.entryId === entry.id
                            }
                            onSave={(note) =>
                              noteMutation.mutate({
                                entryId: entry.id,
                                note,
                              })
                            }
                          />
                          {entry.amountCents < 0 &&
                          !entry.category?.excludedFromSpending ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    className={cn(
                                      'shrink-0 text-muted-foreground',
                                      entry.oneOff && 'text-foreground',
                                    )}
                                    aria-pressed={entry.oneOff}
                                    aria-label={`${entry.oneOff ? 'Desmarcar' : 'Marcar'} ${displayDescription(entry.description)} como gasto pontual`}
                                    disabled={
                                      oneOffMutation.isPending &&
                                      oneOffMutation.variables.entryId ===
                                        entry.id
                                    }
                                    onClick={() =>
                                      oneOffMutation.mutate({
                                        entryId: entry.id,
                                        oneOff: !entry.oneOff,
                                      })
                                    }
                                  />
                                }
                              >
                                <Zap />
                              </TooltipTrigger>
                              <TooltipContent>
                                {entry.oneOff
                                  ? 'Gasto pontual: fora das médias · desmarcar'
                                  : 'Marcar como pontual: conta no mês, fica fora das médias'}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          {entry.manualId ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    className="shrink-0 text-muted-foreground"
                                    aria-label={`Corrigir ${displayDescription(entry.description)}, digitado por você`}
                                    onClick={() =>
                                      setEditing({
                                        externalId: entry.manualId!,
                                        accountId: entry.accountId,
                                        bookedOn: entry.bookedOn,
                                        amountCents: entry.amountCents,
                                        description: entry.description,
                                      })
                                    }
                                  />
                                }
                              >
                                <PencilLine />
                              </TooltipTrigger>
                              <TooltipContent>
                                Digitado por você · corrigir ou excluir
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
                        </>
                      )
                      return (
                        <TableRow key={entry.id}>
                          <TableCell className="w-full max-w-0 font-medium sm:w-auto sm:max-w-none">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate">
                                {displayDescription(entry.description)}
                              </span>
                              {entry.status === 'pending' ? (
                                <StatusBadge tone="warning">
                                  Provisória
                                </StatusBadge>
                              ) : null}
                              {entry.oneOff ? (
                                <StatusBadge>Pontual</StatusBadge>
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
                              <span className="hidden shrink-0 items-center sm:flex">
                                {rowActions}
                              </span>
                            </div>
                            {entry.note ? (
                              <p className="mt-0.5 truncate text-xs font-normal text-muted-foreground">
                                {entry.note}
                              </p>
                            ) : null}
                            <div className="mt-1 font-normal sm:hidden">
                              {categoryCell}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 text-xs font-normal text-muted-foreground md:hidden">
                              <span className="min-w-0 truncate">
                                {formatInstrumentName(account?.name ?? '—')}
                              </span>
                              <span className="ml-auto flex shrink-0 items-center sm:hidden">
                                {rowActions}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden truncate text-muted-foreground md:table-cell">
                            {formatInstrumentName(account?.name ?? '—')}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {categoryCell}
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
                            <ConvertedAmount converted={entry.converted} />
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
              <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                {changingPage ? <Spinner /> : null}
                Página {filters.page + 1} de {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === 0}
                onClick={() => goToPage(filters.page - 1)}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page + 1 >= pageCount}
                onClick={() => goToPage(filters.page + 1)}
              >
                Próxima
              </Button>
            </nav>
          )}
        </Panel>
      )}
      <ReconciliationReview />
      <LinkEntryDialog entry={linking} onClose={() => setLinking(null)} />
      <ManualTransactionDialog
        accounts={typable}
        categories={assignable}
        open={newOpen}
        onOpenChange={setNewOpen}
        trigger={null}
        defaultAccountId={target !== 'all' ? target : undefined}
      />
      {editing ? (
        <ManualTransactionDialog
          key={editing.externalId}
          accounts={accounts}
          categories={assignable}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          trigger={null}
          editing={editing}
        />
      ) : null}
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
  // Reconciliation's own category is read-only; a bill payment the person
  // marked stays editable.
  if (category?.system && entry.category.origin === 'reconciliation') {
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

/** The person's note on an entry: shown under the description, edited in place. */
function EntryNoteEditor({
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
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setDraft(note ?? '')
        setOpen(nextOpen)
      }}
    >
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
            const next = draft.trim() || null
            if (next !== note) onSave(next)
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
              maxLength={500}
              aria-label="Nota do lançamento"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {draft.length}/500
            </span>
            <div className="flex gap-2">
              {note ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    onSave(null)
                    setOpen(false)
                  }}
                >
                  Apagar
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : null}
                Salvar
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
