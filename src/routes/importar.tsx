import {
  CircleAlert,
  CircleCheck,
  FileClock,
  FileSearch,
  Upload,
  X,
} from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import {
  EmptyState,
  Page,
  PageHeader,
  Panel,
  StatusBadge,
} from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Field, FieldLabel } from '#/components/ui/field'
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
import { formatCurrency } from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatPeriod, formatShortDate } from '#/domain/period'
import { accountOptionLabel } from '#/features/v2/accounts'
import {
  previewImportFn,
  uploadImportFn,
} from '#/features/v2/imports.functions'
import {
  accountsOptions,
  importsOptions,
  invalidateAfterReactors,
} from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'
import { cn } from '#/lib/utils'

import type { ImportPreview } from '@spendle/server/api'

/** `view` came from the V1 staging flow; old links still open the page. */
const importSearchSchema = z.object({
  account: z.string().optional().catch(undefined),
  view: z.enum(['upload', 'review']).optional().catch(undefined),
})

export const Route = createFileRoute('/importar')({
  validateSearch: importSearchSchema,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(accountsOptions()),
      context.queryClient.ensureQueryData(importsOptions()),
    ]),
  component: ImportPage,
})

type Preview = typeof ImportPreview.Type

type Item = {
  id: string
  file: File
  state:
    | { kind: 'checking' }
    | { kind: 'ready'; preview: Preview }
    | { kind: 'refused'; message: string }
    | { kind: 'importing'; preview: Preview }
    | {
        kind: 'imported'
        preview: Preview
        recorded: number
        unchanged: number
        alreadyImported: boolean
      }
    | { kind: 'failed'; preview: Preview; message: string }
}

/** Imports are timestamped in UTC; show the person's local day. */
const importedOn = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
})

const formatLabels: Record<Preview['format'], string> = {
  ofx: 'OFX',
  csv: 'CSV',
  pdf: 'PDF',
}

