import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Check, Gauge, PencilLine, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { EmptyState, Panel, ProgressBar } from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Skeleton } from '#/components/ui/skeleton'
import { setCapFn } from '#/features/data/planning.functions'
import { spendingOptions } from '#/features/data/queries'
import { invalidateFinance } from '#/features/finance/queries'
import { errorMessage } from '#/lib/api/errors'
import {
  formatCurrency,
  formatMinorUnitsForInput,
  toMinorUnits,
} from '#/lib/currency'
import { formatMonthLong } from '#/lib/period'
import { cn } from '#/lib/utils'

import type { PlanningData } from './types'

// The buckets the API counts as spending, whose categories take a cap.
const cappedBuckets = new Set(['essential', 'lifestyle', 'tax', 'business'])

function parseCap(value: string) {
  try {
    const cents = toMinorUnits(value)
    return cents >= 0 ? cents : null
  } catch {
    return null
  }
}

/**
 * Tetos por categoria: quanto cada uma pode gastar no mês, contra o que já
 * gastou pela data da compra. Um teto vale do mês em diante, até mudar.
 */
export function CapsSection({ data }: { data: PlanningData }) {
  const month = data.month.month
  const queryClient = useQueryClient()
  const setCap = useServerFn(setCapFn)
  const spending = useQuery(spendingOptions(month))
  const [adding, setAdding] = useState('')
  const mutation = useMutation({
    mutationFn: (input: { categoryId: string; cents: number | null }) =>
      setCap({ data: { ...input, month } }),
    onSuccess: () => {
      setAdding('')
      void invalidateFinance(queryClient, 'strategy')
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível salvar o teto.')),
  })
  // A closed month keeps its plan.
  const frozen = data.month.closed

  const rows = spending.data?.categories ?? []
  const shown = new Set(rows.map((row) => row.categoryId))
  const addable = data.categories.filter(
    (category) =>
      category.assignable &&
      !category.system &&
      cappedBuckets.has(category.bucket) &&
      !shown.has(category.id),
  )
  const addingName = data.categories.find(
    (category) => category.id === adding,
  )?.name

  return (
    <Panel
      title="Tetos por categoria"
      description={`${formatMonthLong(month, { capitalize: true })} · gasto pela data da compra, sem transferências. Um teto vale deste mês em diante.`}
      action={
        frozen || addable.length === 0 ? undefined : (
          <NativeSelect
            aria-label="Adicionar teto para uma categoria"
            value=""
            onChange={(event) => setAdding(event.target.value)}
          >
            <NativeSelectOption value="">Adicionar teto…</NativeSelectOption>
            {addable.map((category) => (
              <NativeSelectOption key={category.id} value={category.id}>
                {category.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )
      }
    >
      {spending.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : spending.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Não foi possível carregar os gastos do mês. Recarregue a página.
        </p>
      ) : rows.length === 0 && adding === '' ? (
        <EmptyState
          icon={Gauge}
          title="Nenhum gasto ou teto neste mês"
          description="Escolha uma categoria em Adicionar teto para definir quanto ela pode gastar."
        />
      ) : (
        <ul className="grid gap-4">
          {adding !== '' && addingName ? (
            <CapRow
              key={`new-${adding}`}
              name={addingName}
              spentCents={0}
              capCents={null}
              editingInitially
              frozen={frozen}
              pending={mutation.isPending}
              onSave={(cents) => mutation.mutate({ categoryId: adding, cents })}
              onCancel={() => setAdding('')}
            />
          ) : null}
          {rows.map((row) => (
            <CapRow
              key={row.categoryId}
              name={row.name}
              spentCents={row.spentCents}
              capCents={row.capCents}
              frozen={frozen}
              pending={
                mutation.isPending &&
                mutation.variables.categoryId === row.categoryId
              }
              onSave={(cents) =>
                mutation.mutate({ categoryId: row.categoryId, cents })
              }
            />
          ))}
        </ul>
      )}
      {spending.data && spending.data.unclassifiedCents > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {formatCurrency(spending.data.unclassifiedCents)} em saídas sem
          categoria ainda não contam.
        </p>
      ) : null}
    </Panel>
  )
}

function CapRow({
  name,
  spentCents,
  capCents,
  editingInitially = false,
  frozen,
  pending,
  onSave,
  onCancel,
}: {
  name: string
  spentCents: number
  capCents: number | null
  editingInitially?: boolean
  frozen: boolean
  pending: boolean
  onSave: (cents: number | null) => void
  onCancel?: () => void
}) {
  const [editing, setEditing] = useState(editingInitially)
  const [draft, setDraft] = useState(
    capCents === null ? '' : formatMinorUnitsForInput(capCents),
  )
  const parsed = parseCap(draft)
  const over = capCents !== null && spentCents > capCents

  const close = () => {
    setEditing(false)
    onCancel?.()
  }

  return (
    <li className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{name}</span>
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (parsed === null) return
              onSave(parsed)
              setEditing(false)
            }}
          >
            <Input
              autoFocus
              inputMode="decimal"
              className="h-8 w-28 text-right tabular-nums"
              aria-label={`Teto mensal de ${name}`}
              placeholder="0,00"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type="submit"
              size="icon-sm"
              aria-label={`Salvar teto de ${name}`}
              disabled={parsed === null || pending}
            >
              <Check />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Cancelar"
              onClick={close}
            >
              <X />
            </Button>
          </form>
        ) : (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <span
              className={cn(
                'text-muted-foreground',
                over && 'font-medium text-destructive',
              )}
            >
              {formatCurrency(spentCents)}
              {capCents === null
                ? ' · sem teto'
                : ` de ${formatCurrency(capCents)}`}
            </span>
            {frozen ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={`${capCents === null ? 'Definir' : 'Alterar'} teto de ${name}`}
                disabled={pending}
                onClick={() => setEditing(true)}
              >
                <PencilLine />
              </Button>
            )}
            {frozen || capCents === null ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={`Remover teto de ${name}`}
                disabled={pending}
                onClick={() => onSave(null)}
              >
                <X />
              </Button>
            )}
          </span>
        )}
      </div>
      {capCents === null ? null : (
        <>
          <ProgressBar value={spentCents} max={capCents} />
          {over ? (
            <span className="text-xs text-destructive">
              {formatCurrency(spentCents - capCents)} acima do teto
            </span>
          ) : null}
        </>
      )}
    </li>
  )
}
