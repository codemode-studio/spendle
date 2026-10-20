import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CreditCard,
  Landmark,
  Link2,
  Plug,
  PlugZap,
  RefreshCw,
  Trash2,
  Unlink,
  Unplug,
} from 'lucide-react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'

import { EmptyState, Panel, PageHeader, StatusBadge } from '#/components/ui'
import { SegmentedControl } from '#/components/segmented-control'
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { Skeleton } from '#/components/ui/skeleton'
import { Spinner } from '#/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { toMinorUnits } from '#/lib/currency'
import { formatInstrumentName } from '#/lib/finance'
import { formatLongDate } from '#/lib/period'
import { isCard } from '#/features/data/accounts'
import type { AccountView } from '#/features/data/accounts'
import {
  createConnectTokenFn,
  disconnectFn,
  linkProviderAccountFn,
  reconnectTokenFn,
  refreshConnectionFn,
  registerItemFn,
  syncConnectionFn,
  unlinkProviderAccountFn,
} from '#/features/data/open-finance.functions'
import { openPluggyConnect } from '#/features/data/pluggy-connect'
import type { PluggyConnectCallbacks } from '#/features/data/pluggy-connect'
import {
  accountsOptions,
  connectSettingsOptions,
  connectionsOptions,
  invalidateAfterReactors,
  ownersOptions,
  providerAccountsOptions,
} from '#/features/data/queries'
import { errorMessage } from '#/lib/api/errors'
import { cn } from '#/lib/utils'

import type { Connection, ProviderAccount } from '@spendle/server/api'

/** After a sync is accepted, reads refresh as the first pages arrive. */
const syncRefreshDelays = [1_500, 5_000, 12_000]

const statusCopy: Record<
  Connection['status'],
  {
    label: string
    tone: 'success' | 'warning' | 'neutral' | 'info'
    icon: typeof CircleCheck
  }
> = {
  active: { label: 'Conectada', tone: 'success', icon: CircleCheck },
  pending: {
    label: 'Aguardando autorização',
    tone: 'info',
    icon: CircleDashed,
  },
  attention: {
    label: 'Precisa reconectar',
    tone: 'warning',
    icon: CircleAlert,
  },
  disconnected: { label: 'Desconectada', tone: 'neutral', icon: Unplug },
}

type WidgetRequest = {
  connectToken: string
  updateItem?: string
} & PluggyConnectCallbacks

