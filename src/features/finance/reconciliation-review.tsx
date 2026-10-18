import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CreditCard,
  Link2,
  RotateCcw,
  Search,
  Undo2,
  X,
} from 'lucide-react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useDeferredValue, useState } from 'react'
import { toast } from 'sonner'

import { Panel, StatusBadge } from '#/components/ui'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Skeleton } from '#/components/ui/skeleton'
import { formatCurrency } from '#/lib/currency'
import { formatInstrumentName } from '#/lib/finance'
import { formatShortDate } from '#/lib/period'
import {
  decideRelationFn,
  linkEntriesFn,
} from '#/features/data/reconciliation.functions'
import {
  accountsOptions,
  invalidateAfterReactors,
  linkCandidatesOptions,
  orphanedDecisionsOptions,
  relationsOptions,
} from '#/features/data/queries'
import { errorMessage } from '#/lib/api/errors'
import { cn } from '#/lib/utils'

import type { Entry, Relation } from '@spendle/server/api'

type RelationView = Relation & { outflow: Entry | null; inflow: Entry | null }

const kindCopy: Record<
  Relation['kind'],
  { label: string; icon: typeof ArrowLeftRight }
> = {
  internal_transfer: {
    label: 'Transferência entre contas',
    icon: ArrowLeftRight,
  },
  card_payment: { label: 'Pagamento de fatura', icon: CreditCard },
  refund: { label: 'Estorno', icon: RotateCcw },
}

/** Short pt-BR evidence for the matcher's reason codes; unknown codes are hidden. */
const reasonCopy: Record<string, string | undefined> = {
  same_amount: 'mesmo valor',
  full_amount: 'valor total',
  partial_amount: 'valor parcial',
  same_day: 'mesmo dia',
  next_day: 'dia seguinte',
  own_accounts: 'contas próprias',
  same_account: 'mesma conta',
  described_on_both_sides: 'descrição nas duas pontas',
  described_on_one_side: 'descrição em uma ponta',
  refund_wording: 'texto de estorno',
  partial_wording: 'texto de parcial',
  own_account_wording: 'texto de conta própria',
  names_card_institution: 'cita o emissor do cartão',
  names_other_account: 'cita a outra conta',
  same_merchant: 'mesmo estabelecimento',
  similar_merchant: 'estabelecimento parecido',
  same_counterparty: 'mesma contraparte',
  confirmed_by_person: 'confirmado por você',
  names_third_party: 'cita terceiro',
  names_other_payee: 'cita outro favorecido',
  different_counterparties: 'contrapartes diferentes',
  uncertain_counterparties: 'contrapartes incertas',
  conflicting_description: 'descrições conflitantes',
  facts_changed: 'lançamentos mudaram',
}

const orphanCopy = {
  entry_missing: 'um lançamento deixou de existir',
  entry_split: 'um lançamento se dividiu',
  overlapping_confirmation: 'outra confirmação usa o mesmo lançamento',
} as const

