import {
  ArrowLeftRight,
  Building2,
  CreditCard,
  LayoutDashboard,
  PiggyBank,
  Settings,
  Upload,
  WalletCards,
} from 'lucide-react'
import { Link, useRouterState } from '@tanstack/react-router'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
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
  { to: '/contas', label: 'Contas', icon: Building2 },
  { to: '/cartoes', label: 'Cartões', icon: CreditCard },
  { to: '/transacoes', label: 'Transações', icon: ArrowLeftRight },
  { to: '/importar', label: 'Importar', icon: Upload },
  { to: '/planejamento', label: 'Planejamento', icon: PiggyBank },
  { to: '/configuracoes', label: 'Configurações', icon: Settings },
] as const

export function AppShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" tooltip="Família Finanças">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
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
                  {navigation.map(({ to, label, icon: Icon }) => {
                    const isActive =
                      to === '/' ? pathname === '/' : pathname.startsWith(to)
                    return (
                      <SidebarMenuItem key={to}>
                        <SidebarMenuButton
                          render={<Link to={to} />}
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
          </SidebarContent>
          <SidebarFooter>
            <div className="flex items-center gap-2.5 rounded-lg bg-sidebar-accent/25 px-3 py-2.5 text-xs leading-snug text-sidebar-foreground/65 ring-1 ring-inset ring-sidebar-border group-data-[collapsible=icon]:hidden">
              <span className="size-2 shrink-0 rounded-full bg-sidebar-primary" />
              <span>Dados somente neste computador</span>
            </div>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="overflow-hidden md:peer-data-[variant=inset]:shadow-none">
          <header className="flex h-12 items-center border-b px-4 md:hidden">
            <SidebarTrigger />
          </header>
          <div className="min-h-svh bg-muted/30 p-4 md:p-8 lg:p-10">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="top-right" />
    </TooltipProvider>
  )
}
