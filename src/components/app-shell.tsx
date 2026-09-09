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
  Menu,
  X,
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
  useSidebar,
} from '#/components/ui/sidebar'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { TooltipProvider } from '#/components/ui/tooltip'
import { Toaster } from '#/components/ui/sonner'
import { OnboardingCard } from '#/features/home/onboarding-card'

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
] as const

function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { openMobile, setOpenMobile } = useSidebar()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  const search = useRouterState({ select: (state) => state.location.search })

  return (
    <>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="flex-row items-center">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip="Família Finanças"
                render={<Link to="/" />}
                onClick={() => setOpenMobile(false)}
              >
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
                    (targetSearch
                      ? targetSearch.tab === 'contas'
                        ? search.tab === 'contas' || search.tab === 'cartoes'
                        : targetSearch.tab === 'orcamento'
                          ? search.tab === 'orcamento' || search.tab === 'metas'
                          : search.tab === targetSearch.tab
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
        <SidebarFooter
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpenMobile(false)
          }}
        >
          <OnboardingCard />
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
                render={<Link to="/configuracoes" search={{ tab: 'geral' }} />}
                isActive={
                  pathname === '/configuracoes' &&
                  search.tab !== 'contas' &&
                  search.tab !== 'cartoes' &&
                  search.tab !== 'orcamento' &&
                  search.tab !== 'metas' &&
                  search.tab !== 'recorrencias'
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
        <header className="shrink-0 bg-background px-4 pt-2 pb-3 md:hidden">
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
              className="justify-self-center text-lg font-semibold tracking-tight"
            >
              Família<span className="text-primary">.</span>
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
            {navigation.slice(0, 3).map(({ to, label, icon: Icon }) => (
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
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 [scrollbar-gutter:stable]">
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
      <SidebarProvider>
        <AppLayout>{children}</AppLayout>
      </SidebarProvider>
      <Toaster position="top-right" />
    </TooltipProvider>
  )
}
