import { Check, Sparkles } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'

import { CategorySelect } from '#/components/category-select'
import { Panel } from '#/components/ui'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Skeleton } from '#/components/ui/skeleton'
import {
  formatCurrency,
  formatMinorUnitsForInput,
  toMinorUnits as toCents,
} from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatShortDate as formatDate } from '#/domain/period'
import type { DetectedRecurrence } from '@spendle/server/api'

import {
  approveDetectedFn,
  ignoreDetectedFn,
} from '#/features/v2/planning.functions'
import {
  detectedRecurrencesOptions,
  invalidateAfterReactors,
} from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'

import type { PlanningData } from './types'

function DetectedRecurrencesPanel({ data }: { data: PlanningData }) {
  const queryClient = useQueryClient()
  const detection = useQuery(detectedRecurrencesOptions())
  const approve = useServerFn(approveDetectedFn)
  const ignore = useServerFn(ignoreDetectedFn)
  const invalidate = () => invalidateAfterReactors(queryClient)
  const approveMutation = useMutation({
    mutationFn: approve,
    onSuccess: (result) => {
      toast.success(
        `Recorrência criada com ${result.linked} pagamento(s) já conciliado(s).`,
      )
      void invalidate()
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível aprovar.')),
  })
  const ignoreMutation = useMutation({
    mutationFn: ignore,
    onSuccess: () => {
      toast.success('Candidato ignorado. Não vai aparecer de novo.')
      void invalidate()
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível ignorar.')),
  })

  const candidates = detection.data ?? []
  if (!detection.isPending && candidates.length === 0) return null

  return (
    <Panel
      title="Recorrências detectadas"
      description="Ao aprovar, os pagamentos anteriores também serão conciliados."
    >
      {detection.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {candidates.map((candidate) => (
            <DetectedRecurrenceCard
              key={candidate.key}
              candidate={candidate}
              data={data}
              pending={approveMutation.isPending || ignoreMutation.isPending}
              onApprove={(input) => approveMutation.mutate({ data: input })}
              onIgnore={() =>
                ignoreMutation.mutate({
                  data: {
                    signature: candidate.signature,
                    direction: candidate.direction,
                  },
                })
              }
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

function DetectedRecurrenceCard({
  candidate,
  data,
  pending,
  onApprove,
  onIgnore,
}: {
  candidate: DetectedRecurrence
  data: PlanningData
  pending: boolean
  onApprove: (input: {
    name: string
    categoryId: string
    amountCents: number
    currency: string
    direction: 'income' | 'expense'
    amountMode: 'fixed' | 'variable'
    frequency: 'monthly' | 'yearly'
    nextDate: string
    accountId: string | null
    entryIds: ReadonlyArray<string>
  }) => void
  onIgnore: () => void
}) {
  const allowedCategories = data.categories.filter((category) =>
    candidate.direction === 'income'
      ? category.bucket === 'income'
      : category.bucket === 'essential' || category.bucket === 'lifestyle',
  )
  const [name, setName] = useState(candidate.name)
  const [categoryId, setCategoryId] = useState(
    allowedCategories.some((category) => category.id === candidate.categoryId)
      ? (candidate.categoryId ?? '')
      : '',
  )
  const [amountInput, setAmountInput] = useState(
    formatMinorUnitsForInput(candidate.typicalAmountCents, candidate.currency),
  )
  const amountCents = (() => {
    try {
      return Math.abs(toCents(amountInput, candidate.currency))
    } catch {
      return null
    }
  })()
  const source =
    data.accounts.find((item) => item.id === candidate.accountId)?.name ?? null
  const recent = [...candidate.entries].reverse().slice(0, 3)
  const canApprove =
    name.trim().length >= 2 &&
    categoryId !== '' &&
    amountCents !== null &&
    amountCents > 0

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Nome da recorrência"
            className="font-medium"
          />
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
              <Sparkles className="size-3" />
              {candidate.confidence}% de confiança
            </span>
            <span>
              {candidate.frequency === 'monthly' ? 'Mensal' : 'Anual'}
            </span>
            <span>·</span>
            <span>
              {candidate.amountMode === 'fixed'
                ? 'valor fixo'
                : `varia de ${formatCurrency(candidate.minAmountCents, candidate.currency)} a ${formatCurrency(candidate.maxAmountCents, candidate.currency)}`}
            </span>
            {source && (
              <>
                <span>·</span>
                <span>{formatInstrumentName(source)}</span>
              </>
            )}
          </p>
        </div>
        <strong
          className={
            candidate.direction === 'income'
              ? 'shrink-0 tabular-nums text-success'
              : 'shrink-0 tabular-nums text-destructive'
          }
        >
          {candidate.direction === 'expense' ? '−' : '+'}
          {formatCurrency(candidate.typicalAmountCents, candidate.currency)}
        </strong>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <CategorySelect
          categories={allowedCategories}
          value={categoryId || null}
          onValueChange={setCategoryId}
          allowTransfer={false}
          aria-label={`Categoria de ${name || candidate.name}`}
        />
        <Input
          inputMode="decimal"
          value={amountInput}
          onChange={(event) => setAmountInput(event.target.value)}
          aria-label="Valor da recorrência"
          aria-invalid={amountCents === null}
          className="tabular-nums"
        />
      </div>

      <ul className="divide-y rounded-md border bg-muted/30 text-xs">
        {recent.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 px-3 py-1.5"
          >
            <span className="text-muted-foreground">
              {formatDate(item.bookedOn)}
            </span>
            <span className="font-medium tabular-nums">
              {formatCurrency(Math.abs(item.amountCents), candidate.currency)}
            </span>
          </li>
        ))}
        {candidate.entries.length > recent.length && (
          <li className="px-3 py-1.5 text-muted-foreground">
            + {candidate.entries.length - recent.length} pagamento(s) anteriores
          </li>
        )}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Próximo previsto: {formatDate(candidate.nextExpectedDate)}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onIgnore}
          >
            Ignorar
          </Button>
          <Button
            size="sm"
            disabled={pending || !canApprove}
            onClick={() =>
              amountCents !== null &&
              onApprove({
                name: name.trim(),
                categoryId,
                amountCents,
                currency: candidate.currency,
                direction: candidate.direction,
                amountMode: candidate.amountMode,
                frequency: candidate.frequency,
                nextDate: candidate.nextExpectedDate,
                accountId: candidate.accountId,
                entryIds: candidate.entries.map((item) => item.id),
              })
            }
          >
            <Check data-icon="inline-start" /> Aprovar
          </Button>
        </div>
      </div>
    </div>
  )
}

export { DetectedRecurrencesPanel }
