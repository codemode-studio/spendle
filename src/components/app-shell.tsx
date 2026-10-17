import {
  ArrowLeftRight,
  BookOpen,
  CalendarClock,
  ChartNoAxesCombined,
  CreditCard,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  PiggyBank,
  Settings,
  Tags,
  Upload,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  useSidebar,
} from '#/components/ui/sidebar'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { NavigationProgress } from '#/components/navigation-progress'
import { TooltipProvider } from '#/components/ui/tooltip'
import { Toaster } from '#/components/ui/sonner'
import { OnboardingCard } from '#/features/home/onboarding-card'
import { SpendleLockup } from '#/components/spendle-logo'
import { OpenFinanceLogo } from '#/components/open-finance-logo'
import { authClient } from '#/features/auth/auth-client'
import { viewerOptions } from '#/features/auth/viewer'

const overviewNavigation = [
  { to: '/', label: 'Visão geral', icon: LayoutDashboard },
  { to: '/categorias', label: 'Categorias', icon: Tags },
  { to: '/investimentos', label: 'Investimentos', icon: ChartNoAxesCombined },
  { to: '/transacoes', label: 'Transações', icon: ArrowLeftRight },
] as const

const managementNavigation = [
  {
    to: '/configuracoes',
    search: { tab: 'contas' },
    label: 'Contas',
    icon: Landmark,
  },
  {
    to: '/configuracoes',
    search: { tab: 'cartoes' },
    label: 'Cartões',
    icon: CreditCard,
  },
  {
    to: '/configuracoes',
    search: { tab: 'open-finance' },
    label: 'Open Finance',
    icon: OpenFinanceLogo,
  },
  {
    to: '/configuracoes',
    search: { tab: 'recorrencias' },
    label: 'Recorrências',
    icon: CalendarClock,
  },
  {
    to: '/configuracoes',
    search: { tab: 'orcamento' },
    label: 'Orçamento e metas',
    icon: PiggyBank,
  },
  {
    to: '/configuracoes',
    search: { tab: 'conhecimento' },
    label: 'Conhecimento',
    icon: BookOpen,
  },
] as const

const navigation = [...overviewNavigation, ...managementNavigation] as const

/** Abas de configurações que têm entrada própria no menu. */
const settingsTabsInMenu = new Set<unknown>(
  navigation.flatMap((item) => ('search' in item ? [item.search.tab] : [])),
)

/** `metas` foi absorvida por Orçamento e metas; links antigos continuam válidos. */
function menuTab(tab: unknown) {
  return tab === 'metas' ? 'orcamento' : tab
}

function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { openMobile, setOpenMobile } = useSidebar()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  const search = useRouterState({ select: (state) => state.location.search })

  if (pathname === '/marca' || pathname === '/entrar') {
    return (
      <main className="brand-guide-shell min-h-svh overflow-y-auto">
        {children}
      </main>
    )
  }

  return (
    <>
      <NavigationProgress />
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="flex-row items-center justify-between">
          <Link
            to="/"
            aria-label="Ir para a visão geral"
            className="flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-1.5 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            onClick={() => setOpenMobile(false)}
          >
            <SpendleLockup wordmarkClassName="group-data-[collapsible=icon]:hidden" />
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Fechar menu"
            onClick={() => setOpenMobile(false)}
          >
            <X />
          </Button>
        </SidebarHeader>
        <SidebarContent
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpenMobile(false)
          }}
        >
          {[overviewNavigation, managementNavigation].map((group, index) => (
            <div key={index}>
              {index > 0 && <SidebarSeparator />}
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.map((item) => {
                      const { to, label, icon: Icon } = item
                      const targetSearch =
                        'search' in item ? item.search : undefined
                      const isActive =
                        pathname === to &&
                        (targetSearch
                          ? menuTab(search.tab) === targetSearch.tab
                          : true)
                      return (
                        <SidebarMenuItem key={label}>
                          <SidebarMenuButton
                            render={<Link to={to} search={targetSearch} />}
                            isActive={isActive}
                            tooltip={label}
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
            </div>
          ))}
        </SidebarContent>
        <SidebarFooter
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpenMobile(false)
          }}
        >
          <OnboardingCard />
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
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
                render={<Link to="/configuracoes" search={{ tab: 'geral' }} />}
                isActive={
                  pathname === '/configuracoes' &&
                  !settingsTabsInMenu.has(menuTab(search.tab))
                }
                tooltip="Configurações"
              >
                <Settings />
                <span>Configurações</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SignOutItem />
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="crystal-inset h-svh min-h-0 overflow-hidden md:h-[calc(100svh-1rem)] md:peer-data-[variant=inset]:shadow-none">
        <header className="mobile-glass-header shrink-0 bg-background px-4 pt-2 pb-3 md:hidden">
          <div className="grid h-12 grid-cols-[44px_1fr_44px] items-center">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Abrir menu"
              aria-expanded={openMobile}
              onClick={() => setOpenMobile(true)}
            >
              <Menu />
            </Button>
            <Link
              to="/"
              aria-label="Ir para a visão geral"
              className="justify-self-center"
            >
              <SpendleLockup />
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Importar extrato"
              nativeButton={false}
              render={<Link to="/importar" />}
            >
              <Upload />
            </Button>
          </div>
          <nav aria-label="Navegação principal" className="mt-2 flex gap-1">
            {overviewNavigation.slice(0, 3).map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                aria-current={pathname === to ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                  pathname === to
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {to === '/' ? 'Início' : label}
              </Link>
            ))}
          </nav>
        </header>
        <div className="app-canvas min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {children}
        </div>
      </SidebarInset>
    </>
  )
}

export function AppShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <TooltipProvider>
      <SidebarProvider className="crystal-shell">
        <AppLayout>{children}</AppLayout>
      </SidebarProvider>
      <Toaster position="top-right" />
    </TooltipProvider>
  )
}

function SignOutItem() {
  const { data: viewer } = useQuery(viewerOptions())

  async function signOut() {
    await authClient.signOut()
    // A full load drops every cached financial read.
    window.location.assign('/entrar')
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={viewer ? `Sair (${viewer.email})` : 'Sair'}
        onClick={() => void signOut()}
      >
        <LogOut />
        <span>Sair</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
