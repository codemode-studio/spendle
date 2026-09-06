import {
  ArrowLeftRight,
  LayoutDashboard,
  PiggyBank,
  Settings,
  Upload,
  WalletCards,
  Tags,
  Landmark,
  CalendarClock,
} from 'lucide-react'
import { Link, useRouterState } from '@tanstack/react-router'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '#/components/ui/sidebar'
import { TooltipProvider } from '#/components/ui/tooltip'
import { Toaster } from '#/components/ui/sonner'

const navigation = [
  { to: '/', label: 'Visão geral', icon: LayoutDashboard },
  { to: '/transacoes', label: 'Transações', icon: ArrowLeftRight },
  { to: '/categorias', label: 'Categorias', icon: Tags },
  {
    to: '/configuracoes',
    search: { tab: 'contas' },
    label: 'Contas',
    icon: Landmark,
  },
  {
    to: '/planejamento',
    search: { section: 'recurrences' },
    label: 'Recorrências',
    icon: CalendarClock,
  },
  {
    to: '/planejamento',
    search: { section: 'budget' },
    label: 'Orçamento e metas',
    icon: PiggyBank,
  },
] as const

export function AppShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  const search = useRouterState({ select: (state) => state.location.search })

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" tooltip="Família Finanças">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                    <WalletCards />
                  </span>
                  <span className="flex min-w-0 flex-col leading-none">
                    <strong className="truncate">Família</strong>
                    <span className="truncate text-xs text-sidebar-foreground/55">
                      Finanças
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Organização</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigation.map((item) => {
                    const { to, label, icon: Icon } = item
                    const targetSearch =
                      'search' in item ? item.search : undefined
                    const isActive =
                      pathname === to &&
                      (targetSearch && 'tab' in targetSearch
                        ? search.tab === 'contas' || search.tab === 'cartoes'
                        : targetSearch && 'section' in targetSearch
                          ? targetSearch.section === 'recurrences'
                            ? search.section === 'recurrences'
                            : search.section !== 'recurrences'
                          : true)
                    return (
                      <SidebarMenuItem key={label}>
                        <SidebarMenuButton
                          render={<Link to={to} search={targetSearch} />}
                          isActive={isActive}
                          tooltip={label}
                          className="min-h-11"
                        >
                          <Icon />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="min-h-11"
                  render={<Link to="/importar" />}
                  isActive={pathname === '/importar'}
                  tooltip="Importar extrato"
                >
                  <Upload />
                  <span>Importar extrato</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="min-h-11"
                  render={
                    <Link to="/configuracoes" search={{ tab: 'geral' }} />
                  }
                  isActive={
                    pathname === '/configuracoes' &&
                    search.tab !== 'contas' &&
                    search.tab !== 'cartoes'
                  }
                  tooltip="Configurações"
                >
                  <Settings />
                  <span>Configurações</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="h-svh min-h-0 overflow-hidden md:h-[calc(100svh-1rem)] md:peer-data-[variant=inset]:shadow-none">
          <header className="flex h-12 shrink-0 items-center border-b px-4 md:hidden">
            <SidebarTrigger />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 [scrollbar-gutter:stable]">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="top-right" />
    </TooltipProvider>
  )
}
