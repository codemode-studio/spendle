import { BookOpen, Pencil, Trash2 } from 'lucide-react'
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
import type { KnowledgeMatchMode } from '#/domain/knowledge-pattern'
import { formatLongDate } from '#/domain/period'
import {
  forgetKnowledgeEntryFn,
  reviewKnowledgeCategoryFn,
  updateKnowledgePatternFn,
} from '#/features/finance/finance.functions'
import type { KnowledgeEntrySnapshot } from '#/features/finance/knowledge-base.server'
import {
  invalidateFinance,
  knowledgeBaseOptions,
} from '#/features/finance/queries'

const sourceLabels: Record<KnowledgeEntrySnapshot['source'], string> = {
  transaction_review: 'Lista de transações',
  import_review: 'Revisão do lote',
  recurrence_link: 'Vínculo confirmado',
  recurrence_approval: 'Recorrência aprovada',
  knowledge_review: 'Revisado aqui',
  pattern_approval: 'Padrão aprovado',
}

export function KnowledgeBaseSection() {
  const { data } = useSuspenseQuery(knowledgeBaseOptions())
  const queryClient = useQueryClient()
  const reviewCategory = useServerFn(reviewKnowledgeCategoryFn)
  const forgetEntry = useServerFn(forgetKnowledgeEntryFn)
  const [editing, setEditing] = useState<KnowledgeEntrySnapshot | null>(null)
  const invalidate = () => invalidateFinance(queryClient, 'knowledgeBase')

  const reviewMutation = useMutation({
    mutationFn: reviewCategory,
    onSuccess: (result) => {
      toast.success(
        result.synced
          ? `Categoria aprendida atualizada e aplicada a ${result.synced} lançamentos.`
          : 'Categoria aprendida atualizada.',
      )
      void invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível atualizar.',
      ),
  })
  const forgetMutation = useMutation({
    mutationFn: forgetEntry,
    onSuccess: () => {
      toast.success('Aprendizado removido.')
      void invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível remover.',
      ),
  })

  const categoryEntries = data.entries.filter(
    (entry) => entry.kind === 'category',
  )
  const recurrenceEntries = data.entries.filter(
    (entry) => entry.kind === 'recurrence',
  )
  const forgetButton = (entry: KnowledgeEntrySnapshot) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Esquecer ${entry.pattern}`}
      disabled={
        forgetMutation.isPending &&
        forgetMutation.variables.data.id === entry.id
      }
      onClick={() => forgetMutation.mutate({ data: { id: entry.id } })}
    >
      <Trash2 />
    </Button>
  )

  if (!data.entries.length) {
    return (
      <Panel
        title="Base de conhecimento"
        description="Suas escolhas nas próximas importações."
      >
        <EmptyState
          icon={BookOpen}
          title="Nenhum aprendizado ainda"
          description="Ao escolher a categoria de um lançamento ou confirmar um pagamento recorrente, a decisão fica registrada aqui."
        />
      </Panel>
    )
  }

  return (
    <div className="grid gap-4">
      <Panel
        title="Categorias aprendidas"
        description="Suas categorias salvas. Padrões exatos têm prioridade sobre prefixos."
      >
        {categoryEntries.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Padrão</TableHead>
                  <TableHead>Direção</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead className="text-right">Confirmações</TableHead>
                  <TableHead className="text-right">Correções</TableHead>
                  <TableHead>Última decisão</TableHead>
                  <TableHead className="w-16">
                    <span className="sr-only">Ações</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categoryEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <EntryLabel entry={entry} />
                    </TableCell>
                    <TableCell>
                      <DirectionBadge direction={entry.direction} />
                    </TableCell>
                    <TableCell>
                      <CategorySelect
                        variant="ghost"
                        categories={data.categories}
                        value={entry.category?.id ?? 'uncategorized'}
                        allowTransfer={false}
                        aria-label={`Categoria aprendida para ${entry.pattern}`}
                        disabled={
                          reviewMutation.isPending &&
                          reviewMutation.variables.data.id === entry.id
                        }
                        onValueChange={(categoryId) =>
                          reviewMutation.mutate({
                            data: { id: entry.id, categoryId },
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {sourceLabels[entry.source]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.confirmations}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.corrections}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatLongDate(entry.lastLearnedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Editar padrão ${entry.pattern}`}
                          onClick={() => setEditing(entry)}
                        >
                          <Pencil />
                        </Button>
                        {forgetButton(entry)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nenhuma categoria aprendida até agora.
          </p>
        )}
      </Panel>

      <Panel
        title="Recorrências aprendidas"
        description="Vínculos salvos ao confirmar pagamentos."
      >
        {recurrenceEntries.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Estabelecimento</TableHead>
                  <TableHead>Direção</TableHead>
                  <TableHead>Recorrência</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead className="text-right">Confirmações</TableHead>
                  <TableHead>Última decisão</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Ações</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recurrenceEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <EntryLabel entry={entry} />
                    </TableCell>
                    <TableCell>
                      <DirectionBadge direction={entry.direction} />
                    </TableCell>
                    <TableCell>{entry.recurrence?.name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {sourceLabels[entry.source]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {entry.confirmations}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatLongDate(entry.lastLearnedAt)}
                    </TableCell>
                    <TableCell>{forgetButton(entry)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nenhuma recorrência aprendida até agora.
          </p>
        )}
      </Panel>

      <PatternDialog
        entry={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void invalidate()
        }}
      />
    </div>
  )
}

function PatternDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: KnowledgeEntrySnapshot | null
  onClose: () => void
  onSaved: () => void
}) {
  const updatePattern = useServerFn(updateKnowledgePatternFn)
  const mutation = useMutation({
    mutationFn: updatePattern,
    onSuccess: (result) => {
      toast.success(
        result.synced
          ? `Padrão atualizado e aplicado a ${result.synced} lançamentos.`
          : 'Padrão atualizado.',
      )
      onSaved()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível salvar.',
      ),
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!entry) return
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      data: {
        id: entry.id,
        pattern: String(form.get('pattern')),
        matchMode: String(form.get('matchMode')) as KnowledgeMatchMode,
      },
    })
  }

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {entry ? (
          <form key={entry.id} onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Editar padrão</DialogTitle>
              <DialogDescription>
                Exemplo aprendido: {entry.sampleDescription}.
                {entry.prefixCandidate
                  ? ` Começa pelo agregador “${entry.prefixCandidate}”; um prefixo com esse texto cobre todos os estabelecimentos dele.`
                  : ''}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="knowledge-pattern">Padrão</FieldLabel>
                <Input
                  id="knowledge-pattern"
                  name="pattern"
                  defaultValue={entry.pattern}
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
                  defaultValue={entry.matchMode}
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
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Salvando…' : 'Salvar padrão'}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EntryLabel({ entry }: { entry: KnowledgeEntrySnapshot }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{entry.pattern}</span>
        {entry.matchMode === 'prefix' ? (
          <StatusBadge tone="info">Prefixo</StatusBadge>
        ) : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {entry.sampleDescription}
      </span>
    </div>
  )
}

function DirectionBadge({
  direction,
}: {
  direction: KnowledgeEntrySnapshot['direction']
}) {
  return (
    <StatusBadge tone={direction === 'income' ? 'success' : 'neutral'}>
      {direction === 'income' ? 'Entrada' : 'Saída'}
    </StatusBadge>
  )
}
