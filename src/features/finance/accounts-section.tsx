import { Archive, ArchiveRestore, Building2, Plug, Plus } from 'lucide-react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'
import { useState } from 'react'

import { BalanceCheckpointDialog } from '#/components/balance-checkpoint-dialog'
import { EmptyState, Panel, PageHeader, StatusBadge } from '#/components/ui'
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
import { currencyOptions, formatCurrency } from '#/lib/currency'
import { formatInstrumentName } from '#/lib/finance'
import { formatShortDate as formatDate } from '#/lib/period'
import { InstrumentCard } from '#/features/finance/instrument-card'
import {
  archiveAccountFn,
  openAccountFn,
  restoreAccountFn,
  updateAccountFn,
} from '#/features/data/accounts.functions'
import {
  balanceSourceLabels,
  currentBalance,
  isCard,
  isInvestment,
} from '#/features/data/accounts'
import type { AccountView, Owner } from '#/features/data/accounts'
import {
  accountsOptions,
  balanceProofOptions,
  invalidateAfterReactors,
  ownersOptions,
} from '#/features/data/queries'
import { errorMessage } from '#/lib/api/errors'

type BankKind = Exclude<AccountView['kind'], 'credit_card'>

export function AccountsSection() {
  const { data: allAccounts } = useSuspenseQuery(accountsOptions(true))
  const { data: owners } = useSuspenseQuery(ownersOptions())
  const queryClient = useQueryClient()
  const openAccount = useServerFn(openAccountFn)
  const updateAccount = useServerFn(updateAccountFn)
  const archiveAccount = useServerFn(archiveAccountFn)
  const restoreAccount = useServerFn(restoreAccountFn)
  const [error, setError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const accounts = allAccounts.filter((account) => !isCard(account))
  const editing = accounts.find((account) => account.id === editingId)
  const ownerName = new Map(owners.map((owner) => [owner.id, owner.name]))
  const invalidate = () => invalidateAfterReactors(queryClient)
  const fail = (fallback: string) => (reason: unknown) => {
    const message = errorMessage(reason, fallback)
    setError(message)
    toast.error(message)
  }
  const createMutation = useMutation({
    mutationFn: openAccount,
    onSuccess: () => {
      toast.success('Conta adicionada.')
      setAddOpen(false)
      void invalidate()
    },
    onError: fail('Não foi possível salvar.'),
  })
  const updateMutation = useMutation({
    mutationFn: updateAccount,
    onSuccess: () => {
      toast.success('Conta atualizada.')
      setEditingId(null)
      void invalidate()
    },
    onError: fail('Não foi possível atualizar.'),
  })
  const archiveMutation = useMutation({
    mutationFn: archiveAccount,
    onSuccess: (account) => {
      toast.success(`${account.name} arquivada. O histórico continua salvo.`)
      setEditingId(null)
      void invalidate()
    },
    onError: fail('Não foi possível arquivar.'),
  })
  const restoreMutation = useMutation({
    mutationFn: restoreAccount,
    onSuccess: (account) => {
      toast.success(`${account.name} voltou para as contas ativas.`)
      void invalidate()
    },
    onError: (reason) =>
      toast.error(errorMessage(reason, 'Não foi possível restaurar.')),
  })

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const kind = String(form.get('kind')) as BankKind
    createMutation.mutate({
      data: {
        ownerId: String(form.get('ownerId')),
        name: String(form.get('name')).trim(),
        institutionName: String(form.get('institutionName')).trim(),
        kind,
        purpose: kind === 'investment' ? 'investment' : 'operating',
        currency: String(form.get('currency')),
      },
    })
  }

  function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    setError('')
    const form = new FormData(event.currentTarget)
    const kind = String(form.get('kind')) as BankKind
    updateMutation.mutate({
      data: {
        accountId: editing.id,
        changes: {
          name: String(form.get('name')).trim(),
          institutionName: String(form.get('institutionName')).trim(),
          kind,
          purpose: kind === 'investment' ? 'investment' : 'operating',
        },
      },
    })
  }

  const active = accounts.filter((account) => !account.archived)
  const archived = accounts.filter((account) => account.archived)
  const currencies = new Set(active.map((account) => account.currency))
  const groups = [
    {
      title: 'Movimentação',
      accounts: active.filter((account) => !isInvestment(account)),
    },
    { title: 'Investimentos', accounts: active.filter(isInvestment) },
  ].filter((group) => group.accounts.length > 0)

  return (
    <>
      <PageHeader
        title="Contas"
        actions={
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
      <div className="grid gap-6">
        {groups.length ? (
          groups.map((group) => (
            <section key={group.title} className="grid gap-3">
              {groups.length > 1 && (
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-medium">{group.title}</h3>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {sumByCurrency(group.accounts)
                      .map(([currency, cents]) =>
                        formatCurrency(cents, currency),
                      )
                      .join(' · ')}
                  </span>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.accounts.map((account) => {
                  const balance = currentBalance(account)
                  return (
                    <InstrumentCard
                      key={account.id}
                      title={formatInstrumentName(account.name)}
                      subtitle={[
                        account.institutionName,
                        ownerName.get(account.ownerId),
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
                          value: balance
                            ? formatCurrency(
                                balance.balanceCents,
                                account.currency,
                              )
                            : '—',
                          caption: balance
                            ? `${formatDate(balance.asOf)} · ${balanceSourceLabels[balance.sourceKind]}`
                            : 'Importe um extrato, conecte o banco ou informe o saldo',
                        },
                      ]}
                      actions={<BalanceCheckpointDialog account={account} />}
                      status={<AccountStatus account={account} />}
                    />
                  )
                })}
              </div>
            </section>
          ))
        ) : (
          <Panel>
            <EmptyState
              icon={Building2}
              title="Cadastre sua primeira conta"
              description="Adicione a conta aqui ou conecte o banco pelo Open Finance."
              action={
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      to="/configuracoes"
                      search={{ tab: 'open-finance' }}
                    />
                  }
                >
                  <Plug data-icon="inline-start" />
                  Conectar banco
                </Button>
              }
            />
          </Panel>
        )}

        {archived.length > 0 && (
          <Panel title="Arquivadas">
            <ul className="divide-y rounded-lg border">
              {archived.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm">
                    {formatInstrumentName(account.name)}
                    <span className="text-muted-foreground">
                      {' '}
                      · {account.institutionName}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={restoreMutation.isPending}
                    onClick={() =>
                      restoreMutation.mutate({
                        data: { accountId: account.id },
                      })
                    }
                  >
                    <ArchiveRestore data-icon="inline-start" />
                    Restaurar
                  </Button>
                </li>
              ))}
            </ul>
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
                  Cadastre a conta antes de importar o extrato.
                </DialogDescription>
              </DialogHeader>
              <AccountFormFields owners={owners} />
              {error && <FieldError>{error}</FieldError>}
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
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
                <AccountFormFields owners={owners} account={editing} />
                {error && <FieldError>{error}</FieldError>}
                <DialogFooter className="sm:justify-between">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={archiveMutation.isPending}
                    onClick={() =>
                      archiveMutation.mutate({
                        data: { accountId: editing.id },
                      })
                    }
                  >
                    <Archive data-icon="inline-start" />
                    Arquivar
                  </Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <DialogClose
                      render={<Button type="button" variant="outline" />}
                    >
                      Cancelar
                    </DialogClose>
                    <Button type="submit" disabled={updateMutation.isPending}>
                      {updateMutation.isPending
                        ? 'Salvando…'
                        : 'Salvar alterações'}
                    </Button>
                  </div>
                </DialogFooter>
              </form>
            </DialogContent>
          )}
        </Dialog>
      </div>
    </>
  )
}

