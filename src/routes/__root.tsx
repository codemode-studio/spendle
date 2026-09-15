import {
  HeadContent,
  Link,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { CircleAlert, FileQuestion } from 'lucide-react'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { AppShell } from '../components/app-shell'
import { EmptyState, Page } from '../components/ui'
import { Button } from '../components/ui/button'
import { onboardingOptions } from '../features/finance/queries'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  loader: ({ context }) =>
    context.queryClient.prefetchQuery(onboardingOptions()),
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
        title: 'Spendle',
      },
      {
        name: 'description',
        content: 'Finanças da família em um só lugar.',
      },
    ],
    links: [
      {
        rel: 'icon',
        href: '/spendle-brandmark.svg',
        type: 'image/svg+xml',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorPage,
  shellComponent: RootDocument,
})

function RootErrorPage() {
  const router = useRouter()
  return (
    <Page className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={CircleAlert}
        title="Não foi possível carregar esta área"
        description="Tente novamente. Seus dados permanecem salvos neste dispositivo."
        action={
          <Button variant="outline" onClick={() => void router.invalidate()}>
            Tentar novamente
          </Button>
        }
      />
    </Page>
  )
}

function NotFoundPage() {
  return (
    <Page className="flex min-h-[60vh] items-center justify-center">
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
    </Page>
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