/** Suggested and confirmed pairs, with both sides, below the transaction list. */
export function ReconciliationReview() {
  const { data: relations } = useSuspenseQuery(relationsOptions())
  const { data: orphaned } = useSuspenseQuery(orphanedDecisionsOptions())
  const queryClient = useQueryClient()
  const decide = useServerFn(decideRelationFn)
  const mutation = useMutation({
    mutationFn: decide,
    onSuccess: (decision) => {
      toast.success(
        decision.decision === 'confirmed'
          ? 'Vínculo confirmado.'
          : 'Vínculo rejeitado. Esse par não será sugerido de novo.',
      )
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível salvar a decisão.')),
  })
  const pending = relations.filter(
    (relation) => relation.status !== 'confirmed',
  )
  const confirmed = relations.filter(
    (relation) => relation.status === 'confirmed',
  )
  const decidingKey = mutation.isPending ? mutation.variables.data.key : null

  return (
    <>
      {pending.length > 0 && (
        <Panel
          title="Vínculos sugeridos"
          description="Confirme quando as duas pontas forem a mesma movimentação."
          className="mt-4"
        >
          <ul className="flex flex-col gap-3">
            {pending.map((relation) => (
              <li
                key={relation.key}
                className="flex flex-col justify-between gap-3 rounded-lg border p-3 md:flex-row md:items-center"
              >
                <RelationSummary relation={relation} />
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={decidingKey === relation.key}
                    onClick={() =>
                      mutation.mutate({
                        data: { key: relation.key, decision: 'rejected' },
                      })
                    }
                  >
                    <X data-icon="inline-start" />
                    Rejeitar
                  </Button>
                  <Button
                    size="sm"
                    disabled={decidingKey === relation.key}
                    onClick={() =>
                      mutation.mutate({
                        data: { key: relation.key, decision: 'confirmed' },
                      })
                    }
                  >
                    <Check data-icon="inline-start" />
                    Confirmar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {orphaned.length > 0 && (
        <Panel
          title="Confirmações sem par"
          description="Os lançamentos reservados ficam fora do pareamento automático até você liberar."
          className="mt-4"
        >
          <ul className="divide-y rounded-lg border text-sm">
            {orphaned.map((decision) => (
              <li
                key={decision.key}
                className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  {kindLabel(decision.key)}: {orphanCopy[decision.reason]}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={decidingKey === decision.key}
                  onClick={() =>
                    mutation.mutate({
                      data: { key: decision.key, decision: 'rejected' },
                    })
                  }
                >
                  <Undo2 data-icon="inline-start" />
                  Liberar lançamentos
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {confirmed.length > 0 && (
        <Panel
          title="Vínculos confirmados"
          description="Transferências e faturas pagas ficam fora dos gastos."
          className="mt-4"
        >
          <ul className="divide-y rounded-lg border">
            {confirmed.map((relation) => (
              <li
                key={relation.key}
                className="flex flex-col justify-between gap-3 px-3 py-2.5 md:flex-row md:items-center"
              >
                <RelationSummary relation={relation} compact />
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 self-start md:self-center"
                  disabled={decidingKey === relation.key}
                  onClick={() =>
                    mutation.mutate({
                      data: { key: relation.key, decision: 'rejected' },
                    })
                  }
                >
                  <Undo2 data-icon="inline-start" />
                  Desfazer
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  )
}

function kindLabel(key: string) {
  const kind = key.split(':')[0]
  return kind && kind in kindCopy
    ? kindCopy[kind as Relation['kind']].label
    : 'Vínculo'
}

function RelationSummary({
  relation,
  compact = false,
}: {
  relation: RelationView
  compact?: boolean
}) {
  const { data: accounts } = useQuery(accountsOptions(true))
  const accountName = (id: string | undefined) =>
    formatInstrumentName(
      accounts?.find((account) => account.id === id)?.name ?? 'Conta',
    )
  const copy = kindCopy[relation.kind]
  const reasons = relation.reasons
    .map((reason) => reasonCopy[reason])
    .filter((reason): reason is string => Boolean(reason))
  return (
    <div className="flex min-w-0 items-start gap-3">
      <copy.icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">{copy.label}</strong>
          {relation.status === 'conflict' ? (
            <StatusBadge tone="warning">Em conflito</StatusBadge>
          ) : null}
          {relation.origin === 'person' ? (
            <StatusBadge>Por você</StatusBadge>
          ) : !compact ? (
            <StatusBadge tone="info">
              {relation.score}% de confiança
            </StatusBadge>
          ) : (
            <StatusBadge>Automático</StatusBadge>
          )}
        </div>
        {!compact && reasons.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {reasons.join(' · ')}
          </p>
        ) : null}
        <div className="mt-2 flex flex-col gap-1">
          {(
            [
              ['Saída', relation.outflow],
              ['Entrada', relation.inflow],
            ] as const
          ).map(([side, entry]) => (
            <div
              key={side}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
            >
              {side === 'Saída' ? (
                <ArrowUpRight
                  aria-label="Saída"
                  className="size-3.5 shrink-0 text-destructive"
                />
              ) : (
                <ArrowDownLeft
                  aria-label="Entrada"
                  className="size-3.5 shrink-0 text-success"
                />
              )}
              {entry ? (
                <>
                  <span className="font-medium">
                    {accountName(entry.accountId)}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {entry.description}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatShortDate(entry.bookedOn)}
                  </span>
                  <strong className="tabular-nums">
                    {formatCurrency(entry.amountCents, entry.currency)}
                  </strong>
                </>
              ) : (
                <span className="text-muted-foreground">
                  Lançamento sendo reprocessado
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Pairs an entry with the other side the matcher missed: a transfer or bill
 * payment across accounts, or a refund on the same account.
 */
export function LinkEntryDialog({
  entry,
  onClose,
}: {
  entry: Entry | null
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const deferredText = useDeferredValue(text.trim())
  const candidates = useQuery(
    linkCandidatesOptions(entry?.id ?? null, deferredText),
  )
  const { data: accounts } = useQuery(accountsOptions(true))
  const queryClient = useQueryClient()
  const link = useServerFn(linkEntriesFn)
  const mutation = useMutation({
    mutationFn: link,
    onSuccess: () => {
      toast.success('Lançamentos vinculados.')
      setText('')
      onClose()
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível vincular.')),
  })
  const accountName = (id: string) =>
    formatInstrumentName(
      accounts?.find((account) => account.id === id)?.name ?? 'Conta',
    )

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          setText('')
          onClose()
        }
      }}
    >
      {entry ? (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Vincular a outro lançamento</DialogTitle>
            <DialogDescription>
              {entry.description} · {formatShortDate(entry.bookedOn)} ·{' '}
              {formatCurrency(entry.amountCents, entry.currency)}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Buscar pela descrição da outra ponta…"
              aria-label="Buscar a outra ponta"
              className="pl-8 md:pl-8"
            />
          </div>
          {candidates.isPending ? (
            <Skeleton className="h-32" />
          ) : candidates.data?.candidates.length ? (
            <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
              {candidates.data.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        data:
                          entry.amountCents < 0
                            ? {
                                outflowEntryId: entry.id,
                                inflowEntryId: candidate.id,
                              }
                            : {
                                outflowEntryId: candidate.id,
                                inflowEntryId: entry.id,
                              },
                      })
                    }
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {candidate.description}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {accountName(candidate.accountId)} ·{' '}
                        {formatShortDate(candidate.bookedOn)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span
                        className={cn(
                          'font-medium tabular-nums',
                          candidate.amountCents > 0 && 'text-emerald-700',
                        )}
                      >
                        {formatCurrency(
                          candidate.amountCents,
                          candidate.currency,
                        )}
                      </span>
                      <Link2 className="size-4 text-muted-foreground" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              Nenhum lançamento de sentido oposto com esse valor. Busque pela
              descrição ou importe o extrato da outra conta.
            </p>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
