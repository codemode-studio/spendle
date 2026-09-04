import {
  ArrowLeftRight,
  LayoutDashboard,
  PiggyBank,
  Settings,
  Upload,
  WalletCards,
  Tags,
} from 'lucide-react'
import { Link, useRouterState } from '@tanstack/react-router'

import {
  Sidebar,
  SidebarContent,
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
  { to: '/transacoes', label: 'Transações', icon: ArrowLeftRight },
  { to: '/categorias', label: 'Categorias', icon: Tags },
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
