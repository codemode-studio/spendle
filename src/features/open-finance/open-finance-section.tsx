import {
  AlertCircle,
  Building2,
  CloudDownload,
  Landmark,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'
import usePluggyConnect from 'use-pluggy-connect'
import { toast } from 'sonner'

import { EmptyState, Panel, StatusBadge } from '#/components/ui'
import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect, NativeSelectOption } from '#/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import { formatCurrency, toMinorUnits } from '#/domain/currency'
import { formatLongDate } from '#/domain/period'
import {
  invalidateFinance,
  openFinanceOptions,
  configurationOptions,
} from '#/features/finance/queries'

import {
  createPluggyConnectTokenFn,
  disconnectPluggyConnectionFn,
  mapPluggyAccountFn,
  registerPluggyItemFn,
  registerPluggyWebhookFn,
  resolvePluggyCorrectionFn,
  resumePluggyConnectionFn,
  syncPluggyConnectionFn,
} from './open-finance.functions'
import { pluggyCorrectionMutationOptions } from './correction-mutation'
import type { PluggyHistoryMonths } from './history-window'
import type { getOpenFinanceSnapshot } from './open-finance.server'

type OpenFinanceAccount = Awaited<
  ReturnType<typeof getOpenFinanceSnapshot>
>['accounts'][number]

interface WidgetSession {
  connectionId: string
  accessToken: string
  updateItem?: string
}

function readableDate(value: Date | string | null) {
  if (!value) return 'Ainda não sincronizado'
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

const statusPresentation = {
  pending: { label: 'Aguardando conexão', tone: 'neutral' },
  updating: { label: 'Sincronizando', tone: 'info' },
  updated: { label: 'Atualizada', tone: 'success' },
  waiting_user_input: { label: 'Ação necessária', tone: 'warning' },
  waiting_user_action: { label: 'Autorize no banco', tone: 'warning' },
  login_error: { label: 'Reconecte', tone: 'danger' },
  outdated: { label: 'Dados desatualizados', tone: 'warning' },
  error: { label: 'Erro', tone: 'danger' },
  disconnected: { label: 'Desconectada', tone: 'neutral' },
} as const

function PluggyWidget({
  session,
  includeSandbox,
  onSuccess,
  onClose,
}: {
  session: WidgetSession
  includeSandbox: boolean
  onSuccess: (itemId: string) => Promise<void>
  onClose: () => void
}) {
  const opened = useRef(false)
  const { init, ready, error } = usePluggyConnect({
    connectToken: session.accessToken,
    updateItem: session.updateItem,
    includeSandbox,
    connectorTypes: ['PERSONAL_BANK', 'BUSINESS_BANK'],
    countries: ['BR'],
    products: ['ACCOUNTS', 'CREDIT_CARDS', 'TRANSACTIONS'],
    language: 'pt',
    allowFullscreen: true,
    onSuccess: ({ item }) => onSuccess(item.id),
    onClose,
  })

  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true
      init()
    }
  }, [init, ready])

  useEffect(() => {
    if (error) toast.error('Não foi possível abrir a conexão com a Pluggy.')
  }, [error])

  return null
}

