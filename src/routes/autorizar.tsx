import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CircleAlert,
  Eye,
  Lock,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { SpendleLockup } from '#/components/spendle-logo'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { authClient } from '#/features/auth/auth-client'

// Loose: the rest of the query is the signed authorization request, which
// the consent call sends back untouched.
const consentSearchSchema = z.looseObject({
  client_id: z.string().optional().catch(undefined),
  redirect_uri: z.string().optional().catch(undefined),
})

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Where the authorization code goes. The value comes from the signed request:
 * Better Auth already matched it against the client's registered callbacks,
 * and an edited URL fails the signature when the person consents.
 */
function destinationOf(redirectUri: string | undefined) {
  if (redirectUri === undefined || !URL.canParse(redirectUri)) return null
  const { protocol, hostname, host } = new URL(redirectUri)
  if (loopbackHosts.has(hostname)) return 'um app neste computador'
  return protocol === 'https:' || protocol === 'http:' ? host : protocol
}

/** What an approved client can do, as the MCP tools allow it. */
const access = [
  {
    icon: Eye,
    label: 'Ver contas, transações, planejamento, cartões e investimentos',
  },
  { icon: RefreshCw, label: 'Atualizar e sincronizar o Open Finance' },
  { icon: Lock, label: 'Não altera categorias, planos nem contas' },
]

/**
 * Where an MCP client's sign-in asks the person to approve it. Better Auth
 * sends them here after `/entrar`, once per client.
 */
export const Route = createFileRoute('/autorizar')({
  validateSearch: consentSearchSchema,
  head: () => ({ meta: [{ title: 'Autorizar acesso · Spendle' }] }),
  component: ConsentPage,
})

/**
 * The client as registered. A Client ID Metadata Document client is
 * identified by its URL, so its host is one the app proved it controls; a
 * self-registered client's name is whatever it chose to send.
 */
function useClient(clientId: string | undefined) {
  return useQuery({
    queryKey: ['auth', 'oauth-client', clientId],
    enabled: clientId !== undefined,
    queryFn: async () => {
      const { data, error } = await authClient.oauth2.publicClient({
        query: { client_id: clientId ?? '' },
      })
      if (error) throw new Error(error.message)
      return {
        name: data.client_name ?? null,
        verifiedHost: URL.canParse(clientId ?? '')
          ? new URL(clientId ?? '').host
          : null,
      }
    },
  })
}

function ConsentPage() {
  const { viewer } = Route.useRouteContext()
  const search = Route.useSearch()
  const client = useClient(search.client_id)
  const [pending, setPending] = useState<'accept' | 'deny' | null>(null)
  const [failed, setFailed] = useState(false)

  async function decide(accept: boolean) {
    setPending(accept ? 'accept' : 'deny')
    setFailed(false)
    // A dropped connection rejects instead of returning `error`.
    const url = await authClient.oauth2
      .consent({ accept })
      .then(({ data }) => data?.url)
      .catch(() => undefined)
    if (!url) {
      setPending(null)
      setFailed(true)
      return
    }
    // Back to the client, with a code or with the refusal.
    window.location.assign(url)
  }

  const missing = search.client_id === undefined || client.isError
  const destination = destinationOf(search.redirect_uri)

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="grid w-full max-w-sm justify-items-center gap-6 text-center">
        <SpendleLockup />
        {missing ? (
          <p
            role="alert"
            className="flex items-start gap-2 text-left text-sm text-destructive"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            Este pedido de acesso expirou ou não é válido. Conecte o Spendle de
            novo pelo aplicativo que pediu acesso.
          </p>
        ) : (
          <>
            <div className="grid gap-1">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">
                {client.data ? (
                  <>
                    Permitir acesso a {client.data.name ?? 'este aplicativo'}?
                  </>
                ) : (
                  <Spinner className="mx-auto" />
                )}
              </h1>
              {client.data && (
                <p className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                  {client.data.verifiedHost ? (
                    <>
                      <ShieldCheck className="size-4 shrink-0" />
                      Verificado por {client.data.verifiedHost}
                    </>
                  ) : (
                    <>
                      <ShieldQuestion className="size-4 shrink-0" />
                      Nome informado pelo próprio app
                    </>
                  )}
                </p>
              )}
            </div>
            {destination && (
              <p className="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm">
                <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>
                  O acesso vai para{' '}
                  <span className="font-medium break-all">{destination}</span>
                </span>
              </p>
            )}
            <ul className="grid w-full gap-3 text-left text-sm">
              {access.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {label}
                </li>
              ))}
            </ul>
            {failed && (
              <p
                role="alert"
                className="flex items-start gap-2 text-left text-sm text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                Não foi possível registrar sua resposta. Tente novamente.
              </p>
            )}
            <div className="grid w-full gap-2">
              <Button
                size="lg"
                disabled={pending !== null || !client.data}
                onClick={() => void decide(true)}
              >
                {pending === 'accept' && <Spinner data-icon="inline-start" />}
                Permitir
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void decide(false)}
              >
                {pending === 'deny' && <Spinner data-icon="inline-start" />}
                Recusar
              </Button>
            </div>
            {viewer && (
              <p className="text-xs text-muted-foreground">
                Conectado como {viewer.email}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
