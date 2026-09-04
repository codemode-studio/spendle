import {
  ArrowLeftRight,
  Check,
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
import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Fragment, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

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
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
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
import {
  formatCurrency,
  formatInstrumentName,
  normalizeDescription,
  toCents,
} from '#/domain/finance'
import {
  categorizeUncategorizedTransactionsWithAiFn,
  setReconciliationStatusFn,
  updateTransactionCategoryFn,
} from '#/features/finance/finance.functions'
import {
  financeQueryKeys,
  financeSnapshotOptions,
} from '#/features/finance/queries'
import { groupCategoryOptions } from '#/domain/categories'
import { cn } from '#/lib/utils'

const transactionsSearchSchema = z.object({
  category: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/transacoes')({
  validateSearch: transactionsSearchSchema,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(financeSnapshotOptions()),
  component: TransactionsPage,
})

function TransactionsPage() {
  const { data } = useSuspenseQuery(financeSnapshotOptions())
  const queryClient = useQueryClient()
  const updateCategory = useServerFn(updateTransactionCategoryFn)
  const categorizeWithAi = useServerFn(
    categorizeUncategorizedTransactionsWithAiFn,
  )
  const setReconciliation = useServerFn(setReconciliationStatusFn)
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState('all')
  const { category: initialCategory } = Route.useSearch()
  const [onlyUncategorized, setOnlyUncategorized] = useState(
    initialCategory === 'uncategorized',
  )
  const [categoryFilter, setCategoryFilter] = useState(
    initialCategory && initialCategory !== 'uncategorized'
      ? initialCategory
      : 'all',
  )
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const minCents = parseAmountInput(minAmount)
  const maxCents = parseAmountInput(maxAmount)
  const hasActiveFilters =
    search !== '' ||
    target !== 'all' ||
    onlyUncategorized ||
    categoryFilter !== 'all' ||
    direction !== 'all' ||
    minCents !== null ||
    maxCents !== null
  const clearFilters = () => {
    setSearch('')
    setTarget('all')
    setOnlyUncategorized(false)
    setCategoryFilter('all')
    setDirection('all')
    setMinAmount('')
    setMaxAmount('')
  }
  const clearAdvancedFilters = () => {
    setTarget('all')
    setCategoryFilter('all')
    setMinAmount('')
    setMaxAmount('')
  }
  const segment = onlyUncategorized ? 'uncategorized' : direction
  const advancedFilterCount =
    Number(target !== 'all') +
    Number(categoryFilter !== 'all') +
    Number(minCents !== null || maxCents !== null)
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
  const snapshotKey = financeQueryKeys.snapshot()
  const categoryMutation = useMutation({
    mutationFn: updateCategory,
    // Atualização otimista: a linha muda na hora, sem travar as outras.
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: snapshotKey })
      const previous = queryClient.getQueryData<typeof data>(snapshotKey)
      queryClient.setQueryData<typeof data>(snapshotKey, (old) =>
        old
          ? {
              ...old,
              transactions: old.transactions.map((transaction) =>
                transaction.id === variables.data.transactionId
                  ? {
                      ...transaction,
                      categoryId: variables.data.categoryId,
                      category:
                        old.categories.find(
                          (category) =>
                            category.id === variables.data.categoryId,
                        ) ?? transaction.category,
                    }
                  : transaction,
              ),
            }
          : old,
      )
      return { previous }
    },
    onSuccess: () => invalidate(),
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(snapshotKey, context.previous)
      }
      toast.error(error instanceof Error ? error.message : 'Erro ao atualizar.')
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

  const uncategorizedCount = data.transactions.filter(
    (transaction) =>
      transaction.status === 'confirmed' &&
      (!transaction.categoryId || transaction.categoryId === 'uncategorized'),
  ).length

  // Só categorias com lançamentos no período aparecem no filtro (com a
  // contagem), para a lista não virar a taxonomia inteira.
  const categoryGroups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const transaction of data.transactions) {
      if (!transaction.categoryId || transaction.categoryId === 'uncategorized')
        continue
      counts.set(
        transaction.categoryId,
        (counts.get(transaction.categoryId) ?? 0) + 1,
      )
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
  }, [data.transactions, data.categories, categoryFilter])

  const transactions = useMemo(
    () =>
      data.transactions.filter((transaction) => {
        const matchesSearch =
          !search ||
          normalizeDescription(transaction.description).includes(
            normalizeDescription(search),
          )
        const matchesTarget =
          target === 'all' ||
          transaction.accountId === target ||
          transaction.creditCardId === target
        const matchesUncategorized =
          !onlyUncategorized ||
          !transaction.categoryId ||
          transaction.categoryId === 'uncategorized'
        const matchesCategory =
          categoryFilter === 'all' || transaction.categoryId === categoryFilter
        const signedCents =
          transaction.baseAmountCents ??
          (transaction.currency === 'BRL' ? transaction.amountCents : null) ??
          transaction.amountCents
        const matchesDirection =
          direction === 'all' ||
          (direction === 'in' ? signedCents > 0 : signedCents < 0)
        const magnitude = Math.abs(signedCents)
        const matchesAmount =
          (minCents === null || magnitude >= minCents) &&
          (maxCents === null || magnitude <= maxCents)
        return (
          matchesSearch &&
          matchesTarget &&
          matchesUncategorized &&
          matchesCategory &&
          matchesDirection &&
          matchesAmount
        )
      }),
    [
      data.transactions,
      search,
      target,
      onlyUncategorized,
      categoryFilter,
      direction,
      minCents,
      maxCents,
    ],
  )
  const dayGroups = useMemo(() => {
    const groups = new Map<string, typeof transactions>()
    for (const transaction of transactions) {
      const list = groups.get(transaction.postedAt) ?? []
      list.push(transaction)
      groups.set(transaction.postedAt, list)
    }
    return [...groups.entries()]
  }, [transactions])
  const periodLabel = formatPeriod(
    data.transactions.map((transaction) => transaction.postedAt),
  )

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
      clear: () => {
        setMinAmount('')
        setMaxAmount('')
      },
    },
  ].filter((chip): chip is Exclude<typeof chip, false> => Boolean(chip))
  const suggestedReconciliations = data.reconciliations.filter(
    (item) => item.status === 'suggested',
  )
  const reconciliationHistory = data.reconciliations.filter(
    (item) => item.status !== 'suggested',
  )
  const hasTransactions = data.transactions.length > 0

  return (
    <Page>
      <PageHeader
        title="Transações"
        description={
          hasTransactions
            ? `${data.transactions.length} lançamentos · ${periodLabel}`
            : 'Nenhum lançamento registrado ainda.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <ManualTransactionDialog
              accounts={data.accounts}
              cards={data.cards}
              categories={data.categories}
            />
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
                    setOnlyUncategorized(true)
                    setDirection('all')
                    setCategoryFilter('all')
                    return
                  }
                  setOnlyUncategorized(false)
                  setDirection(value as 'all' | 'in' | 'out')
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
                <div className="relative w-full sm:w-64">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Buscar descrição…"
                    className="pl-8 md:pl-8"
                    aria-label="Buscar transações"
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
                          setOnlyUncategorized(false)
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
                        {transactions.length} de {data.transactions.length}
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
                  Limpar tudo · {transactions.length} de{' '}
                  {data.transactions.length}
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
                          </div>
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

/** Aceita "1500", "1.500,50" ou "R$ 1500". Vazio ou inválido vira null. */
function parseAmountInput(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return Math.abs(toCents(trimmed))
  } catch {
    return null
  }
}

