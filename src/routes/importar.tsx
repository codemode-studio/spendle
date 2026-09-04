import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleCheck,
  CircleX,
  Clock3,
  FileClock,
  FileSearch,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
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
import { TransferAccountSelect } from '#/components/transfer-account-select'
import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Separator } from '#/components/ui/separator'
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
import { formatCurrency } from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatPeriod } from '#/domain/period'
import {
  commitImportFn,
  confirmImportCoverageFn,
  linkStatementObservationFn,
  rejectImportFn,
  replaceConflictingCheckpointFn,
  retryImportFinalizationFn,
  resolveStatementExclusionFn,
  resolveTransactionCorrectionFn,
  stageImportFn,
  updateStagedTransactionCategoryFn,
} from '#/features/finance/finance.functions'
import type { getImportReviewSnapshotFn } from '#/features/finance/finance.functions'
import {
  financeQueryKeys,
  importReviewOptions,
} from '#/features/finance/queries'
import { cn } from '#/lib/utils'

const importSearchSchema = z.object({
  view: z.enum(['upload', 'review']).optional().catch(undefined),
})

export const Route = createFileRoute('/importar')({
  validateSearch: importSearchSchema,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(importReviewOptions()),
  component: ImportPage,
})

type ImportFlow = 'upload' | 'review'

