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
  identifyImportFilesFn,
  updateStagedTransactionCategoryFn,
} from '#/features/finance/finance.functions'
import type { getImportReviewSnapshotFn } from '#/features/finance/finance.functions'
import {
  getImportBalanceReviewCopy,
  importCoverageProvenanceCopy,
  importReviewGuidanceCopy,
} from '#/features/finance/import-review-guidance'
import {
  importReviewOptions,
  invalidateFinance,
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
  const identifyFiles = useServerFn(identifyImportFilesFn)
  const [destinations, setDestinations] = useState<Array<{
    target: string
    message: string
  }> | null>(null)
  const [dragging, setDragging] = useState(false)
  const identifyMutation = useMutation({
    mutationFn: identifyFiles,
    onSuccess: setDestinations,
    onError: (error) => toast.error(error.message),
  })
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [aiConsent, setAiConsent] = useState(false)
  const [confirmedReviews, setConfirmedReviews] = useState<Set<string>>(
    () => new Set(),
  )
  const invalidateImport = () => invalidateFinance(queryClient, 'ledger')

  const stageMutation = useMutation({
    mutationFn: async () => {
      const groups = new Map<string, File[]>()
      selectedFiles.forEach((file, index) => {
        const target = destinations?.[index]?.target
        if (!target)
          throw new Error('Identifique o destino de todos os arquivos.')
        groups.set(target, [...(groups.get(target) ?? []), file])
      })
      const results = []
      for (const [target, files] of groups) {
        const separator = target.indexOf(':')
        const form = new FormData()
        form.set('targetType', target.slice(0, separator))
        form.set('targetId', target.slice(separator + 1))
        form.set('aiConsent', String(aiConsent))
        files.forEach((file) => form.append('files', file))
        results.push(await stageImport({ data: form }))
      }
      return {
        importIds: results.flatMap((result) => result.importIds),
        reused: results.reduce((total, result) => total + result.reused, 0),
        requiresReview: results.some((result) => result.requiresReview),
        skipped: results.flatMap((result) => result.skipped),
      }
    },
    onSuccess: async (result) => {
      if (result.skipped.length) {
        toast.warning(
          result.skipped.length === 1
            ? `${result.skipped[0].fileName} foi ignorado: ${result.skipped[0].reason}`
            : `${result.skipped.length} arquivos sem lançamentos foram ignorados: ${result.skipped
                .map((item) => item.fileName)
                .join(', ')}.`,
        )
      }
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
      await invalidateImport()
      setDestinations(null)
      setSelectedFiles([])
      setAiConsent(false)
      if (result.requiresReview) {
        void navigate({ search: { view: 'review' } })
      }
    },
    onError: async (error) => {
      await invalidateImport()
      toast.error(
        error instanceof Error ? error.message : 'Falha na importação.',
      )
    },
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
                    await invalidateImport()
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
      await invalidateImport()
    },
    onError: (error) => {
      void invalidateImport()
      toast.error(
        error instanceof Error ? error.message : 'Falha ao consolidar.',
      )
    },
  })
  const rejectMutation = useMutation({
    mutationFn: rejectImport,
    onSuccess: () => {
      toast.success('Lote rejeitado.')
      void invalidateImport()
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
      void invalidateImport()
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
    onSuccess: () =>
      invalidateFinance(queryClient, 'stagedTransactionCategory'),
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
      void invalidateImport()
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
      void invalidateImport()
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
      void invalidateImport()
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
    if (!selectedFiles.length) return
    if (destinations) {
      stageMutation.mutate()
    } else {
      const form = new FormData()
      selectedFiles.forEach((file) => form.append('files', file))
      identifyMutation.mutate({ data: form })
    }
  }

  function addFiles(files: File[]) {
    if (stageMutation.isPending || identifyMutation.isPending) return
    const next = [...selectedFiles]
    for (const file of files) {
      if (
        !next.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified,
        )
      )
        next.push(file)
    }
    if (
      next.length > 24 ||
      next.some(
        (file) =>
          !file.size ||
          file.size > 20 * 1024 * 1024 ||
          !/\.(ofx|csv|pdf)$/i.test(file.name),
      )
    ) {
      toast.error(
        'Envie até 24 arquivos OFX, CSV ou PDF não vazios, de até 20 MB cada.',
      )
      return
    }
    setSelectedFiles(next)
    setDestinations(null)
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
    setDestinations(null)
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
          description="Envie extratos de diferentes contas e cartões. Vamos identificar o destino de cada arquivo."
        >
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="files">Arquivos</FieldLabel>
                <label
                  htmlFor="files"
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    addFiles(Array.from(event.dataTransfer.files))
                  }}
                  data-dragging={dragging}
                  className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed data-[dragging=true]:bg-muted data-[dragging=true]:border-primary px-5 py-6 text-center transition-colors hover:bg-muted/50 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
                >
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Upload className="size-4" />
                  </span>
                  <span className="text-sm font-medium">
                    {selectedFiles.length
                      ? `${selectedFiles.length} ${selectedFiles.length === 1 ? 'arquivo selecionado' : 'arquivos selecionados'}`
                      : 'Arraste arquivos aqui ou clique para selecionar'}
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
                    disabled={
                      identifyMutation.isPending || stageMutation.isPending
                    }
                    onChange={(event) => {
                      addFiles(Array.from(event.currentTarget.files ?? []))
                      event.currentTarget.value = ''
                    }}
                  />
                </label>
              </Field>

              {selectedFiles.length ? (
                <ul className="divide-y overflow-hidden rounded-lg border">
                  {selectedFiles.map((file, index) => (
                    <li
                      key={`${file.name}-${file.lastModified}`}
                      className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <FileSearch className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatFileSize(file.size)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remover ${file.name}`}
                        disabled={
                          identifyMutation.isPending || stageMutation.isPending
                        }
                        onClick={() => {
                          setSelectedFiles((files) =>
                            files.filter((_, i) => i !== index),
                          )
                          setDestinations(null)
                        }}
                      >
                        <X />
                      </Button>
                      {destinations?.[index] ? (
                        <Field className="w-full">
                          <FieldLabel htmlFor={`destination-${index}`}>
                            Conta ou cartão · {file.name}
                          </FieldLabel>
                          <FieldDescription>
                            {destinations[index].message}
                          </FieldDescription>
                          <NativeSelect
                            id={`destination-${index}`}
                            value={destinations[index].target}
                            required
                            disabled={stageMutation.isPending}
                            onChange={(event) =>
                              setDestinations(
                                (current) =>
                                  current?.map((item, i) =>
                                    i === index
                                      ? { ...item, target: event.target.value }
                                      : item,
                                  ) ?? null,
                              )
                            }
                          >
                            <NativeSelectOption value="">
                              Selecione o destino
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
                              <NativeSelectOption
                                key={card.id}
                                value={`card:${card.id}`}
                              >
                                Cartão · {formatInstrumentName(card.name)}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </Field>
                      ) : null}
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
                  identifyMutation.isPending ||
                  (destinations !== null &&
                    destinations.some((item) => !item.target)) ||
                  !selectedFiles.length
                }
              >
                {stageMutation.isPending || identifyMutation.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ArrowRight data-icon="inline-end" />
                )}
                {stageMutation.isPending
                  ? 'Lendo arquivos…'
                  : identifyMutation.isPending
                    ? 'Identificando…'
                    : destinations
                      ? 'Revisar lançamentos'
                      : 'Identificar arquivos'}
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
                        {item.duplicateCount} duplicidades
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
                          item.needsCoverageConfirmation ||
                          item.hasIncompleteTransfer ||
                          (item.validationStatus === 'warning' &&
                            !confirmedReviews.has(item.id))
                        }
                        title={
                          item.validationStatus === 'divergent'
                            ? 'Resolva a divergência antes de consolidar.'
                            : item.needsCoverageConfirmation
                              ? 'Confirme o período exportado antes de consolidar.'
                              : item.hasIncompleteTransfer
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

                  {item.statementBlockedRows.length ? (
                    <Alert variant="destructive" className="mb-4">
                      <AlertTriangle />
                      <AlertTitle>
                        Esta diferença de moeda não pode ser vinculada
                      </AlertTitle>
                      <AlertDescription className="flex flex-col gap-3">
                        <p>
                          O PDF e o lançamento atual usam o mesmo identificador,
                          mas registram moedas diferentes. Rejeite o lote,
                          corrija a origem dos dados e importe a fatura
                          novamente.
                        </p>
                        {item.statementBlockedRows.map(
                          ({ observation, transaction }) => (
                            <div
                              key={observation.id}
                              className="rounded-lg border border-destructive/30 bg-background p-3 text-sm"
                            >
                              <div>
                                No PDF: {observation.postedAt} ·{' '}
                                {observation.description} ·{' '}
                                {formatCurrency(
                                  observation.amountCents,
                                  observation.currency,
                                )}
                              </div>
                              <div className="mt-1">
                                Lançamento atual: {transaction.postedAt} ·{' '}
                                {transaction.description} ·{' '}
                                {formatCurrency(
                                  transaction.amountCents,
                                  transaction.currency,
                                )}
                              </div>
                            </div>
                          ),
                        )}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {item.statementDifferenceRows.length ? (
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
                        {item.statementDifferenceRows.map(
                          ({ observation, candidates }) => {
                            return (
                              <div
                                key={observation.id}
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
                          },
                        )}
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
                      {item.status === 'failed' && item.validationMessage ? (
                        <p className="mt-2 text-xs text-destructive">
                          {item.validationMessage}
                        </p>
                      ) : null}
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

function ImportCoverageConfirmation({ item }: { item: ImportItem }) {
  const queryClient = useQueryClient()
  const confirmCoverage = useServerFn(confirmImportCoverageFn)
  const mutation = useMutation({
    mutationFn: confirmCoverage,
    onSuccess: () => {
      toast.success('Período de cobertura confirmado.')
      void invalidateFinance(queryClient, 'ledger')
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível confirmar o período.',
      ),
  })

  if (!item.needsCoverageConfirmation) return null

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
      value: `${item.newCount} novos · ${item.duplicateCount} duplicados`,
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
      description: `${importCoverageProvenanceCopy[item.coverageProvenance.source]}${getImportBalanceReviewCopy(item.balanceReview, currency)}`,
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
  const currency =
    item.target?.currency ?? item.detectedCurrency ?? item.staged[0]?.currency
  const context = {
    targetName: formatInstrumentName(item.target?.name ?? 'destino removido'),
    period: formatImportPeriod(item.periodStart, item.periodEnd),
    totals: `${formatCurrency(item.totalCreditsCents, currency)} em créditos e ${formatCurrency(item.totalDebitsCents, currency)} em débitos`,
    currency,
  }

  switch (item.guidance.kind) {
    case 'ready':
      return importReviewGuidanceCopy.ready(item.guidance)
    case 'needs_balance':
      return importReviewGuidanceCopy.needs_balance(item.guidance, context)
    case 'needs_manual_review':
      return importReviewGuidanceCopy.needs_manual_review(
        item.guidance,
        context,
      )
    case 'pending_correction':
      return importReviewGuidanceCopy.pending_correction(item.guidance)
    case 'identical_file':
      return importReviewGuidanceCopy.identical_file(item.guidance, context)
    case 'destination_conflict':
      return importReviewGuidanceCopy.destination_conflict(
        item.guidance,
        context,
      )
    case 'missing_statement_transactions':
      return importReviewGuidanceCopy.missing_statement_transactions(
        item.guidance,
      )
    case 'statement_match_candidates':
      return importReviewGuidanceCopy.statement_match_candidates(item.guidance)
    case 'invalid_rows':
      return importReviewGuidanceCopy.invalid_rows(item.guidance)
    case 'balance_mismatch':
      return importReviewGuidanceCopy.balance_mismatch(item.guidance, context)
    case 'blocked':
      return importReviewGuidanceCopy.blocked(item.guidance)
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
  knowledge: 'Aprendizado',
  history: 'Histórico',
  heuristic: 'Heurística',
  ai: 'IA',
  system: 'Sistema',
  manual: 'Revisada',
}
