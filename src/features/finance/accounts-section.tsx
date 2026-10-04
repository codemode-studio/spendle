import { Building2, Plus } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'
import { useState } from 'react'

import { EmptyState, Panel, SectionHeader, StatusBadge } from '#/components/ui'
import { BalanceCheckpointDialog } from '#/components/balance-checkpoint-dialog'
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
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect } from '#/components/ui/native-select'
import { currencyOptions, formatCurrency } from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { readAccountForm } from '#/features/finance/account-form'
import { formatShortDate as formatDate } from '#/domain/period'
import {
  createAccountFn,
  updateAccountFn,
} from '#/features/finance/finance.functions'
import { InstrumentCard } from '#/features/finance/instrument-card'
import {
  configurationOptions,
  invalidateFinance,
} from '#/features/finance/queries'
import type {
  AccountSnapshot,
  FinanceSnapshot,
} from '#/features/finance/snapshot.types'

type AccountStatusSnapshot = Pick<
  AccountSnapshot,
  'coverage' | 'currency' | 'latestCheckpoint' | 'latestVerifiedCheckpoint'
>
type AccountFormSnapshot = Pick<
  AccountSnapshot,
  | 'currency'
  | 'id'
  | 'institution'
  | 'kind'
  | 'name'
  | 'ownershipScopeId'
  | 'purpose'
>
type OwnershipScopeOption = Pick<
  FinanceSnapshot['scopes'][number],
  'id' | 'name'
>