function ImportPage() {
  const { view } = Route.useSearch()
  const navigate = Route.useNavigate()
  const flow: ImportFlow = view ?? 'upload'
  const { data } = useSuspenseQuery(importReviewOptions())
  const queryClient = useQueryClient()
  const stageImport = useServerFn(stageImportFn)
  const commitImport = useServerFn(commitImportFn)
  const rejectImport = useServerFn(rejectImportFn)
  const replaceConflictingCheckpoint = useServerFn(
    replaceConflictingCheckpointFn,
  )
  const retryImportFinalization = useServerFn(retryImportFinalizationFn)
  const resolveCorrection = useServerFn(resolveTransactionCorrectionFn)
  const linkStatementObservation = useServerFn(linkStatementObservationFn)
  const resolveStatementExclusion = useServerFn(resolveStatementExclusionFn)
  const updateStagedCategory = useServerFn(updateStagedTransactionCategoryFn)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedTarget, setSelectedTarget] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [aiConsent, setAiConsent] = useState(false)
  const [confirmedReviews, setConfirmedReviews] = useState<Set<string>>(
    () => new Set(),
  )
  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: financeQueryKeys.importReview(),
    })
    await queryClient.invalidateQueries({
      queryKey: financeQueryKeys.snapshots(),
      refetchType: 'none',
    })
  }

  const stageMutation = useMutation({
    mutationFn: stageImport,
    onSuccess: async (result) => {
      const processed = result.importIds.length
      const processedLabel =
        processed === 1 ? 'arquivo processado' : 'arquivos processados'
      const reusedLabel =
        result.reused === 1
          ? '1 arquivo já estava no histórico.'
          : `${result.reused} arquivos já estavam no histórico.`

      toast.success(
        result.requiresReview
          ? `${processed} ${processedLabel}.${result.reused ? ` ${reusedLabel}` : ''}`
          : processed > result.reused
            ? 'Fatura conferida e consolidada automaticamente, sem duplicar lançamentos.'
            : 'Arquivo já importado. Nenhuma transação nova foi criada.',
      )
      await invalidate()
      setSelectedTarget('')
      setSelectedFiles([])
      setAiConsent(false)
      if (result.requiresReview) {
        void navigate({ search: { view: 'review' } })
      }
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Falha na importação.',
      ),
  })
  const commitMutation = useMutation({
    mutationFn: commitImport,
    onSuccess: async (result, variables) => {
      toast.success(`${result.committed} transações consolidadas.`)
      if (result.postCommit?.status === 'deferred') {
        toast.warning(
          'A importação foi salva, mas algumas atualizações derivadas ficaram pendentes.',
          {
            action: {
              label: 'Tentar novamente',
              onClick: () => {
                void retryImportFinalization({
                  data: { importId: variables.data.importId },
                })
                  .then(async (retryResult) => {
                    if (retryResult.status === 'completed') {
                      toast.success('Atualizações pendentes concluídas.')
                    } else {
                      toast.warning('Algumas atualizações continuam pendentes.')
                    }
                    await invalidate()
                  })
                  .catch((error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : 'Falha ao repetir a finalização.',
                    ),
                  )
              },
            },
          },
        )
      }
      await invalidate()
    },
    onError: (error) => {
      invalidate()
      toast.error(
        error instanceof Error ? error.message : 'Falha ao consolidar.',
      )
    },
  })
  const rejectMutation = useMutation({
    mutationFn: rejectImport,
    onSuccess: () => {
      toast.success('Lote rejeitado.')
      invalidate()
    },
  })
  const replaceCheckpointMutation = useMutation({
    mutationFn: replaceConflictingCheckpoint,
    onSuccess: (result) => {
      toast.success(
        `${result.invalidated} ponto(s) de controle anterior(es) invalidado(s). Revise e consolide o arquivo.`,
      )
      if (result.reconciliationRefresh.status === 'deferred') {
        toast.warning(
          'Os checkpoints foram atualizados, mas a reconciliação derivada ficou pendente.',
        )
      }
      invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível substituir o saldo anterior.',
      ),
  })
  const categoryMutation = useMutation({
    mutationFn: updateStagedCategory,
    onSuccess: () => invalidate(),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Falha ao alterar categoria.',
      ),
  })
  const correctionMutation = useMutation({
    mutationFn: resolveCorrection,
    onSuccess: (_, variables) => {
      toast.success(
        variables.data.action === 'accept'
          ? 'Correção aplicada. Os saldos posteriores precisam ser conferidos novamente.'
          : 'Correção rejeitada. O lançamento original foi preservado.',
      )
      invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Falha ao revisar a correção.',
      ),
  })
  const statementLinkMutation = useMutation({
    mutationFn: linkStatementObservation,
    onSuccess: () => {
      toast.success(
        'Lançamento vinculado. Confira a correção e consolide a fatura.',
      )
      invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível vincular o lançamento.',
      ),
  })
  const statementExclusionMutation = useMutation({
    mutationFn: resolveStatementExclusion,
    onSuccess: (_, variables) => {
      toast.success(
        variables.data.action === 'exclude'
          ? 'Autorização marcada como ausente da fatura.'
          : 'Exclusão desfeita. A diferença voltou para revisão.',
      )
      invalidate()
      if (variables.data.action === 'restore') {
        setHistoryOpen(false)
        void navigate({ search: { view: 'review' } })
      }
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível atualizar a autorização.',
      ),
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTarget || !selectedFiles.length) return

    const [targetType, targetId] = selectedTarget.split(':')
    const form = new FormData()
    form.set('targetType', targetType)
    form.set('targetId', targetId)
    form.set('aiConsent', String(aiConsent))
    selectedFiles.forEach((file) => form.append('files', file))
    stageMutation.mutate({ data: form })
  }

  function setReviewConfirmed(importId: string, confirmed: boolean) {
    setConfirmedReviews((current) => {
      const next = new Set(current)
      if (confirmed) next.add(importId)
      else next.delete(importId)
      return next
    })
  }

  const reviewImports = data.imports.filter(
    (item) => item.status === 'review' && !item.dependsOnImportId,
  )

  function startNewImport() {
    setSelectedTarget('')
    setSelectedFiles([])
    setAiConsent(false)
    void navigate({ search: { view: 'upload' } })
  }

  return (
    <Page>
      <PageHeader
        eyebrow="OFX, CSV e PDF"
        title="Importar extratos"
        description="Envie os arquivos e revise os lançamentos antes de consolidar."
        actions={
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label="Abrir histórico de importações"
            title="Histórico"
            onClick={() => setHistoryOpen(true)}
          >
            <Clock3 />
          </Button>
        }
      />

      <ImportFlowSteps flow={flow} />

      {flow === 'upload' ? (
        <Panel
          className="mx-auto max-w-2xl"
          title="Enviar arquivos"
          description="Escolha uma conta ou cartão e selecione os extratos."
        >
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="target">Conta ou cartão</FieldLabel>
                <NativeSelect
                  id="target"
                  className="w-full"
                  value={selectedTarget}
                  onChange={(event) => setSelectedTarget(event.target.value)}
                  required
                >
                  <NativeSelectOption value="">
                    Selecione o destino do extrato
                  </NativeSelectOption>
                  {data.accounts.map((account) => (
                    <NativeSelectOption
                      key={account.id}
                      value={`account:${account.id}`}
                    >
                      Conta · {formatInstrumentName(account.name)}
                    </NativeSelectOption>
                  ))}
                  {data.cards.map((card) => (
                    <NativeSelectOption key={card.id} value={`card:${card.id}`}>
                      Cartão · {formatInstrumentName(card.name)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>

              <Field>
                <FieldLabel htmlFor="files">Arquivos</FieldLabel>
                <label
                  htmlFor="files"
                  className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-5 py-6 text-center transition-colors hover:bg-muted/50 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
                >
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Upload className="size-4" />
                  </span>
                  <span className="text-sm font-medium">
                    {selectedFiles.length
                      ? `${selectedFiles.length} ${selectedFiles.length === 1 ? 'arquivo selecionado' : 'arquivos selecionados'}`
                      : 'Selecionar arquivos'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    OFX, CSV ou PDF · até 24 arquivos · 20 MB cada
                  </span>
                  <Input
                    id="files"
                    type="file"
                    className="sr-only"
                    accept=".ofx,.csv,.pdf,text/csv,application/pdf"
                    multiple
                    onChange={(event) =>
                      setSelectedFiles(
                        Array.from(event.currentTarget.files ?? []),
                      )
                    }
                    required
                  />
                </label>
              </Field>

              {selectedFiles.length ? (
                <ul className="divide-y overflow-hidden rounded-lg border">
                  {selectedFiles.map((file) => (
                    <li
                      key={`${file.name}-${file.lastModified}`}
                      className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <FileSearch className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatFileSize(file.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <Field orientation="horizontal">
                <Checkbox
                  id="aiConsent"
                  checked={aiConsent}
                  onCheckedChange={setAiConsent}
                />
                <FieldContent>
                  <FieldLabel htmlFor="aiConsent">
                    Usar IA se um PDF não tiver texto
                  </FieldLabel>
                  <FieldDescription>
                    A IA só ajuda na leitura. A revisão continua obrigatória.
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>

            <Separator className="my-6" />
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0" />
                Os arquivos ficam neste computador.
              </p>
              <Button
                type="submit"
                size="lg"
                disabled={
                  stageMutation.isPending ||
                  !selectedTarget ||
                  !selectedFiles.length
                }
              >
                {stageMutation.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ArrowRight data-icon="inline-end" />
                )}
                {stageMutation.isPending ? 'Lendo arquivos…' : 'Continuar'}
              </Button>
            </div>
          </form>
        </Panel>
      ) : (
        <Panel
          className="mx-auto max-w-5xl"
          title="Revisar lançamentos"
          description="Confira a auditoria e as categorias antes de consolidar."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startNewImport}
            >
              <Upload data-icon="inline-start" />
              Novo lote
            </Button>
          }
        >
          {reviewImports.length ? (
            <div className="flex flex-col">
              {reviewImports.map((item, index) => (
                <section
                  key={item.id}
                  className={cn(index > 0 && 'mt-8 border-t pt-8')}
                  aria-labelledby={`import-${item.id}-title`}
                >
                  <div className="mb-4 flex flex-col justify-between gap-3 md:flex-row md:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileSearch className="size-4 text-primary" />
                        <strong
                          id={`import-${item.id}-title`}
                          className="truncate text-sm"
                        >
                          {item.sourceFile?.originalName ?? 'Arquivo'}
                        </strong>
                        <StatusBadge tone="warning">Revisão</StatusBadge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatInstrumentName(
                          item.target?.name ?? 'Destino removido',
                        )}{' '}
                        · {item.staged.length} lançamentos ·{' '}
                        {item.staged.filter((row) => row.duplicate).length}{' '}
                        duplicidades
                      </p>
                      {item.warning ? (
                        <p className="mt-1 text-xs text-destructive">
                          {item.warning}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {item.conflictingCheckpoint ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={replaceCheckpointMutation.isPending}
                          onClick={() => {
                            const confirmed = window.confirm(
                              'Substituir o saldo anterior? O ponto conflitante e todas as conferências posteriores serão invalidados no histórico para nova revisão.',
                            )
                            if (confirmed) {
                              replaceCheckpointMutation.mutate({
                                data: { importId: item.id },
                              })
                            }
                          }}
                        >
                          <AlertTriangle data-icon="inline-start" />
                          Substituir saldo anterior
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rejectMutation.isPending}
                        onClick={() =>
                          rejectMutation.mutate({
                            data: { importId: item.id },
                          })
                        }
                      >
                        <X data-icon="inline-start" />
                        Rejeitar
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          commitMutation.mutate({
                            data: {
                              importId: item.id,
                              manualReviewConfirmed: confirmedReviews.has(
                                item.id,
                              ),
                            },
                          })
                        }
                        disabled={
                          commitMutation.isPending ||
                          item.validationStatus === 'divergent' ||
                          needsCoverageConfirmation(item) ||
                          hasIncompleteTransfer(item) ||
                          (item.validationStatus === 'warning' &&
                            !confirmedReviews.has(item.id))
                        }
                        title={
                          item.validationStatus === 'divergent'
                            ? 'Resolva a divergência antes de consolidar.'
                            : needsCoverageConfirmation(item)
                              ? 'Confirme o período exportado antes de consolidar.'
                              : hasIncompleteTransfer(item)
                                ? 'Selecione a conta relacionada em todas as transferências.'
                                : item.validationStatus === 'warning' &&
                                    !confirmedReviews.has(item.id)
                                  ? 'Confirme a revisão manual antes de consolidar.'
                                  : undefined
                        }
                      >
                        <Check data-icon="inline-start" />
                        Consolidar
                      </Button>
                    </div>
                  </div>

                  <ImportAuditReport
                    item={item}
                    manualReviewConfirmed={confirmedReviews.has(item.id)}
                    onManualReviewChange={(confirmed) =>
                      setReviewConfirmed(item.id, confirmed)
                    }
                  />

                  {item.statementMissingCandidates.length ||
                  item.statementExclusions.some(
                    (exclusion) => !exclusion.reversedAt,
                  ) ? (
                    <Alert className="mb-4">
                      <AlertTriangle />
                      <AlertTitle>
                        Autorizações que não constam na fatura
                      </AlertTitle>
                      <AlertDescription className="flex flex-col gap-3">
                        <p>
                          Confirme apenas autorizações canceladas ou expiradas.
                          Elas serão retiradas dos totais, mas continuarão no
                          histórico de auditoria e poderão ser restauradas.
                        </p>
                        {item.statementMissingCandidates.map((candidate) => (
                          <div
                            key={candidate.id}
                            className="flex flex-col justify-between gap-2 rounded-lg border bg-background p-3 sm:flex-row sm:items-center"
                          >
                            <span className="text-sm">
                              {candidate.postedAt} · {candidate.description} ·{' '}
                              {formatCurrency(
                                candidate.amountCents,
                                candidate.currency,
                              )}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={statementExclusionMutation.isPending}
                              onClick={() =>
                                statementExclusionMutation.mutate({
                                  data: {
                                    importId: item.id,
                                    transactionId: candidate.id,
                                    action: 'exclude',
                                  },
                                })
                              }
                            >
                              Confirmar que não consta
                            </Button>
                          </div>
                        ))}
                        {item.statementExclusions
                          .filter((exclusion) => !exclusion.reversedAt)
                          .map((exclusion) => (
                            <div
                              key={exclusion.id}
                              className="flex flex-col justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 sm:flex-row sm:items-center"
                            >
                              <span className="text-sm">
                                Excluída:{' '}
                                {exclusion.transaction
                                  ? `${exclusion.transaction.postedAt} · ${exclusion.transaction.description} · ${formatCurrency(exclusion.transaction.amountCents, exclusion.transaction.currency)}`
                                  : 'lançamento removido'}
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={statementExclusionMutation.isPending}
                                onClick={() =>
                                  statementExclusionMutation.mutate({
                                    data: {
                                      importId: item.id,
                                      transactionId: exclusion.transactionId,
                                      action: 'restore',
                                    },
                                  })
                                }
                              >
                                Desfazer
                              </Button>
                            </div>
                          ))}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {item.validationStatus === 'divergent' &&
                  item.parser === 'pdf_inspector' &&
                  item.statementMatchCandidates.some(({ candidates }) =>
                    candidates.some(
                      (candidate) =>
                        !item.staged.some(
                          (row) =>
                            row.postedAt === candidate.postedAt &&
                            row.amountCents === candidate.amountCents &&
                            row.currency === candidate.currency,
                        ),
                    ),
                  ) ? (
                    <Alert className="mb-4">
                      <FileSearch />
                      <AlertTitle>Vincule as diferenças da fatura</AlertTitle>
                      <AlertDescription className="flex flex-col gap-3">
                        <p>
                          O banco pode mudar a data, a descrição ou o valor
                          entre o extrato aberto e a fatura final. Escolha o
                          lançamento pendente correspondente; a alteração ficará
                          registrada na auditoria.
                        </p>
                        {item.statementMatchCandidates.map((group) => {
                          const observation = item.staged.find(
                            (row) => row.id === group.stagedTransactionId,
                          )
                          if (!observation) return null
                          const candidates = group.candidates.filter(
                            (candidate) =>
                              !(
                                candidate.postedAt === observation.postedAt &&
                                candidate.amountCents ===
                                  observation.amountCents &&
                                candidate.currency === observation.currency
                              ),
                          )
                          if (!candidates.length) return null
                          return (
                            <div
                              key={group.stagedTransactionId}
                              className="rounded-lg border bg-background p-3"
                            >
                              <div className="text-sm font-medium">
                                No PDF: {observation.postedAt} ·{' '}
                                {observation.description} ·{' '}
                                {formatCurrency(
                                  observation.amountCents,
                                  observation.currency,
                                )}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {candidates.slice(0, 5).map((candidate) => (
                                  <Button
                                    key={candidate.id}
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={statementLinkMutation.isPending}
                                    onClick={() =>
                                      statementLinkMutation.mutate({
                                        data: {
                                          stagedTransactionId: observation.id,
                                          transactionId: candidate.id,
                                        },
                                      })
                                    }
                                  >
                                    Vincular a {candidate.postedAt} ·{' '}
                                    {candidate.description} ·{' '}
                                    {formatCurrency(
                                      candidate.amountCents,
                                      candidate.currency,
                                    )}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {item.corrections
                    .filter((correction) => correction.status === 'pending')
                    .map((correction) => {
                      const observation = item.staged.find(
                        (row) => row.id === correction.stagedTransactionId,
                      )
                      return (
                        <Alert
                          key={correction.id}
                          variant="destructive"
                          className="mb-4"
                        >
                          <AlertTriangle />
                          <AlertTitle>
                            O banco corrigiu uma transação já importada
                          </AlertTitle>
                          <AlertDescription className="flex flex-col gap-3">
                            <p>
                              {observation
                                ? `${observation.description} · ${formatCurrency(observation.amountCents, observation.currency)}`
                                : 'Compare a nova observação com o lançamento atual.'}{' '}
                              Nada foi alterado automaticamente.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                onClick={() =>
                                  correctionMutation.mutate({
                                    data: {
                                      correctionId: correction.id,
                                      action: 'accept',
                                    },
                                  })
                                }
                              >
                                Aceitar correção
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  correctionMutation.mutate({
                                    data: {
                                      correctionId: correction.id,
                                      action: 'reject',
                                    },
                                  })
                                }
                              >
                                Manter original
                              </Button>
                            </div>
                          </AlertDescription>
                        </Alert>
                      )
                    })}

                  <div className="max-h-80 overflow-auto rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Data</TableHead>
                          <TableHead>Descrição</TableHead>
                          <TableHead>Categoria</TableHead>
                          <TableHead>Valor</TableHead>
                          <TableHead>Evidência</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {item.staged.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="tabular-nums text-muted-foreground">
                              {row.postedAt}
                            </TableCell>
                            <TableCell>{row.description}</TableCell>
                            <TableCell>
                              <div className="flex min-w-52 flex-col gap-1.5">
                                <CategorySelect
                                  categories={data.categories}
                                  value={
                                    row.suggestedCategoryId ?? 'uncategorized'
                                  }
                                  disabled={categoryMutation.isPending}
                                  aria-label={`Categoria de ${row.description}`}
                                  onValueChange={(categoryId) =>
                                    categoryMutation.mutate({
                                      data: {
                                        stagedTransactionId: row.id,
                                        categoryId,
                                        counterpartyAccountId:
                                          categoryId === 'transfer'
                                            ? row.counterpartyAccountId
                                            : null,
                                      },
                                    })
                                  }
                                  allowTransfer={Boolean(item.accountId)}
                                />
                                {row.suggestedCategoryId === 'transfer' &&
                                item.accountId ? (
                                  <TransferAccountSelect
                                    accounts={data.accounts}
                                    sourceAccountId={item.accountId}
                                    amountCents={row.amountCents}
                                    value={row.counterpartyAccountId}
                                    disabled={categoryMutation.isPending}
                                    onValueChange={(accountId) =>
                                      categoryMutation.mutate({
                                        data: {
                                          stagedTransactionId: row.id,
                                          categoryId: 'transfer',
                                          counterpartyAccountId: accountId,
                                        },
                                      })
                                    }
                                  />
                                ) : null}
                                <Badge variant="outline">
                                  {suggestionSourceLabels[
                                    row.suggestionSource
                                  ] ?? 'Sugestão'}
                                  {' · '}
                                  {row.suggestionConfidence ?? 0}%
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {formatCurrency(row.amountCents, row.currency)}
                            </TableCell>
                            <TableCell>
                              {row.sourcePage ? (
                                <Badge variant="outline">
                                  Página {row.sourcePage}
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  Estruturada
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {row.duplicate ? (
                                <StatusBadge tone="danger">
                                  Duplicada
                                </StatusBadge>
                              ) : (
                                <StatusBadge tone="success">Nova</StatusBadge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={FileSearch}
              title="Nenhum lote para revisar"
              description="Envie um extrato para iniciar uma nova revisão."
              action={
                <Button type="button" onClick={startNewImport}>
                  <Upload data-icon="inline-start" />
                  Enviar extrato
                </Button>
              }
            />
          )}
        </Panel>
      )}

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="right"
          className="!w-full sm:!max-w-md [transition-property:transform,opacity] [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"
        >
          <SheetHeader className="pr-12">
            <SheetTitle>Histórico de importações</SheetTitle>
            <SheetDescription>
              Lotes enviados, pendentes e concluídos.
            </SheetDescription>
          </SheetHeader>
          <Separator />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {data.imports.length ? (
              <div className="divide-y">
                {data.imports.map((item) => (
                  <div key={item.id} className="flex gap-3 py-4">
                    <FileClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.sourceFile?.originalName ?? 'Arquivo'}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatInstrumentName(
                          item.target?.name ?? 'Destino removido',
                        )}{' '}
                        · {formatImportPeriod(item.periodStart, item.periodEnd)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            item.status === 'committed'
                              ? 'secondary'
                              : item.status === 'failed'
                                ? 'destructive'
                                : 'outline'
                          }
                        >
                          {importStatusLabels[item.status] ?? item.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {item.parsedTransactionCount} lançamentos
                        </span>
                      </div>
                      {item.statementExclusions
                        .filter((exclusion) => !exclusion.reversedAt)
                        .map((exclusion) => (
                          <div
                            key={exclusion.id}
                            className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-2.5"
                          >
                            <p className="text-xs text-muted-foreground">
                              Autorização ausente:{' '}
                              {exclusion.transaction?.description ??
                                'lançamento removido'}
                            </p>
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              className="mt-1 h-auto p-0"
                              disabled={statementExclusionMutation.isPending}
                              onClick={() =>
                                statementExclusionMutation.mutate({
                                  data: {
                                    importId: item.id,
                                    transactionId: exclusion.transactionId,
                                    action: 'restore',
                                  },
                                })
                              }
                            >
                              Restaurar e revisar novamente
                            </Button>
                          </div>
                        ))}
                    </div>
                    {item.status === 'review' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setHistoryOpen(false)
                          void navigate({ search: { view: 'review' } })
                        }}
                      >
                        Revisar
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={FileClock}
                title="Nenhuma importação"
                description="Os lotes enviados aparecerão aqui."
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Page>
  )
}

function ImportFlowSteps({ flow }: { flow: ImportFlow }) {
  const reviewing = flow === 'review'

  return (
    <ol
      className="mx-auto mb-5 flex max-w-2xl items-center gap-3 text-sm"
      aria-label="Etapas da importação"
    >
      <li
        className={cn(
          'flex items-center gap-2 font-medium',
          reviewing ? 'text-muted-foreground' : 'text-foreground',
        )}
        aria-current={reviewing ? undefined : 'step'}
      >
        <span
          className={cn(
            'flex size-7 items-center justify-center rounded-full border text-xs tabular-nums',
            reviewing
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-primary text-primary',
          )}
        >
          {reviewing ? <Check className="size-3.5" /> : '1'}
        </span>
        Enviar
      </li>
      <li className="h-px flex-1 bg-border" aria-hidden="true" />
      <li
        className={cn(
          'flex items-center gap-2 font-medium',
          reviewing ? 'text-foreground' : 'text-muted-foreground',
        )}
        aria-current={reviewing ? 'step' : undefined}
      >
        <span
          className={cn(
            'flex size-7 items-center justify-center rounded-full border text-xs tabular-nums',
            reviewing && 'border-primary text-primary',
          )}
        >
          2
        </span>
        Revisar
      </li>
    </ol>
  )
}

type ImportItem = Awaited<
  ReturnType<typeof getImportReviewSnapshotFn>
>['imports'][number]

function hasIncompleteTransfer(item: ImportItem) {
  return item.staged.some(
    (row) =>
      !row.duplicate &&
      row.suggestedCategoryId === 'transfer' &&
      !row.counterpartyAccountId,
  )
}

function needsCoverageConfirmation(item: ImportItem) {
  return item.periodSource === 'activity' || item.periodSource === 'unknown'
}

function ImportCoverageConfirmation({ item }: { item: ImportItem }) {
  const queryClient = useQueryClient()
  const confirmCoverage = useServerFn(confirmImportCoverageFn)
  const mutation = useMutation({
    mutationFn: confirmCoverage,
    onSuccess: () => {
      toast.success('Período de cobertura confirmado.')
      queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível confirmar o período.',
      ),
  })

  if (item.periodSource !== 'activity' && item.periodSource !== 'unknown') {
    return null
  }

  return (
    <Alert>
      <FileSearch />
      <AlertTitle>Confirme o período exportado</AlertTitle>
      <AlertDescription>
        <p>
          O arquivo informa apenas os dias em que houve movimentação. Digite o
          intervalo escolhido no banco para não criar lacunas falsas.
        </p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            mutation.mutate({
              data: {
                importId: item.id,
                periodStart: String(form.get('periodStart')),
                periodEnd: String(form.get('periodEnd')),
              },
            })
          }}
        >
          <Field>
            <FieldLabel htmlFor={`period-start-${item.id}`}>Início</FieldLabel>
            <Input
              id={`period-start-${item.id}`}
              name="periodStart"
              type="date"
              defaultValue={item.periodStart ?? ''}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`period-end-${item.id}`}>Fim</FieldLabel>
            <Input
              id={`period-end-${item.id}`}
              name="periodEnd"
              type="date"
              defaultValue={item.periodEnd ?? ''}
              required
            />
          </Field>
          <Button type="submit" variant="outline" disabled={mutation.isPending}>
            {mutation.isPending ? 'Salvando…' : 'Confirmar período'}
          </Button>
        </form>
      </AlertDescription>
    </Alert>
  )
}

function ImportAuditReport({
  item,
  manualReviewConfirmed,
  onManualReviewChange,
}: {
  item: ImportItem
  manualReviewConfirmed: boolean
  onManualReviewChange: (confirmed: boolean) => void
}) {
  const currency =
    item.target?.currency ?? item.detectedCurrency ?? item.staged[0]?.currency
  const duplicateCount = item.staged.filter((row) => row.duplicate).length
  const newCount = item.staged.length - duplicateCount
  const guidance = getImportAuditGuidance(item)
  const Icon =
    item.validationStatus === 'reconciled' ||
    item.validationStatus === 'imported'
      ? CircleCheck
      : item.validationStatus === 'divergent'
        ? CircleX
        : AlertTriangle
  const metrics = [
    {
      title: 'Contagem',
      value: `${item.parsedTransactionCount} lidos`,
      description:
        item.sourceTransactionCount === null
          ? 'O formato não informou a quantidade original.'
          : `${item.sourceTransactionCount} identificados no arquivo.`,
    },
    {
      title: 'Inclusão',
      value: `${newCount} novos · ${duplicateCount} duplicados`,
      description: item.invalidTransactionCount
        ? `${item.invalidTransactionCount} não interpretados.`
        : 'Nenhum lançamento perdido.',
    },
    {
      title: 'Movimentação',
      value: formatCurrency(item.netMovementCents, currency),
      description: `${formatCurrency(item.totalCreditsCents, currency)} em créditos · ${formatCurrency(item.totalDebitsCents, currency)} em débitos.`,
    },
    {
      title: 'Cobertura e saldo',
      value: formatImportPeriod(item.periodStart, item.periodEnd),
      description: `${
        item.periodSource === 'filename'
          ? 'Período identificado no nome do arquivo. '
          : item.periodSource === 'metadata'
            ? 'Período informado pelo banco. '
            : item.periodSource === 'user'
              ? 'Período confirmado por você. '
              : 'Somente dias com movimentação; não prova cobertura completa. '
      }${
        item.balanceDifferenceCents === null
          ? item.closingBalanceCents === null
            ? item.accountId
              ? 'Saldo final não informado.'
              : 'Total da fatura não informado.'
            : 'Sem saldo anterior compatível.'
          : `Diferença de saldo: ${formatCurrency(item.balanceDifferenceCents, currency)}.`
      }`,
    },
  ]

  return (
    <div className="mb-4 flex flex-col gap-3">
      <Alert
        variant={
          item.validationStatus === 'divergent' ? 'destructive' : 'default'
        }
      >
        <Icon />
        <AlertTitle>{guidance.title}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 text-pretty">
          <div>{guidance.explanation}</div>
          <div>
            <div className="font-medium text-current">O que fazer agora</div>
            <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-4">
              {guidance.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </AlertDescription>
      </Alert>

      <dl className="grid gap-px overflow-hidden rounded-lg bg-border md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.title} className="bg-background px-3 py-3">
            <dt className="text-xs text-muted-foreground">{metric.title}</dt>
            <dd className="mt-1 text-sm font-medium tabular-nums">
              {metric.value}
            </dd>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {metric.description}
            </p>
          </div>
        ))}
      </dl>

      <ImportCoverageConfirmation item={item} />

      {item.validationStatus === 'warning' ? (
        <Field orientation="horizontal">
          <Checkbox
            id={`confirm-review-${item.id}`}
            checked={manualReviewConfirmed}
            onCheckedChange={onManualReviewChange}
          />
          <FieldContent>
            <FieldLabel htmlFor={`confirm-review-${item.id}`}>
              Conferi a conta, o período e os totais com o extrato original.
            </FieldLabel>
            <FieldDescription>
              Marque esta opção para habilitar o botão Consolidar.
            </FieldDescription>
          </FieldContent>
        </Field>
      ) : null}
    </div>
  )
}

function getImportAuditGuidance(item: ImportItem) {
  const targetKind = item.accountId ? 'conta' : 'cartão'
  const sourceKind =
    item.parser === 'csv' ? 'CSV' : item.parser === 'ofx' ? 'OFX' : 'arquivo'
  const targetName = formatInstrumentName(
    item.target?.name ?? 'destino removido',
  )
  const period = formatImportPeriod(item.periodStart, item.periodEnd)
  const currency =
    item.target?.currency ?? item.detectedCurrency ?? item.staged[0]?.currency
  const totals = `${formatCurrency(item.totalCreditsCents, currency)} em créditos e ${formatCurrency(item.totalDebitsCents, currency)} em débitos`

  if (item.validationStatus === 'reconciled') {
    return {
      title: 'Conferência automática concluída',
      explanation:
        item.validationMessage ??
        'A contagem, as movimentações e os saldos conferem.',
      steps: [
        'Revise as categorias dos lançamentos abaixo.',
        'Clique em Consolidar para incluir as transações nos relatórios.',
      ],
    }
  }

  if (item.validationStatus === 'imported') {
    return {
      title: 'Arquivo lido com sucesso',
      explanation:
        item.validationMessage ??
        'Os lançamentos foram lidos e podem ser consolidados. Este arquivo não fornece sozinho um saldo reconciliado.',
      steps: [
        'Revise as categorias e as transferências abaixo.',
        'Clique em Consolidar para incluir as transações.',
        item.accountId
          ? 'Depois, use Atualizar saldo na página Contas para informar o valor exibido pelo banco.'
          : 'Quando a fatura fechar, use Confirmar fatura na página Cartões.',
      ],
    }
  }

  if (item.validationStatus === 'warning') {
    const explanation =
      item.closingBalanceCents === null
        ? item.accountId
          ? `Os ${item.parsedTransactionCount} lançamentos foram lidos, mas este ${sourceKind} não informa o saldo final. Sem esse valor, o sistema não consegue provar que as movimentações fecham o saldo da conta.`
          : `Os ${item.parsedTransactionCount} lançamentos foram lidos, mas este ${sourceKind} não informa o total da fatura. Sem esse valor, o sistema não consegue conferir as compras e os créditos.`
        : item.sourceTransactionCount === null
          ? `O arquivo informa um saldo final, mas não traz uma contagem confiável dos lançamentos. Por isso, a conferência precisa ser manual.`
          : `Os ${item.parsedTransactionCount} lançamentos foram lidos, mas ainda não existe um saldo anterior compatível para conferir o saldo final deste período.`

    return {
      title: 'Confira estes dados antes de consolidar',
      explanation,
      steps: [
        `Confirme que o arquivo pertence à ${targetKind} ${targetName}.`,
        `Compare com o extrato original: período ${period}, ${item.parsedTransactionCount} lançamentos, ${totals}.`,
        'Se estiver correto, marque a confirmação abaixo e consolide. Se algo não conferir, rejeite o lote e envie o extrato correto.',
      ],
    }
  }

  const hasBalanceDifference = item.balanceDifferenceCents !== null
  const hasUnreadTransactions = item.invalidTransactionCount > 0
  const isDestinationConflict = Boolean(
    item.warning?.includes('arquivo idêntico') ||
    item.validationMessage?.includes('outro destino'),
  )
  const hasPendingCorrection = item.corrections.some(
    (correction) => correction.status === 'pending',
  )
  const hasStatementCandidates = item.statementMatchCandidates.some(
    ({ candidates }) => candidates.length > 0,
  )
  const hasMissingStatementTransactions =
    item.statementMissingCandidates.length > 0

  return {
    title: 'Este lote não pode ser consolidado',
    explanation:
      item.validationMessage ??
      'A auditoria encontrou uma divergência que precisa ser corrigida.',
    steps: hasPendingCorrection
      ? [
          'Compare a nova observação com o lançamento atual.',
          'Aceite a correção ou mantenha o original usando as ações abaixo.',
          'Se aceitar, confira novamente os saldos posteriores indicados pelo app.',
        ]
      : isDestinationConflict
        ? [
            `Confirme se ${targetName} é o destino correto para este arquivo.`,
            'Rejeite este lote. Depois, crie um novo lote e escolha a conta ou o cartão correto.',
          ]
        : hasMissingStatementTransactions
          ? [
              'Confira as autorizações listadas em “não constam na fatura”.',
              'Se foram canceladas ou expiraram, confirme a ausência. O app preservará essa decisão na auditoria.',
              'Depois, revise as categorias restantes e clique em Consolidar.',
            ]
          : hasStatementCandidates
            ? [
                'Compare as linhas do PDF com os lançamentos pendentes sugeridos abaixo.',
                'Clique em Vincular no par correto. A data, a descrição ou o valor do lançamento serão atualizados com auditoria.',
                'Depois que todas as diferenças forem resolvidas, revise as categorias e clique em Consolidar.',
              ]
            : hasUnreadTransactions
              ? [
                  'Rejeite este lote e exporte o extrato novamente. Prefira OFX ou CSV.',
                  'Envie o novo arquivo e confira se todos os lançamentos foram lidos.',
                ]
              : hasBalanceDifference
                ? [
                    `Confira se o arquivo pertence à ${targetKind} ${targetName}.`,
                    `O saldo difere em ${formatCurrency(Math.abs(item.balanceDifferenceCents!), currency)}. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.`,
                  ]
                : [
                    'Rejeite este lote e confira se selecionou a conta ou o cartão correto.',
                    'Exporte o extrato novamente, prefira OFX ou CSV, e crie um novo lote.',
                  ],
  }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatImportPeriod(start: string | null, end: string | null) {
  if (!start && !end) return 'Período não informado'
  if (start === end || !end) return start ?? end ?? 'Período não informado'
  if (!start) return `Data ausente a ${end}`
  return formatPeriod({ start, end }, 'iso')
}

const importStatusLabels: Record<string, string> = {
  review: 'Aguardando revisão',
  committed: 'Consolidado',
  evidence: 'Evidência de controle',
  rejected: 'Rejeitado',
  failed: 'Falhou',
}

const suggestionSourceLabels: Record<string, string> = {
  none: 'Sem sugestão',
  rule: 'Regra',
  history: 'Histórico',
  heuristic: 'Heurística',
  ai: 'IA',
  system: 'Sistema',
  manual: 'Revisada',
}