function AmountCell({
  amountCents,
  currency,
  baseAmountCents,
}: {
  amountCents: number
  currency: string
  baseAmountCents: number | null
}) {
  const baseCents = baseAmountCents ?? (currency === 'BRL' ? amountCents : null)
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

function formatDayLabel(iso: string) {
  const today = new Date()
  const localToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  )
  const date = new Date(`${iso}T12:00:00`)
  const diffDays = Math.round(
    (localToday.getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  )
  if (diffDays === 0) return 'Hoje'
  if (diffDays === 1) return 'Ontem'
  const label = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  }).format(date)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function formatPeriod(dates: Array<string>) {
  if (dates.length === 0) return ''
  const sorted = [...dates].sort()
  const first = new Date(`${sorted[0]}T12:00:00`)
  const last = new Date(`${sorted[sorted.length - 1]}T12:00:00`)
  const month = (date: Date) =>
    new Intl.DateTimeFormat('pt-BR', { month: 'short' })
      .format(date)
      .replace('.', '')
  if (
    first.getFullYear() === last.getFullYear() &&
    first.getMonth() === last.getMonth()
  ) {
    return `${month(first)} ${first.getFullYear()}`
  }
  if (first.getFullYear() === last.getFullYear()) {
    return `${month(first)} a ${month(last)} ${last.getFullYear()}`
  }
  return `${month(first)} ${first.getFullYear()} a ${month(last)} ${last.getFullYear()}`
}