function AccountMappingDialog({
  account,
  open,
  onOpenChange,
}: {
  account: OpenFinanceAccount | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: configuration } = useSuspenseQuery(configurationOptions())
  const mapAccount = useServerFn(mapPluggyAccountFn)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [historyMonths, setHistoryMonths] = useState<PluggyHistoryMonths>(3)
  const mutation = useMutation({
    mutationFn: mapAccount,
    onSuccess: async (result) => {
      toast.success(
        `Instrumento vinculado. Lançamentos copiados desde ${formatLongDate(result.historyStart)}.`,
      )
      onOpenChange(false)
      await invalidateFinance(queryClient, 'ledger')
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível vincular.',
      ),
  })
  if (!account) return null
  const isBank = account.type === 'BANK'
  const targets = isBank
    ? configuration.accounts.filter(
        (item) => item.currency === account.currency && item.active,
      )
    : configuration.cards.filter(
        (item) => item.currency === account.currency && item.active,
      )

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (mode === 'existing') {
      mutation.mutate({
        data: {
          providerAccountId: account!.providerAccountId,
          existingTarget: {
            type: isBank ? 'account' : 'card',
            id: String(form.get('targetId')),
          },
        },
      })
      return
    }
    mutation.mutate({
      data: {
        providerAccountId: account!.providerAccountId,
        historyMonths,
        newTarget: isBank
          ? {
              type: 'account',
              name: String(form.get('name')),
              kind: String(form.get('kind')) as 'checking' | 'savings',
              purpose: String(form.get('purpose')) as
                'operating' | 'reserve' | 'investment',
            }
          : {
              type: 'card',
              name: String(form.get('name')),
              limitCents: toMinorUnits(
                String(form.get('limit')) || '0',
                account!.currency,
              ),
              closingDay: Number(form.get('closingDay')),
              dueDay: Number(form.get('dueDay')) || undefined,
            },
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Vincular {account.name}</DialogTitle>
            <DialogDescription>
              Confirme o destino. O Spendle não associa contas por nome, titular
              ou número.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="mapping-mode">
                Como deseja vincular?
              </FieldLabel>
              <NativeSelect
                id="mapping-mode"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as 'existing' | 'new')
                }
              >
                <NativeSelectOption value="existing">
                  Usar instrumento existente
                </NativeSelectOption>
                <NativeSelectOption value="new">
                  Criar novo instrumento
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            {mode === 'existing' ? (
              <Field>
                <FieldLabel htmlFor="mapping-target">Destino</FieldLabel>
                <NativeSelect id="mapping-target" name="targetId" required>
                  <NativeSelectOption value="">Selecione</NativeSelectOption>
                  {targets.map((target) => (
                    <NativeSelectOption key={target.id} value={target.id}>
                      {target.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="mapping-name">Nome</FieldLabel>
                  <Input
                    id="mapping-name"
                    name="name"
                    defaultValue={account.name}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel id="mapping-history">Copiar histórico</FieldLabel>
                  <ToggleGroup
                    aria-labelledby="mapping-history"
                    value={[String(historyMonths)]}
                    onValueChange={(values) => {
                      const value = Number(values.at(0))
                      if (value === 3 || value === 6) setHistoryMonths(value)
                    }}
                    variant="outline"
                  >
                    <ToggleGroupItem value="3">3 meses</ToggleGroupItem>
                    <ToggleGroupItem value="6">6 meses</ToggleGroupItem>
                  </ToggleGroup>
                  {historyMonths === 6 ? (
                    <FieldDescription>
                      <AlertCircle
                        aria-hidden
                        className="mr-1 inline size-3.5 align-[-2px]"
                      />
                      Meses antigos podem ter categorias e orçamentos
                      incompletos.
                    </FieldDescription>
                  ) : null}
                </Field>
                {isBank ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="mapping-kind">Tipo</FieldLabel>
                      <NativeSelect
                        id="mapping-kind"
                        name="kind"
                        defaultValue={
                          account.subtype === 'SAVINGS_ACCOUNT'
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
                      </NativeSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mapping-purpose">
                        Finalidade
                      </FieldLabel>
                      <NativeSelect
                        id="mapping-purpose"
                        name="purpose"
                        defaultValue="operating"
                      >
                        <NativeSelectOption value="operating">
                          Uso cotidiano
                        </NativeSelectOption>
                        <NativeSelectOption value="reserve">
                          Reserva
                        </NativeSelectOption>
                        <NativeSelectOption value="investment">
                          Investimentos
                        </NativeSelectOption>
                      </NativeSelect>
                    </Field>
                  </>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor="mapping-limit">Limite</FieldLabel>
                      <Input
                        id="mapping-limit"
                        name="limit"
                        inputMode="decimal"
                        defaultValue={
                          account.observedCreditLimitCents
                            ? account.observedCreditLimitCents / 100
                            : 0
                        }
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mapping-closing">
                        Fecha dia
                      </FieldLabel>
                      <Input
                        id="mapping-closing"
                        name="closingDay"
                        type="number"
                        min="1"
                        max="31"
                        defaultValue={
                          account.observedClosingDate
                            ? Number(account.observedClosingDate.slice(-2))
                            : 1
                        }
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mapping-due">Vence dia</FieldLabel>
                      <Input
                        id="mapping-due"
                        name="dueDay"
                        type="number"
                        min="1"
                        max="31"
                        defaultValue={
                          account.observedDueDate
                            ? Number(account.observedDueDate.slice(-2))
                            : undefined
                        }
                      />
                    </Field>
                  </div>
                )}
              </>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button type="submit" disabled={mutation.isPending}>
              <Link2 data-icon="inline-start" />
              {mutation.isPending ? 'Vinculando…' : 'Vincular'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function OpenFinanceSection() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(openFinanceOptions())
  const { data: configuration } = useSuspenseQuery(configurationOptions())
  const createToken = useServerFn(createPluggyConnectTokenFn)
  const registerItem = useServerFn(registerPluggyItemFn)
  const syncConnection = useServerFn(syncPluggyConnectionFn)
  const resumeConnection = useServerFn(resumePluggyConnectionFn)
  const disconnectConnection = useServerFn(disconnectPluggyConnectionFn)
  const registerWebhook = useServerFn(registerPluggyWebhookFn)
  const resolveCorrection = useServerFn(resolvePluggyCorrectionFn)
  const [scopeId, setScopeId] = useState(configuration.scopes[0]?.id ?? '')
  const [widget, setWidget] = useState<WidgetSession | null>(null)
  const [mappingAccount, setMappingAccount] =
    useState<OpenFinanceAccount | null>(null)
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null)
  const [disconnectConfirmation, setDisconnectConfirmation] = useState('')
  const invalidate = () => invalidateFinance(queryClient, 'ledger')

  const tokenMutation = useMutation({
    mutationFn: createToken,
    onSuccess: (session, variables) =>
      setWidget({
        ...session,
        updateItem: variables.data.connectionId
          ? (data.connections.find(
              (connection) => connection.id === variables.data.connectionId,
            )?.providerItemId ?? undefined)
          : undefined,
      }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível conectar.',
      ),
  })
  const itemMutation = useMutation({
    mutationFn: registerItem,
    onSuccess: async () => {
      setWidget(null)
      toast.success(
        'Instituição conectada. Agora vincule as contas encontradas.',
      )
      await invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Não foi possível confirmar o Item.',
      ),
  })
  const syncMutation = useMutation({
    mutationFn: syncConnection,
    onSuccess: async () => {
      toast.success('Dados disponíveis copiados da Pluggy.')
      await invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Falha ao copiar dados.',
      ),
  })
  const resumeMutation = useMutation({
    mutationFn: resumeConnection,
    onSuccess: async () => {
      toast.success('Cópia Open Finance retomada.')
      await invalidate()
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Falha ao retomar.'),
  })
  const disconnectMutation = useMutation({
    mutationFn: disconnectConnection,
    onSuccess: async () => {
      setDisconnectingId(null)
      setDisconnectConfirmation('')
      toast.success('Item apagado na Pluggy e conexão encerrada.')
      await invalidate()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Falha ao desconectar.',
      ),
  })
  const webhookMutation = useMutation({
    mutationFn: registerWebhook,
    onSuccess: () => toast.success('Webhook da Pluggy registrado.'),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Falha no webhook.'),
  })
  const correctionMutation = useMutation(
    pluggyCorrectionMutationOptions(queryClient, resolveCorrection),
  )

  if (!data.configuration.enabled) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Open Finance ainda não configurado</AlertTitle>
        <AlertDescription>
          Defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no ambiente do
          servidor. Para sincronização automática, configure também
          PLUGGY_WEBHOOK_URL e PLUGGY_WEBHOOK_SECRET.
        </AlertDescription>
      </Alert>
    )
  }

  const unlinked = data.accounts.filter(
    (account) => !account.accountId && !account.creditCardId,
  )

  return (
    <div className="flex flex-col gap-4">
      {widget && (
        <PluggyWidget
          session={widget}
          includeSandbox={data.configuration.includeSandbox}
          onClose={() => setWidget(null)}
          onSuccess={async (itemId) => {
            await itemMutation.mutateAsync({
              data: { connectionId: widget.connectionId, itemId },
            })
          }}
        />
      )}
      <Panel
        title="Instituições conectadas"
        description="A Pluggy fornece observações. O status Conferido até continua dependendo de um saldo que feche com diferença zero."
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            <NativeSelect
              aria-label="Proprietário da nova conexão"
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
            >
              {configuration.scopes.map((scope) => (
                <NativeSelectOption key={scope.id} value={scope.id}>
                  {scope.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              type="button"
              onClick={() =>
                tokenMutation.mutate({ data: { ownershipScopeId: scopeId } })
              }
              disabled={!scopeId || tokenMutation.isPending}
            >
              <Landmark data-icon="inline-start" />
              Conectar instituição
            </Button>
          </div>
        }
      >
        {data.connections.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.connections.map((connection) => {
              const status = statusPresentation[connection.status]
              return (
                <div
                  key={connection.id}
                  className="flex flex-col gap-3 rounded-lg border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Building2 className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <strong className="block truncate text-sm">
                          {connection.connectorName ?? 'Nova conexão'}
                        </strong>
                        <span className="block text-xs text-muted-foreground">
                          Última cópia: {readableDate(connection.lastSyncedAt)}
                        </span>
                      </div>
                    </div>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </div>
                  {connection.nextSyncAt && (
                    <span className="text-xs text-muted-foreground">
                      Próximo sync da Pluggy:{' '}
                      {readableDate(connection.nextSyncAt)}
                    </span>
                  )}
                  {connection.errorMessage && (
                    <span className="text-sm text-destructive">
                      {connection.errorMessage}
                    </span>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {connection.paused &&
                    connection.status !== 'disconnected' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          resumeMutation.mutate({
                            data: { connectionId: connection.id },
                          })
                        }
                      >
                        <RefreshCw data-icon="inline-start" />
                        Retomar cópia
                      </Button>
                    ) : connection.status !== 'disconnected' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          syncMutation.mutate({
                            data: { connectionId: connection.id },
                          })
                        }
                      >
                        <CloudDownload data-icon="inline-start" />
                        Buscar dados disponíveis
                      </Button>
                    ) : null}
                    {connection.providerItemId &&
                      connection.status !== 'disconnected' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            tokenMutation.mutate({
                              data: {
                                ownershipScopeId: connection.ownershipScopeId,
                                connectionId: connection.id,
                              },
                            })
                          }
                        >
                          <RefreshCw data-icon="inline-start" />
                          Reconectar
                        </Button>
                      )}
                    {connection.status !== 'disconnected' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setDisconnectingId(connection.id)}
                      >
                        <Unplug data-icon="inline-start" />
                        Desconectar
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={Landmark}
            title="Nenhuma instituição conectada"
            description="Escolha o proprietário e abra o ambiente seguro da Pluggy para começar."
          />
        )}
      </Panel>

      {data.configuration.automaticSync && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>Sincronização automática disponível</AlertTitle>
          <AlertDescription>
            O worker precisa estar ativo para processar a caixa de entrada.
          </AlertDescription>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => webhookMutation.mutate({})}
            disabled={webhookMutation.isPending}
          >
            Registrar webhook
          </Button>
        </Alert>
      )}

      {unlinked.length > 0 && (
        <Panel
          title="Contas aguardando vínculo"
          description="Confirme cada destino antes de copiar movimentos para o razão."
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {unlinked.map((account) => (
              <div
                key={account.id}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <strong className="block text-sm">{account.name}</strong>
                  <span className="text-xs text-muted-foreground">
                    {account.type === 'BANK' ? 'Conta bancária' : 'Cartão'} ·{' '}
                    {account.currency}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setMappingAccount(account)}
                >
                  <Link2 data-icon="inline-start" />
                  Vincular
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {data.accounts.some(
        (account) => account.accountId || account.creditCardId,
      ) && (
        <Panel
          title="Saldos informados pela Pluggy"
          description="São observações do último sync. Não alteram o marco Conferido até."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.accounts
              .filter((account) => account.accountId || account.creditCardId)
              .map((account) => (
                <div key={account.id} className="rounded-lg border p-3">
                  <span className="block truncate text-sm font-medium">
                    {account.localName ?? account.name}
                  </span>
                  <strong className="mt-1 block text-lg tabular-nums">
                    {formatCurrency(
                      account.type === 'BANK'
                        ? (account.observedAvailableBalanceCents ??
                            account.observedBalanceCents ??
                            0)
                        : (account.observedBalanceCents ?? 0),
                      account.currency,
                    )}
                  </strong>
                  <span className="block text-xs text-muted-foreground">
                    Informado pela Pluggy · {readableDate(account.observedAt)}
                  </span>
                  {account.type === 'CREDIT' &&
                    account.observedCreditLimitCents !== null && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Limite observado:{' '}
                        {formatCurrency(
                          account.observedCreditLimitCents,
                          account.currency,
                        )}
                      </span>
                    )}
                </div>
              ))}
          </div>
        </Panel>
      )}

      {data.corrections.length > 0 && (
        <Panel
          title="Correções pendentes"
          description="A Pluggy reenviou fatos diferentes. O lançamento atual só muda após sua decisão."
        >
          <div className="flex flex-col gap-3">
            {data.corrections.map((correction) => (
              <div
                key={correction.id}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <strong className="block text-sm">
                    {correction.description}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    Proposto para {correction.postedAt} ·{' '}
                    {formatCurrency(
                      correction.amountCents ?? 0,
                      correction.currency ?? 'BRL',
                    )}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      correctionMutation.mutate({
                        data: {
                          observationId: correction.id,
                          action: 'reject',
                        },
                      })
                    }
                  >
                    Manter atual
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      correctionMutation.mutate({
                        data: {
                          observationId: correction.id,
                          action: 'accept',
                        },
                      })
                    }
                  >
                    Aceitar correção
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <AccountMappingDialog
        account={mappingAccount}
        open={Boolean(mappingAccount)}
        onOpenChange={(open) => {
          if (!open) setMappingAccount(null)
        }}
      />
      <Dialog
        open={Boolean(disconnectingId)}
        onOpenChange={(open) => {
          if (!open) {
            setDisconnectingId(null)
            setDisconnectConfirmation('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Desconectar instituição?</DialogTitle>
            <DialogDescription>
              O Item será apagado primeiro na Pluggy. O histórico local
              continuará disponível para auditoria. Digite DESCONECTAR para
              confirmar.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="disconnect-confirmation">
                Confirmação
              </FieldLabel>
              <Input
                id="disconnect-confirmation"
                value={disconnectConfirmation}
                onChange={(event) =>
                  setDisconnectConfirmation(event.target.value)
                }
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={
                disconnectConfirmation !== 'DESCONECTAR' ||
                disconnectMutation.isPending
              }
              onClick={() =>
                disconnectMutation.mutate({
                  data: {
                    connectionId: disconnectingId!,
                    confirmation: disconnectConfirmation,
                  },
                })
              }
            >
              <Unplug data-icon="inline-start" />
              Desconectar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