export function AccountsSection() {
  const { data } = useSuspenseQuery(configurationOptions())
  const queryClient = useQueryClient()
  const createAccount = useServerFn(createAccountFn)
  const updateAccount = useServerFn(updateAccountFn)
  const [error, setError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = data.accounts.find((account) => account.id === editingId)
  const invalidate = () => invalidateFinance(queryClient, 'ledger')
  const fail = (fallback: string) => (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : fallback
    setError(message)
    toast.error(message)
  }
  const createMutation = useMutation({
    mutationFn: createAccount,
    onSuccess: () => {
      toast.success('Conta adicionada.')
      setAddOpen(false)
      invalidate()
    },
    onError: fail('Não foi possível salvar.'),
  })
  const updateMutation = useMutation({
    mutationFn: updateAccount,
    onSuccess: () => {
      toast.success('Conta atualizada.')
      setEditingId(null)
      invalidate()
    },
    onError: fail('Não foi possível atualizar.'),
  })

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    createMutation.mutate({
      data: {
        ...readAccountForm(new FormData(event.currentTarget)),
        initialBalanceCents: 0,
      },
    })
  }

  function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    setError('')
    updateMutation.mutate({
      data: {
        id: editing.id,
        ...readAccountForm(new FormData(event.currentTarget)),
      },
    })
  }

  const activeAccounts = data.accounts.filter((account) => account.active)
  const currencies = new Set(activeAccounts.map((account) => account.currency))
  const groups = [
    {
      title: 'Movimentação',
      accounts: activeAccounts.filter((account) => !isInvestment(account)),
    },
    {
      title: 'Investimentos',
      accounts: activeAccounts.filter(isInvestment),
    },
  ].filter((group) => group.accounts.length > 0)

  return (
    <div className="grid gap-6">
      <SectionHeader
        title="Contas"
        action={
          <Button
            type="button"
            onClick={() => {
              setError('')
              setAddOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Conta
          </Button>
        }
      />
      {groups.length ? (
        groups.map((group) => (
          <section key={group.title} className="grid gap-3">
            {groups.length > 1 && (
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-medium">{group.title}</h3>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {sumByCurrency(group.accounts)
                    .map(([currency, cents]) => formatCurrency(cents, currency))
                    .join(' · ')}
                </span>
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {group.accounts.map((account) => (
                <InstrumentCard
                  key={account.id}
                  title={formatInstrumentName(account.name)}
                  subtitle={[
                    account.institution?.name ?? 'Sem instituição',
                    account.scope?.name,
                    currencies.size > 1 ? account.currency : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  editLabel={`Editar ${formatInstrumentName(account.name)}`}
                  onEdit={() => {
                    setError('')
                    setEditingId(account.id)
                  }}
                  metrics={[
                    {
                      label: 'Saldo',
                      value: formatCurrency(
                        account.balanceCents,
                        account.currency,
                      ),
                      caption: account.latestCheckpoint
                        ? `Atualizado ${formatDate(account.latestCheckpoint.asOf)}`
                        : 'Ainda não atualizado',
                    },
                    ...(account.projectedBalanceCents !== account.balanceCents
                      ? [
                          {
                            label: 'Projetado',
                            value: formatCurrency(
                              account.projectedBalanceCents,
                              account.currency,
                            ),
                            caption: 'Com lançamentos pendentes',
                          },
                        ]
                      : []),
                  ]}
                  status={<AccountStatus account={account} />}
                  actions={
                    <BalanceCheckpointDialog
                      targetType="account"
                      targetId={account.id}
                      targetName={formatInstrumentName(account.name)}
                      targetCurrency={account.currency}
                      trigger="icon"
                    />
                  }
                />
              ))}
            </div>
          </section>
        ))
      ) : (
        <Panel>
          <EmptyState
            icon={Building2}
            title="Cadastre sua primeira conta"
            description="Contas pessoais e empresariais."
          />
        </Panel>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!createMutation.isPending) setAddOpen(open)
          if (!open) setError('')
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submitCreate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar conta</DialogTitle>
              <DialogDescription>
                Cadastre uma conta PF ou PJ antes de importar o extrato.
              </DialogDescription>
            </DialogHeader>
            <AccountFormFields scopes={data.scopes} />
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Salvando…' : 'Salvar conta'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !updateMutation.isPending) setEditingId(null)
          if (!open) setError('')
        }}
      >
        {editing && (
          <DialogContent className="sm:max-w-lg">
            <form onSubmit={submitEdit} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Editar conta</DialogTitle>
                <DialogDescription>
                  O saldo e o histórico importado não mudam.
                </DialogDescription>
              </DialogHeader>
              <AccountFormFields scopes={data.scopes} account={editing} />
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  Cancelar
                </DialogClose>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Salvando…' : 'Salvar alterações'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

function AccountStatus({ account }: { account: AccountStatusSnapshot }) {
  const coverageEnd = account.coverage.latestCoverageEnd
  const verifiedAt = account.latestVerifiedCheckpoint?.asOf ?? null
  const freshness = account.coverage.freshness.status
  const tone =
    freshness === 'current'
      ? 'success'
      : freshness === 'recommended'
        ? 'warning'
        : 'neutral'
  const difference = account.latestCheckpoint?.differenceCents ?? 0
  return (
    <>
      {coverageEnd ? (
        <StatusBadge tone={tone}>
          {verifiedAt && verifiedAt >= coverageEnd ? 'Conferido' : 'Extrato'}{' '}
          até {formatDate(coverageEnd)}
        </StatusBadge>
      ) : (
        <StatusBadge>Sem extratos</StatusBadge>
      )}
      {difference !== 0 && (
        <StatusBadge tone="warning">
          Diferença de {formatCurrency(Math.abs(difference), account.currency)}
        </StatusBadge>
      )}
      {account.coverage.gaps.map((gap) => (
        <StatusBadge
          key={`${gap.start}-${gap.end}`}
          tone="warning"
          render={<Link to="/importar" search={{ view: 'upload' }} />}
        >
          Falta {formatDate(gap.start)} a {formatDate(gap.end)}
        </StatusBadge>
      ))}
    </>
  )
}

export function AccountFormFields({
  scopes,
  account,
}: {
  scopes: ReadonlyArray<OwnershipScopeOption>
  account?: AccountFormSnapshot
}) {
  const prefix = account ? `account-${account.id}` : 'account-new'
  const [kind, setKind] = useState(account?.kind ?? 'checking')
  const [purpose, setPurpose] = useState(account?.purpose ?? 'operating')
  // A brokerage account is always an investment, so its purpose is fixed.
  const brokerage = kind === 'investment'
  return (
    <FieldGroup className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Nome</FieldLabel>
        <Input
          id={`${prefix}-name`}
          name="name"
          placeholder="Conta principal"
          defaultValue={account?.name}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-bank`}>Instituição</FieldLabel>
        <Input
          id={`${prefix}-bank`}
          name="institutionName"
          placeholder="Banco"
          defaultValue={account?.institution?.name ?? ''}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-owner`}>Proprietário</FieldLabel>
        <NativeSelect
          id={`${prefix}-owner`}
          name="ownershipScopeId"
          className="w-full"
          defaultValue={account?.ownershipScopeId}
          required
        >
          {scopes.map((scope) => (
            <option key={scope.id} value={scope.id}>
              {scope.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-kind`}>Tipo</FieldLabel>
        <NativeSelect
          id={`${prefix}-kind`}
          name="kind"
          className="w-full"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="checking">Conta corrente</option>
          <option value="savings">Poupança</option>
          <option value="cash">Dinheiro</option>
          <option value="investment">Corretora</option>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-purpose`}>Finalidade</FieldLabel>
        <NativeSelect
          id={`${prefix}-purpose`}
          name="purpose"
          className="w-full"
          value={brokerage ? 'investment' : purpose}
          onChange={(event) => setPurpose(event.target.value as typeof purpose)}
          disabled={brokerage}
        >
          <option value="operating">Uso cotidiano</option>
          <option value="reserve">Reserva</option>
          <option value="investment">Investimentos</option>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-currency`}>Moeda</FieldLabel>
        <NativeSelect
          id={`${prefix}-currency`}
          name="currency"
          className="w-full"
          defaultValue={account?.currency}
        >
          {currencyOptions.map((currency) => (
            <option key={currency.value} value={currency.value}>
              {currency.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </FieldGroup>
  )
}

function isInvestment(account: Pick<AccountSnapshot, 'kind' | 'purpose'>) {
  return account.kind === 'investment' || account.purpose === 'investment'
}

function sumByCurrency(
  accounts: ReadonlyArray<Pick<AccountSnapshot, 'balanceCents' | 'currency'>>,
) {
  const totals = new Map<string, number>()
  for (const account of accounts) {
    totals.set(
      account.currency,
      (totals.get(account.currency) ?? 0) + account.balanceCents,
    )
  }
  return [...totals.entries()]
}
