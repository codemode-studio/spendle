import { Building2, Plus } from 'lucide-react'
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
import { AccountsSection } from '#/features/finance/accounts-section'
import { CardsSection } from '#/features/finance/cards-section'
import { KnowledgeBaseSection } from '#/features/finance/knowledge-base-section'
import { invalidateFinance } from '#/features/finance/queries'
import { createOwnerFn } from '#/features/data/accounts.functions'
import { ownerKindLabels } from '#/features/data/accounts'
import type { Owner } from '#/features/data/accounts'
import {
  accountsOptions,
  categoriesOptions,
  providerMappingsOptions,
  storePatternsOptions,
  connectSettingsOptions,
  connectionsOptions,
  monthOptions,
  ownersOptions,
  planningStateOptions,
  recurrenceBookOptions,
  spaceOptions,
} from '#/features/data/queries'
import { OpenFinanceSection } from '#/features/finance/open-finance-section'
import { MembersPanel } from '#/features/space/members-panel'
import { errorMessage } from '#/lib/api/errors'

import { PlanningSettings } from '#/features/planning/planning-settings'

const settingsTabs = [
  'geral',
  'contas',
  'cartoes',
  'open-finance',
  'recorrencias',
  'orcamento',
  'conhecimento',
] as const
const settingsLabels = {
  geral: 'Geral',
  contas: 'Contas',
  cartoes: 'Cartões',
  'open-finance': 'Open Finance',
  recorrencias: 'Recorrências',
  orcamento: 'Orçamento e metas',
  conhecimento: 'Conhecimento',
} as const
type SettingsTab = (typeof settingsTabs)[number]

/** `metas` virou parte de Orçamento e metas; links antigos continuam abrindo a aba certa. */
const settingsSearchSchema = z.object({
  tab: z
    .enum([...settingsTabs, 'metas'])
    .optional()
    .catch(undefined),
})

function resolveTab(tab: string | undefined): SettingsTab {
  if (!tab) return 'geral'
  return tab === 'metas' ? 'orcamento' : (tab as SettingsTab)
}

export const Route = createFileRoute('/configuracoes')({
  validateSearch: settingsSearchSchema,
  loaderDeps: ({ search }) => ({ tab: resolveTab(search.tab) }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(ownersOptions()),
      deps.tab === 'geral'
        ? context.queryClient.ensureQueryData(spaceOptions())
        : null,
      deps.tab === 'contas' ||
      deps.tab === 'cartoes' ||
      deps.tab === 'open-finance'
        ? context.queryClient.ensureQueryData(accountsOptions(true))
        : null,
      deps.tab === 'open-finance'
        ? Promise.all([
            context.queryClient.ensureQueryData(connectionsOptions()),
            context.queryClient.ensureQueryData(connectSettingsOptions()),
          ])
        : null,
      deps.tab === 'orcamento' || deps.tab === 'recorrencias'
        ? Promise.all([
            context.queryClient.ensureQueryData(planningStateOptions()),
            context.queryClient.ensureQueryData(monthOptions()),
            context.queryClient.ensureQueryData(recurrenceBookOptions()),
            context.queryClient.ensureQueryData(accountsOptions()),
            context.queryClient.ensureQueryData(categoriesOptions()),
          ])
        : null,
      deps.tab === 'conhecimento'
        ? Promise.all([
            context.queryClient.ensureQueryData(storePatternsOptions()),
            context.queryClient.ensureQueryData(providerMappingsOptions()),
            context.queryClient.ensureQueryData(categoriesOptions()),
          ])
        : null,
    ]),
  component: SettingsPage,
})

function SettingsPage() {
  const { tab } = Route.useSearch()
  const activeTab = resolveTab(tab)

  // Each area has its own sidebar entry, so the page shows only the selected
  // one. Contas, Cartões and Open Finance render their own header to keep their
  // primary action next to the title.
  const ownsHeader =
    activeTab === 'contas' ||
    activeTab === 'cartoes' ||
    activeTab === 'open-finance'

  return (
    <Page>
      {!ownsHeader && (
        <PageHeader
          title={
            activeTab === 'geral' ? 'Configurações' : settingsLabels[activeTab]
          }
        />
      )}
      {activeTab === 'geral' && <GeneralSettings />}
      {activeTab === 'contas' && <AccountsSection />}
      {activeTab === 'cartoes' && <CardsSection />}
      {activeTab === 'open-finance' && <OpenFinanceSection />}
      {activeTab === 'recorrencias' && (
        <PlanningSettings activeSection="recurrences" />
      )}
      {activeTab === 'orcamento' && (
        <PlanningSettings activeSection="planning" />
      )}
      {activeTab === 'conhecimento' && <KnowledgeBaseSection />}
    </Page>
  )
}

function GeneralSettings() {
  const { data: owners } = useSuspenseQuery(ownersOptions())
  const queryClient = useQueryClient()
  const createOwner = useServerFn(createOwnerFn)
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false)

  const ownerMutation = useMutation({
    mutationFn: createOwner,
    onSuccess: (owner) => {
      toast.success(`${owner.name} adicionado.`)
      setOwnerDialogOpen(false)
      void invalidateFinance(queryClient, 'ownershipScope')
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível adicionar.')),
  })
  function submitOwner(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    ownerMutation.mutate({
      data: {
        name: String(form.get('name')).trim(),
        kind: String(form.get('kind')) as Owner['kind'],
      },
    })
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Família e empresas"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOwnerDialogOpen(true)}
            >
              <Plus data-icon="inline-start" />
              Adicionar
            </Button>
          }
        >
          {owners.length ? (
            <div className="divide-y overflow-hidden rounded-lg border">
              {owners.map((owner) => (
                <div
                  key={owner.id}
                  className="flex items-center justify-between gap-3 px-3 py-3"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Building2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">
                      {owner.name}
                    </span>
                  </div>
                  <StatusBadge>{ownerKindLabels[owner.kind]}</StatusBadge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Adicione a família ou a pessoa titular antes de cadastrar contas.
            </p>
          )}
        </Panel>
        <MembersPanel />
      </div>

      <Dialog open={ownerDialogOpen} onOpenChange={setOwnerDialogOpen}>
        <DialogContent>
          <form onSubmit={submitOwner} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar pessoa ou empresa</DialogTitle>
              <DialogDescription>
                Use o nome que deve aparecer nas contas e relatórios.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="owner-name">Nome</FieldLabel>
                <Input
                  id="owner-name"
                  name="name"
                  placeholder="Nome ou razão social"
                  required
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="owner-kind">Tipo</FieldLabel>
                <NativeSelect id="owner-kind" name="kind" className="w-full">
                  <NativeSelectOption value="person">Pessoa</NativeSelectOption>
                  <NativeSelectOption value="household">
                    Família
                  </NativeSelectOption>
                  <NativeSelectOption value="company">
                    Empresa
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={ownerMutation.isPending}>
                <Plus data-icon="inline-start" />
                {ownerMutation.isPending ? 'Adicionando…' : 'Adicionar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