/** Open Finance link and whether the balances prove the posted movements. */
function AccountStatus({ account }: { account: AccountView }) {
  const proof = useQuery(balanceProofOptions(account.id))
  const intervals = proof.data?.supported ? proof.data.intervals : []
  const gaps = intervals.filter((interval) => interval.differenceCents !== 0)
  const provedUntil = intervals.at(-1)?.to
  return (
    <>
      {account.link ? (
        <StatusBadge tone="info">
          <Plug />
          Open Finance
        </StatusBadge>
      ) : null}
      {gaps.map((gap) => (
        <StatusBadge
          key={`${gap.from}-${gap.to}`}
          tone="warning"
          render={<Link to="/importar" search={{ account: account.id }} />}
        >
          Diferença de{' '}
          {formatCurrency(Math.abs(gap.differenceCents), account.currency)}{' '}
          entre {formatDate(gap.from)} e {formatDate(gap.to)}
        </StatusBadge>
      ))}
      {!gaps.length && provedUntil ? (
        <StatusBadge tone="success">
          Saldo conferido até {formatDate(provedUntil)}
        </StatusBadge>
      ) : null}
      {proof.isSuccess && !intervals.length && account.lastCheckpoint ? (
        <StatusBadge>
          Primeiro saldo: {formatDate(account.lastCheckpoint.asOf)}
        </StatusBadge>
      ) : null}
      {proof.isSuccess && !account.lastCheckpoint ? (
        <StatusBadge>Sem saldo para conferir</StatusBadge>
      ) : null}
    </>
  )
}

function AccountFormFields({
  owners,
  account,
}: {
  owners: ReadonlyArray<Owner>
  account?: AccountView
}) {
  const prefix = account ? `account-${account.id}` : 'account-new'
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
          defaultValue={account?.institutionName ?? ''}
          required
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-owner`}>Titular</FieldLabel>
        <NativeSelect
          id={`${prefix}-owner`}
          name="ownerId"
          className="w-full"
          defaultValue={account?.ownerId}
          disabled={Boolean(account)}
          required
        >
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
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
          defaultValue={account?.kind}
        >
          <option value="checking">Conta corrente</option>
          <option value="savings">Poupança</option>
          <option value="cash">Dinheiro</option>
          <option value="investment">Corretora</option>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-currency`}>Moeda</FieldLabel>
        <NativeSelect
          id={`${prefix}-currency`}
          name="currency"
          className="w-full"
          defaultValue={account?.currency ?? 'BRL'}
          disabled={Boolean(account)}
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

function sumByCurrency(accounts: ReadonlyArray<AccountView>) {
  const totals = new Map<string, number>()
  for (const account of accounts) {
    const balance = currentBalance(account)
    if (!balance) continue
    totals.set(
      account.currency,
      (totals.get(account.currency) ?? 0) + balance.balanceCents,
    )
  }
  return [...totals.entries()]
}