function ImportPage() {
  const search = Route.useSearch()
  const { data: accounts } = useSuspenseQuery(accountsOptions())
  const { data: history } = useSuspenseQuery(importsOptions())
  const queryClient = useQueryClient()
  const preview = useServerFn(previewImportFn)
  const upload = useServerFn(uploadImportFn)
  const [accountId, setAccountId] = useState(
    accounts.find((account) => account.id === search.account)?.id ??
      accounts.at(0)?.id ??
      '',
  )
  const [items, setItems] = useState<Array<Item>>([])
  const [dragging, setDragging] = useState(false)
  const accountName = new Map(
    accounts.map((account) => [account.id, account.name]),
  )

  const update = (id: string, state: Item['state']) =>
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, state } : item)),
    )

  function uploadForm(file: File) {
    const form = new FormData()
    form.append('accountId', accountId)
    form.append('file', file, file.name)
    return form
  }

  async function check(item: Item) {
    try {
      const result = await preview({ data: uploadForm(item.file) })
      update(item.id, { kind: 'ready', preview: result })
    } catch (error) {
      update(item.id, {
        kind: 'refused',
        message: errorMessage(error, 'Não foi possível ler o arquivo.'),
      })
    }
  }

  function addFiles(files: ReadonlyArray<File>) {
    if (!accountId) return
    const added = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      state: { kind: 'checking' } as const,
    }))
    setItems((current) => [
      ...current.filter(
        (item) => !added.some((candidate) => candidate.id === item.id),
      ),
      ...added,
    ])
    for (const item of added) void check(item)
  }

  const importMutation = useMutation({
    mutationFn: async () => {
      const ready = items.filter(
        (item): item is Item & { state: { kind: 'ready'; preview: Preview } } =>
          item.state.kind === 'ready',
      )
      let recorded = 0
      for (const item of ready) {
        update(item.id, { kind: 'importing', preview: item.state.preview })
        try {
          const result = await upload({ data: uploadForm(item.file) })
          recorded += result.recorded
          update(item.id, {
            kind: 'imported',
            preview: item.state.preview,
            recorded: result.recorded,
            unchanged: result.unchanged,
            alreadyImported: result.alreadyImported,
          })
        } catch (error) {
          update(item.id, {
            kind: 'failed',
            preview: item.state.preview,
            message: errorMessage(error, 'Não foi possível importar.'),
          })
        }
      }
      return { files: ready.length, recorded }
    },
    onSuccess: ({ files, recorded }) => {
      toast.success(
        recorded
          ? `${recorded} ${recorded === 1 ? 'movimentação registrada' : 'movimentações registradas'}. Os lançamentos aparecem em instantes.`
          : files === 1
            ? 'Arquivo já importado. Nada mudou.'
            : 'Arquivos já importados. Nada mudou.',
      )
      void invalidateAfterReactors(queryClient, 'ledger', [1_500, 4_000])
    },
  })

  const ready = items.filter((item) => item.state.kind === 'ready')
  const checking = items.some((item) => item.state.kind === 'checking')
  const busy = importMutation.isPending

  return (
    <Page>
      <PageHeader
        title="Importar extrato"
        description="Confira o que o arquivo traz antes de registrar. O mesmo arquivo nunca duplica lançamentos."
      />
      {!accounts.length ? (
        <Panel>
          <EmptyState
            icon={Upload}
            title="Cadastre uma conta primeiro"
            description="O extrato é registrado na conta ou cartão a que pertence."
            action={
              <Button
                nativeButton={false}
                render={<Link to="/configuracoes" search={{ tab: 'contas' }} />}
              >
                Adicionar conta
              </Button>
            }
          />
        </Panel>
      ) : (
        <Panel>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="import-account">Conta do extrato</FieldLabel>
              <NativeSelect
                id="import-account"
                value={accountId}
                disabled={busy}
                onChange={(event) => {
                  setAccountId(event.target.value)
                  setItems([])
                }}
                className="w-full sm:max-w-sm"
              >
                {accounts.map((account) => (
                  <NativeSelectOption key={account.id} value={account.id}>
                    {formatInstrumentName(accountOptionLabel(account))}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <label
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
              className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-5 py-6 text-center transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 hover:bg-muted/50 data-[dragging=true]:border-primary data-[dragging=true]:bg-muted"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Upload className="size-4" />
              </span>
              <span className="text-sm font-medium">
                Arraste arquivos aqui ou clique para selecionar
              </span>
              <span className="text-xs text-muted-foreground">
                OFX, CSV ou PDF · 20 MB cada
              </span>
              <Input
                type="file"
                className="sr-only"
                aria-label="Arquivos do extrato"
                accept=".ofx,.csv,.pdf,text/csv,application/pdf"
                multiple
                disabled={busy}
                onChange={(event) => {
                  addFiles(Array.from(event.currentTarget.files ?? []))
                  event.currentTarget.value = ''
                }}
              />
            </label>

            {items.length > 0 && (
              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <ImportItem
                    key={item.id}
                    item={item}
                    disabled={busy}
                    onRemove={() =>
                      setItems((current) =>
                        current.filter((other) => other.id !== item.id),
                      )
                    }
                  />
                ))}
              </ul>
            )}

            {items.length > 0 && (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setItems([])}
                >
                  Limpar
                </Button>
                <Button
                  disabled={busy || checking || ready.length === 0}
                  onClick={() => importMutation.mutate()}
                >
                  {busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <CircleCheck data-icon="inline-start" />
                  )}
                  {ready.length > 1
                    ? `Importar ${ready.length} arquivos`
                    : 'Importar'}
                </Button>
              </div>
            )}
          </div>
        </Panel>
      )}

      <Panel title="Importações" className="mt-4">
        {history.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Arquivo</TableHead>
                <TableHead className="hidden sm:table-cell">Conta</TableHead>
                <TableHead>Período</TableHead>
                <TableHead className="hidden text-right md:table-cell">
                  Linhas
                </TableHead>
                <TableHead className="hidden text-right md:table-cell">
                  Importado
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="max-w-[14rem]">
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusBadge>{formatLabels[entry.format]}</StatusBadge>
                      <span className="truncate">{entry.fileName}</span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden truncate text-muted-foreground sm:table-cell">
                    {formatInstrumentName(
                      accountName.get(entry.accountId) ?? 'Conta arquivada',
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {entry.periodStart && entry.periodEnd
                      ? formatPeriod(
                          { start: entry.periodStart, end: entry.periodEnd },
                          'day-range',
                        )
                      : '—'}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">
                    {entry.lineCount}
                    {entry.rejectedRows ? (
                      <span className="text-warning-foreground">
                        {' '}
                        · {entry.rejectedRows} ilegíveis
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
                    {importedOn.format(new Date(entry.importedAt))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={FileClock}
            title="Nenhum extrato importado"
            description="Os arquivos importados aparecem aqui, com o período que cobrem."
          />
        )}
      </Panel>
    </Page>
  )
}

function ImportItem({
  item,
  disabled,
  onRemove,
}: {
  item: Item
  disabled: boolean
  onRemove: () => void
}) {
  const state = item.state
  const preview = 'preview' in state ? state.preview : null
  const tone =
    state.kind === 'refused' || state.kind === 'failed'
      ? 'border-destructive/40 bg-destructive/5'
      : state.kind === 'imported'
        ? 'border-success/40 bg-success/5'
        : ''
  return (
    <li className={cn('grid gap-3 rounded-lg border p-3', tone)}>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {state.kind === 'checking' || state.kind === 'importing' ? (
          <Spinner className="shrink-0" />
        ) : state.kind === 'refused' || state.kind === 'failed' ? (
          <CircleAlert className="size-4 shrink-0 text-destructive" />
        ) : state.kind === 'imported' ? (
          <CircleCheck className="size-4 shrink-0 text-success" />
        ) : (
          <FileSearch className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-medium">{item.file.name}</span>
        {preview ? (
          <StatusBadge>{formatLabels[preview.format]}</StatusBadge>
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {state.kind === 'checking'
            ? 'Conferindo…'
            : state.kind === 'importing'
              ? 'Importando…'
              : state.kind === 'imported'
                ? state.alreadyImported
                  ? 'Já importado: nada mudou'
                  : `${state.recorded} registradas${state.unchanged ? ` · ${state.unchanged} já existiam` : ''}`
                : state.kind === 'ready'
                  ? 'Pronto para importar'
                  : null}
        </span>
        {state.kind === 'ready' ||
        state.kind === 'refused' ||
        state.kind === 'failed' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remover ${item.file.name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <X />
          </Button>
        ) : null}
      </div>
      {state.kind === 'refused' || state.kind === 'failed' ? (
        <p className="text-sm text-destructive">{state.message}</p>
      ) : null}
      {preview ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Período</dt>
            <dd className="tabular-nums">
              {preview.period
                ? formatPeriod(
                    { start: preview.period.start, end: preview.period.end },
                    'day-range',
                  )
                : preview.firstDate && preview.lastDate
                  ? formatPeriod(
                      { start: preview.firstDate, end: preview.lastDate },
                      'day-range',
                    )
                  : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Movimentações</dt>
            <dd className="tabular-nums">
              {preview.lineCount}
              {preview.rejectedRows ? (
                <span className="text-warning-foreground">
                  {' '}
                  · {preview.rejectedRows} ilegíveis
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Entradas · Saídas</dt>
            <dd className="tabular-nums">
              <span className="text-emerald-700">
                {formatCurrency(preview.inflowCents)}
              </span>{' '}
              · {formatCurrency(-Math.abs(preview.outflowCents))}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Saldo final</dt>
            <dd className="tabular-nums">
              {preview.closingBalance
                ? `${formatCurrency(preview.closingBalance.cents)} em ${formatShortDate(preview.closingBalance.asOf)}`
                : 'Não informado'}
            </dd>
          </div>
        </dl>
      ) : null}
    </li>
  )
}
