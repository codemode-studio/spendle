import { Check, Search } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type * as React from 'react'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Spinner } from '#/components/ui/spinner'
import { formatCurrency, formatMinorUnitsForInput } from '#/domain/currency'
import { formatInstrumentName, normalizeDescription } from '#/domain/finance'
import { formatShortDate as formatDate } from '#/domain/period'
import { recurrenceLinkCandidateLimits } from '#/domain/recurrence-book'
import { recurrenceLinkCandidatesOptions } from '#/features/finance/queries'
import type {
  PlanningSnapshot,
  RecurrenceSnapshot,
} from '#/features/finance/snapshot.types'
import { cn } from '#/lib/utils'

function LinkPaymentDialog({
  recurrence,
  categories,
  pending,
  open,
  onOpenChange,
  onLink,
}: {
  recurrence: RecurrenceSnapshot | null
  categories: Array<
    Pick<PlanningSnapshot['categories'][number], 'id' | 'name' | 'bucket'>
  >
  pending: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onLink: (occurrenceId: string, transactionIds: string[]) => void
}) {
  const multiple = recurrence?.matchMode === 'aggregate'
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const filterCategories = categories.filter((category) =>
    recurrence?.direction === 'income'
      ? category.bucket === 'income'
      : category.bucket === 'essential' || category.bucket === 'lifestyle',
  )
  const [occurrenceId, setOccurrenceId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const toggleTransaction = (id: string) =>
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : multiple
          ? [...current, id]
          : [id],
    )
  const openOccurrences = useMemo(
    () =>
      recurrence
        ? recurrence.occurrences
            .filter((item) => item.status === 'expected')
            .sort((left, right) =>
              left.expectedDate.localeCompare(right.expectedDate),
            )
        : [],
    [recurrence],
  )
  const selectedOccurrence =
    openOccurrences.find((item) => item.id === occurrenceId) ??
    openOccurrences.at(0)
  const candidatesQuery = useQuery(
    recurrenceLinkCandidatesOptions(selectedOccurrence?.id),
  )
  const candidates = useMemo(() => {
    const query = normalizeDescription(search)
    return (candidatesQuery.data ?? [])
      .filter(
        (candidate) =>
          categoryId === 'all' ||
          (categoryId === 'uncategorized'
            ? !candidate.categoryId || candidate.categoryId === 'uncategorized'
            : candidate.categoryId === categoryId),
      )
      .filter(
        (candidate) =>
          !query || normalizeDescription(candidate.description).includes(query),
      )
      .slice(
        0,
        recurrenceLinkCandidateLimits[multiple ? 'aggregate' : 'single'],
      )
  }, [candidatesQuery.data, multiple, search, categoryId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {multiple
              ? 'Vincular lançamentos ao período'
              : 'Vincular pagamento'}
          </DialogTitle>
          <DialogDescription>
            {recurrence?.name}
            {selectedOccurrence &&
              ` · ${formatCurrency(
                selectedOccurrence.expectedAmountCents,
                selectedOccurrence.currency,
              )} previsto para ${formatDate(selectedOccurrence.expectedDate)}`}
          </DialogDescription>
        </DialogHeader>
        {openOccurrences.length > 1 && (
          <NativeSelect
            value={selectedOccurrence?.id ?? ''}
            onChange={(event) => {
              setOccurrenceId(event.target.value)
              setSelectedIds([])
            }}
            aria-label="Ocorrência a vincular"
          >
            {openOccurrences.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {formatDate(item.expectedDate)} ·{' '}
                {formatCurrency(item.expectedAmountCents, item.currency)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por descrição…"
              aria-label="Buscar transação"
              className="pl-8 md:pl-8"
            />
          </div>
          <NativeSelect
            aria-label="Filtrar por categoria"
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value)
              setSelectedIds([])
            }}
          >
            <NativeSelectOption value="all">
              Todas as categorias
            </NativeSelectOption>
            {filterCategories.map((category) => (
              <NativeSelectOption key={category.id} value={category.id}>
                {category.name}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="uncategorized">
              Sem categoria
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          {candidatesQuery.isPending ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> Buscando transações…
            </div>
          ) : candidatesQuery.isError ? (
            <p className="p-4 text-sm text-destructive">
              Não foi possível buscar as transações compatíveis.
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nenhuma transação compatível. Confira os filtros ou importe o
              extrato do período.
            </p>
          ) : (
            <ul className="divide-y">
              {candidates.map((candidate) => {
                const selected = selectedIds.includes(candidate.id)
                const hints = multiple
                  ? [candidate.inWindow ? 'no período' : 'fora do período']
                  : [
                      candidate.amountDifferenceCents === 0
                        ? 'valor exato'
                        : null,
                      candidate.daysApart <= 3 ? 'data próxima' : null,
                    ].filter(Boolean)
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleTransaction(candidate.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors pointer-fine:hover:bg-muted/50',
                        selected &&
                          'bg-primary/5 ring-1 ring-primary/40 ring-inset',
                      )}
                    >
                      <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatDate(candidate.postedAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {candidate.description}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatInstrumentName(
                            candidate.accountLabel ??
                              candidate.cardLabel ??
                              '—',
                          )}
                          {hints.length > 0 && ` · ${hints.join(' · ')}`}
                        </span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatCurrency(
                          Math.abs(candidate.amountCents),
                          candidate.currency,
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={
              selectedIds.length === 0 ||
              !selectedOccurrence ||
              pending ||
              candidatesQuery.isPending
            }
            onClick={() => {
              if (selectedOccurrence && selectedIds.length > 0) {
                onLink(selectedOccurrence.id, selectedIds)
              }
            }}
          >
            <Check data-icon="inline-start" />
            {multiple && selectedIds.length > 1
              ? `Vincular ${selectedIds.length} lançamentos`
              : 'Vincular e conciliar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
function RecurrenceDialog({
  open,
  onOpenChange,
  data,
  recurrence,
  onSubmit,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: PlanningSnapshot
  recurrence: RecurrenceSnapshot | undefined
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  pending: boolean
}) {
  const destination = recurrence?.accountId
    ? `account:${recurrence.accountId}`
    : recurrence?.creditCardId
      ? `card:${recurrence.creditCardId}`
      : ''
  const recurrenceGroup = data.recurrenceGroups.find(
    (group) => group.id === recurrence?.groupId,
  )
  const [direction, setDirection] = useState<'income' | 'expense'>(
    recurrence?.direction ?? 'expense',
  )
  const [destinationMode, setDestinationMode] = useState<'automatic' | 'fixed'>(
    recurrence?.destinationMode ?? 'automatic',
  )
  const categories = data.categories.filter((category) =>
    direction === 'income'
      ? category.bucket === 'income'
      : category.bucket === 'essential' || category.bucket === 'lifestyle',
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {recurrence ? 'Editar recorrência' : 'Nova recorrência'}
          </DialogTitle>
          <DialogDescription>
            Registre uma receita ou despesa prevista.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel>Nome</FieldLabel>
              <Input
                name="name"
                defaultValue={recurrence?.name}
                required
                autoFocus
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Grupo</FieldLabel>
                <Input
                  name="groupName"
                  list="recurrence-group-options"
                  defaultValue={recurrenceGroup?.name}
                  placeholder="Ex.: Academia"
                />
                <datalist id="recurrence-group-options">
                  {data.recurrenceGroups.map((group) => (
                    <option key={group.id} value={group.name} />
                  ))}
                </datalist>
              </Field>
              <Field>
                <FieldLabel>Pessoa ou identificação</FieldLabel>
                <Input
                  name="participantLabel"
                  defaultValue={recurrence?.participantLabel ?? ''}
                  placeholder="Ex.: Donald, esposa ou família"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Tipo</FieldLabel>
                <NativeSelect
                  name="direction"
                  className="w-full"
                  value={direction}
                  onChange={(event) =>
                    setDirection(event.target.value as 'income' | 'expense')
                  }
                >
                  <NativeSelectOption value="expense">
                    Despesa
                  </NativeSelectOption>
                  <NativeSelectOption value="income">
                    Receita
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Comportamento do valor</FieldLabel>
                <NativeSelect
                  name="amountMode"
                  className="w-full"
                  defaultValue={recurrence?.amountMode ?? 'fixed'}
                >
                  <NativeSelectOption value="fixed">
                    Valor fixo
                  </NativeSelectOption>
                  <NativeSelectOption value="variable">
                    Valor variável
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            <Field>
              <FieldLabel>Conciliação</FieldLabel>
              <NativeSelect
                name="matchMode"
                className="w-full"
                defaultValue={recurrence?.matchMode ?? 'single'}
              >
                <NativeSelectOption value="single">
                  Um pagamento por período (aluguel, escola, assinatura)
                </NativeSelectOption>
                <NativeSelectOption value="aggregate">
                  Envelope: soma de vários lançamentos (mercado, farmácia)
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Valor</FieldLabel>
                <Input
                  name="amount"
                  defaultValue={
                    recurrence
                      ? formatMinorUnitsForInput(
                          recurrence.amountCents,
                          recurrence.currency,
                        )
                      : ''
                  }
                  placeholder="0,00"
                  min="0"
                  required
                />
              </Field>
              <Field>
                <FieldLabel>Frequência</FieldLabel>
                <NativeSelect
                  name="frequency"
                  className="w-full"
                  defaultValue={recurrence?.frequency ?? 'monthly'}
                >
                  <NativeSelectOption value="monthly">
                    Mensal
                  </NativeSelectOption>
                  <NativeSelectOption value="yearly">Anual</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Identificação do destino</FieldLabel>
                <NativeSelect
                  name="destinationMode"
                  className="w-full"
                  value={destinationMode}
                  onChange={(event) =>
                    setDestinationMode(
                      event.target.value as 'automatic' | 'fixed',
                    )
                  }
                >
                  <NativeSelectOption value="automatic">
                    Automática pelo histórico
                  </NativeSelectOption>
                  <NativeSelectOption value="fixed">
                    Conta fixa
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Moeda</FieldLabel>
                <NativeSelect
                  name="currency"
                  className="w-full"
                  defaultValue={recurrence?.currency ?? 'BRL'}
                  disabled={destinationMode === 'fixed'}
                >
                  <NativeSelectOption value="BRL">BRL</NativeSelectOption>
                  <NativeSelectOption value="USD">USD</NativeSelectOption>
                  <NativeSelectOption value="BTC">BTC</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            {destinationMode === 'fixed' && (
              <Field>
                <FieldLabel>Conta ou cartão</FieldLabel>
                <NativeSelect
                  name="destination"
                  className="w-full"
                  defaultValue={destination}
                  required
                >
                  <NativeSelectOption value="">Selecione</NativeSelectOption>
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
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>Categoria</FieldLabel>
                <NativeSelect
                  name="categoryId"
                  className="w-full"
                  defaultValue={recurrence?.categoryId ?? categories[0]?.id}
                  required
                >
                  {categories.map((category) => (
                    <NativeSelectOption key={category.id} value={category.id}>
                      {category.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>Próxima data</FieldLabel>
                <Input
                  name="nextDate"
                  type="date"
                  defaultValue={
                    recurrence?.nextDate ??
                    new Date().toISOString().slice(0, 10)
                  }
                  required
                />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Salvar recorrência
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { LinkPaymentDialog, RecurrenceDialog }
