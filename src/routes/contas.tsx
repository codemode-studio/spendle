import { Building2, Landmark, Plus } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'
import { useState } from 'react'

import { EmptyState, PageHeader, Panel, StatusBadge } from '#/components/ui'
import { BalanceCheckpointDialog } from '#/components/balance-checkpoint-dialog'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
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
import {
  currencyOptions,
  formatCurrency,
  formatDate,
  formatInstrumentName,
  parseCurrency,
} from '#/domain/finance'
import { createAccountFn } from '#/features/finance/finance.functions'
import {
  financeQueryKeys,
  financeSnapshotOptions,
} from '#/features/finance/queries'

export const Route = createFileRoute('/contas')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(financeSnapshotOptions()),
  component: AccountsPage,
})

function AccountsPage() {
  const { data } = useSuspenseQuery(financeSnapshotOptions())
  const queryClient = useQueryClient()
  const createAccount = useServerFn(createAccountFn)
  const [error, setError] = useState('')
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: () => {
      toast.success('Conta adicionada.')
      setAddAccountOpen(false)
      queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
    },
    onError: (reason) => {
      const message =
        reason instanceof Error ? reason.message : 'Não foi possível salvar.'
      setError(message)
      toast.error(message)
    },
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const currency = parseCurrency(String(form.get('currency')))
    mutation.mutate({
      data: {
        name: String(form.get('name')),
        institutionName: String(form.get('institutionName')),
        ownershipScopeId: String(form.get('ownershipScopeId')),
        kind: String(form.get('kind')) as
          'checking' | 'savings' | 'cash' | 'investment',
        purpose: String(form.get('purpose')) as
          'operating' | 'reserve' | 'investment',
        currency,
        initialBalanceCents: 0,
      },
    })
  }

  const accountSections = [
    {
      title: 'Movimentação',
      description: 'Contas correntes, reservas e dinheiro do dia a dia.',
      accounts: data.accounts.filter(
        (account) =>
          account.kind !== 'investment' && account.purpose !== 'investment',
      ),
    },
    {
      title: 'Investimentos',
      description: 'Corretoras, exchanges e demais contas de investimento.',
      accounts: data.accounts.filter(
        (account) =>
          account.kind === 'investment' || account.purpose === 'investment',
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        eyebrow="Patrimônio"
        title="Contas"
        description="Saldos por conta, proprietário e moeda."
        actions={
          <Button
            type="button"
            onClick={() => {
              setError('')
              setAddAccountOpen(true)
            }}
          >
            <Plus data-icon="inline-start" />
            Conta
          </Button>
        }
      />
      <Dialog
        open={addAccountOpen}
        onOpenChange={(open) => {
          if (!mutation.isPending) setAddAccountOpen(open)
          if (!open) setError('')
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar conta</DialogTitle>
              <DialogDescription>
                Cadastre uma conta PF ou PJ antes de importar o extrato.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="account-name">Nome</FieldLabel>
                <Input
                  id="account-name"
                  name="name"
                  placeholder="Conta principal"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="account-bank">Instituição</FieldLabel>
                <Input
                  id="account-bank"
                  name="institutionName"
                  placeholder="Banco"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="account-owner">Proprietário</FieldLabel>
                <NativeSelect
                  id="account-owner"
                  name="ownershipScopeId"
                  className="w-full"
                  required
                >
                  {data.scopes.map((scope) => (
                    <option key={scope.id} value={scope.id}>
                      {scope.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="account-kind">Tipo</FieldLabel>
                <NativeSelect id="account-kind" name="kind" className="w-full">
                  <option value="checking">Conta corrente</option>
                  <option value="savings">Poupança</option>
                  <option value="cash">Dinheiro</option>
                  <option value="investment">Investimentos</option>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="account-purpose">Finalidade</FieldLabel>
                <NativeSelect
                  id="account-purpose"
                  name="purpose"
                  className="w-full"
                >
                  <option value="operating">Movimentação</option>
                  <option value="reserve">Reserva</option>
                  <option value="investment">Investimentos</option>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="account-currency">Moeda</FieldLabel>
                <NativeSelect
                  id="account-currency"
                  name="currency"
                  className="w-full"
                >
                  {currencyOptions.map((currency) => (
                    <option key={currency.value} value={currency.value}>
                      {currency.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </FieldGroup>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Salvando…' : 'Salvar conta'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {data.accounts.length ? (
        <div className="grid gap-8">
          {accountSections.map((section) => (
            <section key={section.title} aria-labelledby={section.title}>
              <div className="mb-4">
                <h2 id={section.title} className="text-lg font-semibold">
                  {section.title}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {section.description}
                </p>
              </div>
              {section.accounts.length ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {section.accounts.map((account) => (
                    <Card key={account.id}>
                      <CardHeader>
                        <CardTitle>
                          {formatInstrumentName(account.name)}
                        </CardTitle>
                        <CardDescription>
                          {account.institution?.name ?? 'Sem instituição'} ·{' '}
                          {account.scope?.name}
                        </CardDescription>
                        <CardAction>
                          <Landmark className="size-5 text-primary" />
                        </CardAction>
                      </CardHeader>
                      <CardContent>
                        <strong className="font-mono text-2xl tabular-nums">
                          {formatCurrency(
                            account.balanceCents,
                            account.currency,
                          )}
                        </strong>
                        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
                          <StatusBadge
                            tone={
                              account.purpose === 'reserve'
                                ? 'info'
                                : account.purpose === 'investment'
                                  ? 'success'
                                  : 'neutral'
                            }
                          >
                            {account.purpose === 'reserve'
                              ? 'Reserva'
                              : account.purpose === 'investment'
                                ? 'Investimentos'
                                : 'Movimentação'}
                          </StatusBadge>
                          <span>{account.currency}</span>
                        </div>
                        <div className="mt-4 grid gap-2 border-t pt-4 text-xs text-muted-foreground">
                          <div className="flex items-center justify-between gap-3">
                            <span>Atualizada até</span>
                            <StatusBadge
                              tone={
                                account.coverage.freshness.status === 'current'
                                  ? 'success'
                                  : account.coverage.freshness.status ===
                                      'recommended'
                                    ? 'warning'
                                    : 'neutral'
                              }
                            >
                              {account.coverage.latestCoverageEnd
                                ? formatDate(account.coverage.latestCoverageEnd)
                                : 'Sem cobertura'}
                            </StatusBadge>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span>Saldo conferido em</span>
                            <span className="font-medium text-foreground">
                              {account.latestVerifiedCheckpoint
                                ? formatDate(
                                    account.latestVerifiedCheckpoint.asOf,
                                  )
                                : 'Ainda não'}
                            </span>
                          </div>
                          {account.unverifiedDays > 0 ? (
                            <p>
                              {account.unverifiedDays}{' '}
                              {account.unverifiedDays === 1
                                ? 'dia coberto ainda não foi conferido'
                                : 'dias cobertos ainda não foram conferidos'}{' '}
                              por dois saldos compatíveis.
                            </p>
                          ) : null}
                          {account.latestCheckpoint &&
                          account.latestCheckpoint.reviewState ===
                            'observed' ? (
                            <p>
                              Saldo registrado em{' '}
                              {formatDate(account.latestCheckpoint.asOf)}; falta
                              outro ponto compatível para reconciliar o período.
                            </p>
                          ) : null}
                          {account.coverage.gaps.length ? (
                            <div className="grid gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-warning">
                              <p className="font-medium">Período ausente</p>
                              {account.coverage.gaps.map((gap) => (
                                <p key={`${gap.start}-${gap.end}`}>
                                  Importe um extrato de {formatDate(gap.start)}{' '}
                                  a {formatDate(gap.end)}. As transações
                                  posteriores continuam válidas.
                                </p>
                              ))}
                              <Button
                                nativeButton={false}
                                variant="outline"
                                size="sm"
                                className="mt-1 w-fit"
                                render={
                                  <Link
                                    to="/importar"
                                    search={{ view: 'upload' }}
                                  />
                                }
                              >
                                Importar período ausente
                              </Button>
                            </div>
                          ) : null}
                          {account.projectedBalanceCents !==
                          account.balanceCents ? (
                            <p>
                              Saldo projetado:{' '}
                              {formatCurrency(
                                account.projectedBalanceCents,
                                account.currency,
                              )}
                              .
                            </p>
                          ) : null}
                        </div>
                        <div className="mt-4">
                          <BalanceCheckpointDialog
                            targetType="account"
                            targetId={account.id}
                            targetName={formatInstrumentName(account.name)}
                            targetCurrency={account.currency}
                          />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Panel>
                  <EmptyState
                    icon={Building2}
                    title={`Nenhuma conta em ${section.title.toLowerCase()}`}
                    description="Adicione uma conta e escolha seu tipo e finalidade."
                  />
                </Panel>
              )}
            </section>
          ))}
        </div>
      ) : (
        <Panel>
          <EmptyState
            icon={Building2}
            title="Cadastre sua primeira conta"
            description="Adicione contas PF ou PJ antes de importar extratos OFX e PDF."
          />
        </Panel>
      )}
    </div>
  )
}
