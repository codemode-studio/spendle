import {
  AlertTriangle,
  Building2,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Page, PageHeader, Panel, StatusBadge } from '#/components/ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
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
import { Switch } from '#/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { AccountsSection } from '#/features/finance/accounts-section'
import { CardsSection } from '#/features/finance/cards-section'
import {
  clearTransactionDataFn,
  createOwnershipScopeFn,
  updateSettingsFn,
} from '#/features/finance/finance.functions'
import {
  financeSnapshotOptions,
  invalidateFinance,
} from '#/features/finance/queries'

const settingsTabs = ['geral', 'contas', 'cartoes'] as const
type SettingsTab = (typeof settingsTabs)[number]

const settingsSearchSchema = z.object({
  tab: z.enum(settingsTabs).optional().catch(undefined),
})

export const Route = createFileRoute('/configuracoes')({
  validateSearch: settingsSearchSchema,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(financeSnapshotOptions()),
  component: SettingsPage,
})

function SettingsPage() {
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const activeTab: SettingsTab = tab ?? 'geral'

  return (
    <Page>
      <PageHeader
        eyebrow="Preferências locais"
        title="Configurações"
        description="Família, contas, cartões e dados guardados neste computador."
      />
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          void navigate({
            search: {
              tab: value === 'geral' ? undefined : (value as SettingsTab),
            },
          })
        }
        className="gap-6"
      >
        <TabsList
          variant="line"
          aria-label="Áreas das configurações"
          className="h-9 w-full justify-start overflow-x-auto overflow-y-hidden border-b px-0 pb-1"
        >
          <TabsTrigger value="geral" className="min-w-28 flex-none px-4">
            Geral
          </TabsTrigger>
          <TabsTrigger value="contas" className="min-w-28 flex-none px-4">
            Contas
          </TabsTrigger>
          <TabsTrigger value="cartoes" className="min-w-28 flex-none px-4">
            Cartões
          </TabsTrigger>
        </TabsList>
        <TabsContent value="geral">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="contas">
          <AccountsSection />
        </TabsContent>
        <TabsContent value="cartoes">
          <CardsSection />
        </TabsContent>
      </Tabs>
    </Page>
  )
}

