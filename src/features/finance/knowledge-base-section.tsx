import { BookOpen, ChevronsRight, Pencil, Trash2 } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'

import { EmptyState, Panel, StatusBadge } from '#/components/ui'
import { CategorySelect } from '#/components/category-select'
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
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
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
import { formatCurrency } from '#/domain/currency'
import { formatLongDate, formatShortDate } from '#/domain/period'
import {
  applyStoreEditFn,
  previewStoreEditFn,
} from '#/features/v2/categories.functions'
import {
  categoriesOptions,
  invalidateAfterReactors,
  providerMappingsOptions,
  storePatternsOptions,
} from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'

import type { StoreEdit, StorePattern } from '@spendle/server/api'

type Pattern = typeof StorePattern.Type
type Edit = typeof StoreEdit.Type
type Preview = Awaited<ReturnType<typeof previewStoreEditFn>>

const sourceLabels: Record<Pattern['source'], string> = {
  transaction_list: 'Lista de transações',
  review: 'Revisão',
  v1_import: 'Trazido do V1',
  store_edit: 'Editado aqui',
  provider_mapping: 'Categoria da Pluggy',
}

/**
 * What the person taught: merchant patterns and Pluggy category mappings.
 * Every edit is previewed against history before it is applied.
 */
export function KnowledgeBaseSection() {
  const { data: patterns } = useSuspenseQuery(storePatternsOptions())
  const { data: mappings } = useSuspenseQuery(providerMappingsOptions())
  const { data: categories } = useSuspenseQuery(categoriesOptions())
  const queryClient = useQueryClient()
  const preview = useServerFn(previewStoreEditFn)
  const apply = useServerFn(applyStoreEditFn)
  const [pending, setPending] = useState<{
    edit: Edit
    title: string
    changes: Preview
  } | null>(null)
  const [editing, setEditing] = useState<Pattern | null>(null)
  const assignable = categories.filter((item) => !item.system)
  const nameOf = new Map(categories.map((item) => [item.id, item.name]))

  const applyMutation = useMutation({
    mutationFn: apply,
    onSuccess: (_result, variables) => {
      const changed =
        pending?.edit === variables.data.edit ? pending.changes.length : 0
      setPending(null)
      setEditing(null)
      toast.success(
        changed
          ? `Base atualizada. ${changed} ${changed === 1 ? 'lançamento muda' : 'lançamentos mudam'} de categoria em instantes.`
          : 'Base atualizada.',
      )
      void invalidateAfterReactors(queryClient, 'knowledgeBase')
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível salvar.')),
  })
  const previewMutation = useMutation({
    mutationFn: (input: { edit: Edit; title: string }) =>
      preview({ data: { edit: input.edit } }).then((changes) => ({
        ...input,
        changes,
      })),
    onSuccess: (result) => {
      if (!result.changes.length) {
        applyMutation.mutate({ data: { edit: result.edit } })
        return
      }
      setPending(result)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível calcular o efeito.')),
  })
  const busy = previewMutation.isPending || applyMutation.isPending
  const propose = (edit: Edit, title: string) =>
    previewMutation.mutate({ edit, title })

  const merchants = patterns.filter((pattern) => pattern.kind === 'merchant')

  return (
    <div className="grid gap-4">
      <Panel
        title="Categorias aprendidas"
        description="Padrões exatos têm prioridade sobre prefixos. Antes de salvar, você vê os lançamentos que mudam."
      >
        {merchants.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Padrão</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="hidden md:table-cell">Origem</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">
                    Confirmações
                  </TableHead>
                  <TableHead className="hidden text-right lg:table-cell">
                    Correções
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Última decisão
                  </TableHead>
                  <TableHead className="w-24">
                    <span className="sr-only">Ações</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {merchants.map((pattern) => (
                  <TableRow key={pattern.id}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <span className="truncate">{pattern.pattern}</span>
                          {pattern.matchMode === 'prefix' ? (
                            <StatusBadge tone="info">Prefixo</StatusBadge>
                          ) : null}
                          <StatusBadge
                            tone={
                              pattern.direction === 'income'
                                ? 'success'
                                : 'neutral'
                            }
                          >
                            {pattern.direction === 'income'
                              ? 'Entrada'
                              : pattern.direction === 'expense'
                                ? 'Saída'
                                : 'Ambas'}
                          </StatusBadge>
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {pattern.sampleDescription}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <CategorySelect
                        variant="ghost"
                        categories={assignable}
                        value={pattern.categoryId}
                        allowTransfer={false}
                        disabled={busy}
                        aria-label={`Categoria aprendida para ${pattern.pattern}`}
                        onValueChange={(categoryId) =>
                          propose(
                            {
                              _tag: 'Recategorize',
                              id: pattern.id,
                              categoryId,
                            },
                            `Mudar ${pattern.pattern} para ${nameOf.get(categoryId) ?? 'outra categoria'}?`,
                          )
                        }
                      />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {sourceLabels[pattern.source]}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {pattern.confirmations}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {pattern.corrections}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {formatLongDate(pattern.lastLearnedAt.slice(0, 10))}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        {pattern.prefixCandidate &&
                        pattern.matchMode === 'exact' ? (
                          <IconButton
                            label={`Cobrir tudo que começa com ${pattern.prefixCandidate}`}
                            disabled={busy}
                            onClick={() =>
                              propose(
                                { _tag: 'PromoteToPrefix', id: pattern.id },
                                `Usar “${pattern.prefixCandidate}” como prefixo?`,
                              )
                            }
                          >
                            <ChevronsRight />
                          </IconButton>
                        ) : null}
                        <IconButton
                          label={`Editar padrão ${pattern.pattern}`}
                          disabled={busy}
                          onClick={() => setEditing(pattern)}
                        >
                          <Pencil />
                        </IconButton>
                        <IconButton
                          label={`Esquecer ${pattern.pattern}`}
                          disabled={busy}
                          onClick={() =>
                            propose(
                              { _tag: 'Remove', id: pattern.id },
                              `Esquecer ${pattern.pattern}?`,
                            )
                          }
                        >
                          <Trash2 />
                        </IconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            icon={BookOpen}
            title="Nenhum aprendizado ainda"
            description="Ao escolher ou confirmar a categoria de um lançamento, o estabelecimento fica registrado aqui."
          />
        )}
      </Panel>

      {mappings.length > 0 && (
        <Panel
          title="Categorias da Pluggy"
          description="Como as categorias do Open Finance viram as suas. Sugestões embutidas sempre passam pela revisão."
        >
          <ul className="divide-y rounded-lg border">
            {mappings.map((mapping) => (
              <li
                key={`${mapping.provider}-${mapping.providerCategory}`}
                className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="truncate">{mapping.providerCategory}</span>
                  {mapping.source === 'built_in' ? (
                    <StatusBadge>Sugestão</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">Sua escolha</StatusBadge>
                  )}
                </span>
                <CategorySelect
                  variant="ghost"
                  categories={assignable}
                  value={mapping.categoryId}
                  allowTransfer={false}
                  disabled={busy}
                  aria-label={`Categoria para ${mapping.providerCategory}`}
                  onValueChange={(categoryId) =>
                    propose(
                      {
                        _tag: 'SetProviderMapping',
                        provider: 'pluggy',
                        providerCategory: mapping.providerCategory,
                        categoryId,
                      },
                      `Usar ${nameOf.get(categoryId) ?? 'essa categoria'} para “${mapping.providerCategory}”?`,
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <PatternDialog
        pattern={editing}
        busy={busy}
        onClose={() => setEditing(null)}
        onSubmit={(edit) =>
          propose(
            edit,
            `Salvar o padrão ${edit._tag === 'EditPattern' ? edit.pattern : ''}?`,
          )
        }
      />

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !applyMutation.isPending) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.changes.length}{' '}
              {pending?.changes.length === 1
                ? 'lançamento muda'
                : 'lançamentos mudam'}{' '}
              de categoria.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
              {pending.changes.slice(0, 8).map((change) => (
                <li
                  key={change.entryId}
                  className="flex flex-col gap-0.5 px-3 py-2"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">
                      {change.entry?.description ?? 'Lançamento'}
                    </span>
                    {change.entry ? (
                      <span className="shrink-0 tabular-nums">
                        {formatCurrency(
                          change.entry.amountCents,
                          change.entry.currency,
                        )}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {change.entry
                      ? `${formatShortDate(change.entry.bookedOn)} · `
                      : ''}
                    {categoryLabel(change.before.categoryId, nameOf)} →{' '}
                    {categoryLabel(change.after.categoryId, nameOf)}
                    {change.after.status === 'review' ? ' (para revisar)' : ''}
                  </span>
                </li>
              ))}
              {pending.changes.length > 8 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  e mais {pending.changes.length - 8} lançamentos
                </li>
              ) : null}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applyMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={applyMutation.isPending}
              onClick={() =>
                pending &&
                applyMutation.mutate({ data: { edit: pending.edit } })
              }
            >
              {applyMutation.isPending ? 'Aplicando…' : 'Aplicar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function categoryLabel(id: string | null, names: Map<string, string>) {
  return id ? (names.get(id) ?? id) : 'Sem categoria'
}

function IconButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & Omit<
  React.ComponentProps<typeof Button>,
  'children'
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function PatternDialog({
  pattern,
  busy,
  onClose,
  onSubmit,
}: {
  pattern: Pattern | null
  busy: boolean
  onClose: () => void
  onSubmit: (edit: Edit) => void
}) {
  return (
    <Dialog open={pattern !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {pattern ? (
          <form
            key={pattern.id}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              onSubmit({
                _tag: 'EditPattern',
                id: pattern.id,
                pattern: String(form.get('pattern')).trim(),
                matchMode:
                  form.get('matchMode') === 'prefix' ? 'prefix' : 'exact',
              })
            }}
          >
            <DialogHeader>
              <DialogTitle>Editar padrão</DialogTitle>
              <DialogDescription>
                Exemplo aprendido: {pattern.sampleDescription}.
                {pattern.prefixCandidate
                  ? ` Começa pelo agregador “${pattern.prefixCandidate}”; um prefixo com esse texto cobre todos os estabelecimentos dele.`
                  : ''}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="knowledge-pattern">Padrão</FieldLabel>
                <Input
                  id="knowledge-pattern"
                  name="pattern"
                  defaultValue={pattern.pattern}
                  required
                  minLength={3}
                  autoComplete="off"
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="knowledge-match-mode">Modo</FieldLabel>
                <NativeSelect
                  id="knowledge-match-mode"
                  name="matchMode"
                  defaultValue={pattern.matchMode}
                  className="w-full"
                >
                  <NativeSelectOption value="exact">
                    Exato: só este padrão
                  </NativeSelectOption>
                  <NativeSelectOption value="prefix">
                    Prefixo: tudo que começa por ele
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? 'Calculando…' : 'Ver efeito e salvar'}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
