import {
  ArrowLeftRight,
  Check,
  ReceiptText,
  Search,
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
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { EmptyState, PageHeader, Panel, StatusBadge } from '#/components/ui'
import { CategorySelect } from '#/components/category-select'
import { TransferAccountSelect } from '#/components/transfer-account-select'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
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

export const Route = createFileRoute('/transacoes')({
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
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
  const categoryMutation = useMutation({
    mutationFn: updateCategory,
    onSuccess: () => {
      toast.success('Categoria atualizada.')
      invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Erro ao atualizar.',
      ),
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
        return matchesSearch && matchesTarget
      }),
    [data.transactions, search, target],
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
  const suggestedReconciliations = data.reconciliations.filter(
    (item) => item.status === 'suggested',
  )
  const reconciliationHistory = data.reconciliations.filter(
    (item) => item.status !== 'suggested',
  )
  const hasTransactions = data.transactions.length > 0

  return (
    <div className="page">
      <PageHeader
        eyebrow="Conciliação"
        title="Transações"
        description="Consulte lançamentos, categorias e conciliações."
        actions={
          uncategorizedCount > 0 ? (
            <Button
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
          ) : undefined
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
                : 'Importe um extrato para começar.'
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
          <div className="mb-4 flex flex-col gap-3 md:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar descrição…"
                className="pl-8"
                aria-label="Buscar transações"
              />
            </div>
            <NativeSelect
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="w-full md:w-64"
              aria-label="Filtrar por conta ou cartão"
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
          </div>
          {transactions.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((transaction) => (
                  <TableRow key={transaction.id}>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {new Date(
                        `${transaction.postedAt}T12:00:00`,
                      ).toLocaleDateString('pt-BR')}
                    </TableCell>
                    <TableCell className="max-w-72 font-medium">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate">
                          {transaction.description}
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
                    <TableCell className="text-muted-foreground">
                      {formatInstrumentName(
                        transaction.account?.name ??
                          transaction.creditCard?.name ??
                          '—',
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-64 flex-col gap-2">
                        <CategorySelect
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
                          disabled={categoryMutation.isPending}
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
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatCurrency(
                        transaction.amountCents,
                        transaction.currency,
                      )}
                    </TableCell>
                  </TableRow>
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
    </div>
  )
}