function GeneralSettings() {
  const { data } = useSuspenseQuery(financeSnapshotOptions())
  const queryClient = useQueryClient()
  const createScope = useServerFn(createOwnershipScopeFn)
  const updateSettings = useServerFn(updateSettingsFn)
  const clearTransactionData = useServerFn(clearTransactionDataFn)
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearConfirmation, setClearConfirmation] = useState('')

  const scopeMutation = useMutation({
    mutationFn: createScope,
    onSuccess: () => {
      toast.success('Pessoa ou empresa adicionada.')
      setScopeDialogOpen(false)
      void invalidateFinance(queryClient, 'ownershipScope')
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível adicionar.',
      ),
  })
  const settingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      toast.success('Preferências de IA salvas.')
      void invalidateFinance(queryClient, 'aiConsent')
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível salvar.',
      ),
  })
  const clearMutation = useMutation({
    mutationFn: clearTransactionData,
    onSuccess: (result) => {
      toast.success(
        `${result.transactionCount} transações e ${result.importCount} importações removidas.`,
      )
      setClearConfirmation('')
      setClearDialogOpen(false)
      void invalidateFinance(queryClient, 'ledger')
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : 'Não foi possível limpar.',
      ),
  })

  function submitScope(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    scopeMutation.mutate({
      data: {
        name: String(form.get('name')),
        type: String(form.get('type')) as 'household' | 'person' | 'company_br',
      },
    })
  }

  function submitAiSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    settingsMutation.mutate({
      data: {
        monthlyIncomeTargetCents: data.settings.monthlyIncomeTargetCents,
        reserveMonths: data.settings.reserveMonths,
        keepReserveContributions: data.settings.keepReserveContributions,
        aiClassificationConsent: form.get('aiConsent') === 'on',
      },
    })
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Família e empresas"
          description="Proprietários usados para separar contas e patrimônio."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setScopeDialogOpen(true)}
            >
              <Plus data-icon="inline-start" />
              Adicionar
            </Button>
          }
        >
          <div className="divide-y overflow-hidden rounded-lg border">
            {data.scopes.map((scope) => (
              <div
                key={scope.id}
                className="flex items-center justify-between gap-3 px-3 py-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Building2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {scope.name}
                  </span>
                </div>
                <StatusBadge>
                  {scope.type === 'household'
                    ? 'Família'
                    : scope.type === 'person'
                      ? 'Pessoa'
                      : 'PJ Brasil'}
                </StatusBadge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Privacidade e IA"
          description="A IA só atua quando você autoriza e nunca confirma movimentações sozinha."
          footer={
            <Button
              type="submit"
              form="ai-preferences-form"
              disabled={settingsMutation.isPending}
            >
              <ShieldCheck data-icon="inline-start" />
              {settingsMutation.isPending ? 'Salvando…' : 'Salvar preferência'}
            </Button>
          }
        >
          <form id="ai-preferences-form" onSubmit={submitAiSettings}>
            <FieldGroup>
              <Field orientation="horizontal">
                <Switch
                  id="aiConsentSetting"
                  name="aiConsent"
                  defaultChecked={data.settings.aiClassificationConsent}
                />
                <FieldLabel htmlFor="aiConsentSetting">
                  Permitir categorização e validação de conciliações por IA
                </FieldLabel>
              </Field>
            </FieldGroup>
          </form>
        </Panel>
      </div>

      <Panel
        title="Dados locais"
        description="Manutenção dos dados financeiros deste computador."
      >
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <strong className="text-sm">Limpar transações e importações</strong>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Remove lançamentos, extratos, lotes, conciliações e meses
              fechados. Contas, cartões, metas e preferências permanecem.
            </p>
          </div>
          <AlertDialog
            open={clearDialogOpen}
            onOpenChange={(open) => {
              setClearDialogOpen(open)
              if (!open) setClearConfirmation('')
            }}
          >
            <AlertDialogTrigger render={<Button variant="destructive" />}>
              <Trash2 data-icon="inline-start" />
              Limpar transações
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <AlertTriangle />
                </AlertDialogMedia>
                <AlertDialogTitle>
                  Apagar todos os lançamentos?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Esta ação não pode ser desfeita pelo aplicativo. Digite{' '}
                  <strong>APAGAR</strong> para confirmar.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Field
                data-invalid={
                  clearConfirmation.length > 0 && clearConfirmation !== 'APAGAR'
                }
              >
                <FieldLabel htmlFor="clear-transactions-confirmation">
                  Confirmação
                </FieldLabel>
                <Input
                  id="clear-transactions-confirmation"
                  value={clearConfirmation}
                  onChange={(event) => setClearConfirmation(event.target.value)}
                  placeholder="APAGAR"
                  autoComplete="off"
                  aria-invalid={
                    clearConfirmation.length > 0 &&
                    clearConfirmation !== 'APAGAR'
                  }
                />
              </Field>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={clearMutation.isPending}>
                  Cancelar
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={
                    clearConfirmation !== 'APAGAR' || clearMutation.isPending
                  }
                  onClick={() =>
                    clearMutation.mutate({ data: { confirmation: 'APAGAR' } })
                  }
                >
                  <Trash2 data-icon="inline-start" />
                  {clearMutation.isPending ? 'Limpando…' : 'Apagar tudo'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Panel>

      <Dialog open={scopeDialogOpen} onOpenChange={setScopeDialogOpen}>
        <DialogContent>
          <form onSubmit={submitScope} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar pessoa ou empresa</DialogTitle>
              <DialogDescription>
                Use o nome que deve aparecer nas contas e relatórios.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="scope-name">Nome</FieldLabel>
                <Input
                  id="scope-name"
                  name="name"
                  placeholder="Nome ou razão social"
                  required
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="scope-type">Tipo</FieldLabel>
                <NativeSelect id="scope-type" name="type" className="w-full">
                  <NativeSelectOption value="person">Pessoa</NativeSelectOption>
                  <NativeSelectOption value="company_br">
                    Empresa brasileira
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={scopeMutation.isPending}>
                <Plus data-icon="inline-start" />
                {scopeMutation.isPending ? 'Adicionando…' : 'Adicionar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
