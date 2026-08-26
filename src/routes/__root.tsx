import {
  HeadContent,
  Link,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { FileQuestion } from 'lucide-react'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { AppShell } from '../components/app-shell'
import { EmptyState } from '../components/ui'
import { Button } from '../components/ui/button'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Família Finanças',
      },
      {
        name: 'description',
        content: 'Controle financeiro familiar e empresarial local.',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  notFoundComponent: NotFoundPage,
  shellComponent: RootDocument,
})

function NotFoundPage() {
  return (
    <div className="page flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={FileQuestion}
        title="Página não encontrada"
        description="O endereço pode estar incorreto ou a página pode ter sido removida."
        action={
          <Button nativeButton={false} render={<Link to="/" />}>
            Ir para visão geral
          </Button>
        }
      />
    </div>
  )
}

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell>{children}</AppShell>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