export function OpenFinanceSection() {
  const { data: connections } = useSuspenseQuery(connectionsOptions())
  const { data: owners } = useSuspenseQuery(ownersOptions())
  const { data: settings } = useSuspenseQuery(connectSettingsOptions())
  const queryClient = useQueryClient()
  const createConnectToken = useServerFn(createConnectTokenFn)
  const registerItem = useServerFn(registerItemFn)
  const [ownerId, setOwnerId] = useState(owners[0]?.id ?? '')
  const [simulated, setSimulated] = useState<WidgetRequest | null>(null)
  const [linking, setLinking] = useState<ProviderAccount | null>(null)
  const [opening, setOpening] = useState(false)

  /** The widget, or the local simulation when the server runs a fake Pluggy. */
  async function openWidget(request: WidgetRequest) {
    if (settings.mode === 'simulated') {
      setSimulated(request)
      return
    }
    setOpening(true)
    try {
      await openPluggyConnect(request)
    } catch (error) {
      toast.error(errorMessage(error, 'Não foi possível abrir a Pluggy.'))
    } finally {
      setOpening(false)
    }
  }

  const registerMutation = useMutation({
    mutationFn: registerItem,
    onSuccess: async (accounts) => {
      await invalidateAfterReactors(queryClient)
      const next = accounts.find((account) => account.accountId === null)
      toast.success(
        next
          ? `${accounts.length} ${accounts.length === 1 ? 'conta encontrada' : 'contas encontradas'}. Vincule cada uma para copiar o histórico.`
          : 'Conexão atualizada.',
      )
      if (next) setLinking(next)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível registrar a conexão.')),
  })

  const connectMutation = useMutation({
    mutationFn: createConnectToken,
    onSuccess: async ({ connectionId, accessToken }) => {
      void invalidateAfterReactors(queryClient, 'ledger', [])
      await openWidget({
        connectToken: accessToken,
        onSuccess: (itemId) =>
          registerMutation.mutate({ data: { connectionId, itemId } }),
        onError: (message) => toast.error(message),
        onClose: () =>
          toast.info(
            'Conexão não concluída. Continue quando quiser pelo botão Conectar banco.',
          ),
      })
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível iniciar a conexão.')),
  })

  const live = connections.filter(
    (connection) => connection.status !== 'disconnected',
  )
  const disconnected = connections.filter(
    (connection) => connection.status === 'disconnected',
  )
  const connecting =
    connectMutation.isPending || registerMutation.isPending || opening

  return (
    <>
      <PageHeader
        title="Open Finance"
        description="Conecte bancos e cartões pela Pluggy para sincronizar lançamentos e saldos."
        actions={
          owners.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {owners.length > 1 ? (
                <NativeSelect
                  aria-label="Titular da conexão"
                  value={ownerId}
                  onChange={(event) => setOwnerId(event.target.value)}
                >
                  {owners.map((owner) => (
                    <NativeSelectOption key={owner.id} value={owner.id}>
                      {owner.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              <Button
                type="button"
                disabled={connecting || !ownerId}
                onClick={() => connectMutation.mutate({ data: { ownerId } })}
              >
                {connecting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlugZap data-icon="inline-start" />
                )}
                Conectar banco
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="grid gap-6">
        {!owners.length ? (
          <Panel>
            <EmptyState
              icon={Plug}
              title="Adicione um titular primeiro"
              description="Cada conexão pertence a uma pessoa, família ou empresa."
              action={
                <Button
                  nativeButton={false}
                  render={
                    <Link to="/configuracoes" search={{ tab: 'geral' }} />
                  }
                >
                  Adicionar titular
                </Button>
              }
            />
          </Panel>
        ) : live.length ? (
          <div className="grid gap-4">
            {live.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                onLink={setLinking}
                onOpenWidget={openWidget}
                onRegistered={(itemId) =>
                  registerMutation.mutate({
                    data: { connectionId: connection.id, itemId },
                  })
                }
              />
            ))}
          </div>
        ) : (
          <Panel>
            <EmptyState
              icon={Plug}
              title="Nenhum banco conectado"
              description="Use Conectar banco e autorize o acesso na Pluggy. Você escolhe quais contas copiar."
            />
          </Panel>
        )}

        {disconnected.length > 0 && (
          <Panel title="Desconectadas">
            <ul className="divide-y rounded-lg border text-sm">
              {disconnected.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="truncate">
                    {connection.connectorName ?? 'Conexão sem banco'}
                  </span>
                  <StatusBadge>
                    {connection.lastSyncedAt
                      ? `Última sincronização ${formatLongDate(connection.lastSyncedAt.slice(0, 10))}`
                      : 'Nunca sincronizada'}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <LinkAccountDialog
          providerAccount={linking}
          onClose={() => setLinking(null)}
          onLinked={async (connectionId) => {
            setLinking(null)
            const remaining = await queryClient.fetchQuery({
              ...providerAccountsOptions(connectionId),
              staleTime: 0,
            })
            const next = remaining.find((account) => account.accountId === null)
            if (next) setLinking(next)
          }}
        />

        <SimulatedConnectDialog
          request={simulated}
          onDone={() => setSimulated(null)}
        />
      </div>
    </>
  )
}

function ConnectionCard({
  connection,
  onLink,
  onOpenWidget,
  onRegistered,
}: {
  connection: Connection
  onLink: (account: ProviderAccount) => void
  onOpenWidget: (request: WidgetRequest) => Promise<void>
  onRegistered: (itemId: string) => void
}) {
  const queryClient = useQueryClient()
  const providerAccounts = useQuery({
    ...providerAccountsOptions(connection.id),
    enabled: connection.itemId !== null,
  })
  const { data: accounts } = useQuery(accountsOptions(true))
  const sync = useServerFn(syncConnectionFn)
  const refresh = useServerFn(refreshConnectionFn)
  const disconnect = useServerFn(disconnectFn)
  const reconnectToken = useServerFn(reconnectTokenFn)
  const unlink = useServerFn(unlinkProviderAccountFn)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  // A request that never reached a bank is removed, not kept as history.
  const unfinished = connection.itemId === null
  const status = statusCopy[connection.status]
  const accountName = new Map(
    (accounts ?? []).map((account) => [account.id, account.name]),
  )
  const linked = (providerAccounts.data ?? []).filter(
    (account) => account.accountId !== null,
  )

  const syncMutation = useMutation({
    mutationFn: sync,
    onSuccess: () => {
      toast.success(
        'Sincronização pedida. Os lançamentos aparecem em instantes.',
      )
      void invalidateAfterReactors(queryClient, 'ledger', syncRefreshDelays)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível sincronizar.')),
  })
  const refreshMutation = useMutation({
    mutationFn: refresh,
    onSuccess: (updated) => {
      toast.success(`Status: ${statusCopy[updated.status].label}.`)
      void invalidateAfterReactors(queryClient, 'ledger', [])
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível consultar a Pluggy.')),
  })
  const disconnectMutation = useMutation({
    mutationFn: disconnect,
    onSuccess: () => {
      setConfirmDisconnect(false)
      toast.success(
        unfinished
          ? 'Pedido de conexão removido.'
          : 'Banco desconectado. Os lançamentos já copiados continuam no histórico.',
      )
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível desconectar.')),
  })
  const reconnectMutation = useMutation({
    mutationFn: reconnectToken,
    onSuccess: ({ accessToken }) =>
      onOpenWidget({
        connectToken: accessToken,
        updateItem: connection.itemId ?? undefined,
        onSuccess: (itemId) => onRegistered(itemId),
        onError: (message) => toast.error(message),
        onClose: () => toast.info('Reconexão não concluída.'),
      }),
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível reconectar.')),
  })
  const unlinkMutation = useMutation({
    mutationFn: unlink,
    onSuccess: () => {
      toast.success(
        'Conta desvinculada. O histórico copiado continua na conta.',
      )
      void invalidateAfterReactors(queryClient)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível desvincular.')),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{connection.connectorName ?? 'Nova conexão'}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge tone={status.tone}>
            <status.icon />
            {status.label}
          </StatusBadge>
          <span>
            {connection.lastSyncedAt
              ? `Sincronizada em ${formatDateTime(connection.lastSyncedAt)}`
              : 'Ainda não sincronizada'}
          </span>
        </CardDescription>
        <CardAction className="flex items-center gap-0.5">
          <IconAction
            label="Consultar status na Pluggy"
            disabled={refreshMutation.isPending || connection.itemId === null}
            onClick={() =>
              refreshMutation.mutate({ data: { connectionId: connection.id } })
            }
          >
            {refreshMutation.isPending ? <Spinner /> : <CircleDashed />}
          </IconAction>
          <IconAction
            label={
              unfinished ? 'Remover pedido de conexão' : 'Desconectar banco'
            }
            onClick={() => setConfirmDisconnect(true)}
          >
            {unfinished ? <Trash2 /> : <Unplug />}
          </IconAction>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connection.status === 'attention' ? (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              A Pluggy precisa de uma nova autorização para continuar
              sincronizando
              {connection.errorCode ? ` (${connection.errorCode})` : ''}.
            </p>
            <Button
              size="sm"
              disabled={reconnectMutation.isPending}
              onClick={() =>
                reconnectMutation.mutate({
                  data: { connectionId: connection.id },
                })
              }
            >
              <PlugZap data-icon="inline-start" />
              Reconectar
            </Button>
          </div>
        ) : null}
        {connection.status === 'pending' && connection.itemId === null ? (
          <p className="text-sm text-muted-foreground">
            A autorização na Pluggy não foi concluída. Use Conectar banco para
            tentar de novo, ou remova este pedido.
          </p>
        ) : null}

        {providerAccounts.isPending && connection.itemId !== null ? (
          <Skeleton className="h-16" />
        ) : providerAccounts.isError ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              {errorMessage(
                providerAccounts.error,
                'Não foi possível listar as contas.',
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void providerAccounts.refetch()}
            >
              Tentar de novo
            </Button>
          </div>
        ) : providerAccounts.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {providerAccounts.data.map((account) => (
              <li
                key={account.providerAccountId}
                className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {account.type === 'CREDIT' ? (
                    <CreditCard className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Landmark className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {account.name}
                      {account.lastFour ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · final {account.lastFour}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {account.accountId
                        ? `→ ${formatInstrumentName(accountName.get(account.accountId) ?? 'Conta')}${account.historyFrom ? ` · desde ${formatLongDate(account.historyFrom)}` : ''}`
                        : 'Não vinculada: nada é copiado'}
                    </span>
                  </div>
                </div>
                {account.accountId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={unlinkMutation.isPending}
                    onClick={() =>
                      unlinkMutation.mutate({
                        data: { providerAccountId: account.providerAccountId },
                      })
                    }
                  >
                    <Unlink data-icon="inline-start" />
                    Desvincular
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={connection.status === 'disconnected'}
                    onClick={() => onLink(account)}
                  >
                    <Link2 data-icon="inline-start" />
                    Vincular
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : connection.itemId !== null ? (
          <p className="text-sm text-muted-foreground">
            A Pluggy ainda não listou contas desta conexão.
          </p>
        ) : null}

        {linked.length > 0 ? (
          <div className="flex justify-end">
            <Button
              variant="outline"
              disabled={
                syncMutation.isPending || connection.status !== 'active'
              }
              onClick={() =>
                syncMutation.mutate({ data: { connectionId: connection.id } })
              }
            >
              <RefreshCw
                data-icon="inline-start"
                className={cn(syncMutation.isPending && 'animate-spin')}
              />
              Sincronizar agora
            </Button>
          </div>
        ) : null}
      </CardContent>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {unfinished
                ? 'Remover este pedido de conexão?'
                : `Desconectar ${connection.connectorName ?? 'este banco'}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {unfinished
                ? 'Ele não chegou a um banco: nada foi copiado e nada fica no histórico.'
                : 'A sincronização para e a autorização na Pluggy é removida. Os lançamentos já copiados continuam no histórico.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={disconnectMutation.isPending}
              onClick={() =>
                disconnectMutation.mutate({
                  data: { connectionId: connection.id },
                })
              }
            >
              {unfinished ? (
                <Trash2 data-icon="inline-start" />
              ) : (
                <Unplug data-icon="inline-start" />
              )}
              {unfinished
                ? disconnectMutation.isPending
                  ? 'Removendo…'
                  : 'Remover'
                : disconnectMutation.isPending
                  ? 'Desconectando…'
                  : 'Desconectar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function IconAction({
  label,
  children,
  ...props
}: {
  label: string
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof Button>, 'children'>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
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

/** Links a provider account to a new or existing ledger account, with 3 or 6 months of history. */
function LinkAccountDialog({
  providerAccount,
  onClose,
  onLinked,
}: {
  providerAccount: ProviderAccount | null
  onClose: () => void
  onLinked: (connectionId: string) => void
}) {
  const queryClient = useQueryClient()
  const { data: accounts } = useQuery(accountsOptions(false))
  const link = useServerFn(linkProviderAccountFn)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [historyMonths, setHistoryMonths] = useState<3 | 6>(3)
  const [error, setError] = useState('')
  const credit = providerAccount?.type === 'CREDIT'
  const compatible = (accounts ?? []).filter(
    (account: AccountView) =>
      account.link === null &&
      isCard(account) === credit &&
      account.currency === providerAccount?.currency,
  )
  const mutation = useMutation({
    mutationFn: link,
    onSuccess: (account) => {
      toast.success(
        `${account.name} vinculada. Copiando ${historyMonths} meses de histórico.`,
      )
      void invalidateAfterReactors(queryClient, 'ledger', syncRefreshDelays)
      if (providerAccount) onLinked(providerAccount.connectionId)
    },
    onError: (reason) =>
      setError(errorMessage(reason, 'Não foi possível vincular.')),
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!providerAccount) return
    setError('')
    const form = new FormData(event.currentTarget)
    if (mode === 'existing') {
      mutation.mutate({
        data: {
          providerAccountId: providerAccount.providerAccountId,
          historyMonths,
          target: { accountId: String(form.get('accountId')) },
        },
      })
      return
    }
    const kind = credit
      ? ('credit_card' as const)
      : (String(form.get('kind')) as 'checking' | 'savings' | 'investment')
    const limit = String(form.get('limit') ?? '').trim()
    mutation.mutate({
      data: {
        providerAccountId: providerAccount.providerAccountId,
        historyMonths,
        target: {
          name: String(form.get('name')).trim() || undefined,
          kind,
          purpose: kind === 'investment' ? 'investment' : 'operating',
          card: credit
            ? {
                closingDay: Number(form.get('closingDay')),
                dueDay: Number(form.get('dueDay')),
                limitCents: limit
                  ? toMinorUnits(limit, providerAccount.currency)
                  : null,
                lastFour: providerAccount.lastFour,
              }
            : undefined,
        },
      },
    })
  }

  return (
    <Dialog
      open={providerAccount !== null}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          setError('')
          onClose()
        }
      }}
    >
      {providerAccount ? (
        <DialogContent className="sm:max-w-lg">
          <form
            key={providerAccount.providerAccountId}
            onSubmit={submit}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Vincular {providerAccount.name}</DialogTitle>
              <DialogDescription>
                Os lançamentos desta conta do banco passam a alimentar a conta
                escolhida.
              </DialogDescription>
            </DialogHeader>
            <SegmentedControl
              aria-label="Destino"
              value={mode}
              onValueChange={(value) => setMode(value as 'new' | 'existing')}
              items={[
                { value: 'new', label: 'Nova conta' },
                ...(compatible.length
                  ? [{ value: 'existing', label: 'Conta existente' }]
                  : []),
              ]}
            />
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              {mode === 'existing' && compatible.length ? (
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="link-account">Conta</FieldLabel>
                  <NativeSelect
                    id="link-account"
                    name="accountId"
                    className="w-full"
                  >
                    {compatible.map((account) => (
                      <NativeSelectOption key={account.id} value={account.id}>
                        {formatInstrumentName(account.name)} ·{' '}
                        {account.institutionName}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : (
                <>
                  <Field className={cn(credit && 'sm:col-span-2')}>
                    <FieldLabel htmlFor="link-name">Nome</FieldLabel>
                    <Input
                      id="link-name"
                      name="name"
                      defaultValue={providerAccount.name}
                      required
                    />
                  </Field>
                  {credit ? (
                    <>
                      <Field>
                        <FieldLabel htmlFor="link-closing">
                          Dia de fechamento
                        </FieldLabel>
                        <Input
                          id="link-closing"
                          name="closingDay"
                          type="number"
                          min="1"
                          max="31"
                          required
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="link-due">
                          Dia de vencimento
                        </FieldLabel>
                        <Input
                          id="link-due"
                          name="dueDay"
                          type="number"
                          min="1"
                          max="31"
                          required
                        />
                      </Field>
                      <Field className="sm:col-span-2">
                        <FieldLabel htmlFor="link-limit">Limite</FieldLabel>
                        <Input
                          id="link-limit"
                          name="limit"
                          inputMode="decimal"
                          placeholder="Opcional"
                        />
                      </Field>
                    </>
                  ) : (
                    <Field>
                      <FieldLabel htmlFor="link-kind">Tipo</FieldLabel>
                      <NativeSelect
                        id="link-kind"
                        name="kind"
                        className="w-full"
                        defaultValue={
                          providerAccount.subtype === 'SAVINGS_ACCOUNT'
                            ? 'savings'
                            : 'checking'
                        }
                      >
                        <NativeSelectOption value="checking">
                          Conta corrente
                        </NativeSelectOption>
                        <NativeSelectOption value="savings">
                          Poupança
                        </NativeSelectOption>
                        <NativeSelectOption value="investment">
                          Corretora
                        </NativeSelectOption>
                      </NativeSelect>
                    </Field>
                  )}
                </>
              )}
              <Field className="sm:col-span-2">
                <FieldLabel>Histórico a copiar</FieldLabel>
                <SegmentedControl
                  aria-label="Histórico a copiar"
                  value={String(historyMonths)}
                  onValueChange={(value) =>
                    setHistoryMonths(value === '6' ? 6 : 3)
                  }
                  items={[
                    { value: '3', label: '3 meses' },
                    { value: '6', label: '6 meses' },
                  ]}
                />
                <FieldDescription>
                  Só na primeira sincronização; depois, apenas o que é novo.
                </FieldDescription>
              </Field>
            </FieldGroup>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Agora não
              </DialogClose>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Link2 data-icon="inline-start" />
                )}
                Vincular e sincronizar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

/**
 * Stands in for the Pluggy widget when the server runs the fake Pluggy (QA).
 * It reports an item id exactly as the widget's `onSuccess` would.
 */
function SimulatedConnectDialog({
  request,
  onDone,
}: {
  request: WidgetRequest | null
  onDone: () => void
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && request) {
          request.onClose()
          onDone()
        }
      }}
    >
      {request ? (
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              const itemId = String(
                new FormData(event.currentTarget).get('itemId'),
              )
              onDone()
              request.onSuccess(itemId)
            }}
          >
            <DialogHeader>
              <DialogTitle>Pluggy simulada</DialogTitle>
              <DialogDescription>
                Ambiente de teste: nenhuma credencial é pedida e nenhum banco
                real é acessado.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="simulated-item">Item retornado</FieldLabel>
              <Input
                id="simulated-item"
                name="itemId"
                defaultValue={request.updateItem ?? 'qa-item-1'}
                required
              />
            </Field>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit">
                <CircleCheck data-icon="inline-start" />
                Autorizar acesso
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}
