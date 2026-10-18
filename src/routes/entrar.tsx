import { createFileRoute, redirect } from '@tanstack/react-router'
import { CircleAlert, LogIn } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'

import { SpendleLockup } from '#/components/spendle-logo'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { authClient } from '#/features/auth/auth-client'
import { safeRedirect } from '#/features/auth/redirect'

// Loose: an MCP client's authorization request arrives here as signed query
// parameters, which sign-in must send back untouched.
const signInSearchSchema = z.looseObject({
  redirect: z.string().transform(safeRedirect).optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  /** Present when an MCP client's authorization request sent the person here. */
  sig: z.string().optional().catch(undefined),
})

/** Codes Better Auth appends to the error URL after Google's callback. */
const errorMessages: Record<string, string> = {
  EMAIL_NOT_ALLOWED:
    'Este e-mail não tem acesso ao Spendle. Entre com uma conta autorizada.',
  access_denied: 'A entrada pelo Google foi cancelada.',
}

export const Route = createFileRoute('/entrar')({
  validateSearch: signInSearchSchema,
  beforeLoad: ({ context, search }) => {
    // An authorization request may ask a signed-in person to sign in again
    // (`prompt=login`, `max_age`); only a new sign-in continues it.
    if (context.viewer && search.sig === undefined) {
      throw redirect({ to: search.redirect ?? '/' })
    }
  },
  head: () => ({ meta: [{ title: 'Entrar · Spendle' }] }),
  component: SignInPage,
})

function SignInPage() {
  const search = Route.useSearch()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const message = failed
    ? 'Não foi possível abrir o Google. Tente novamente.'
    : search.error
      ? (errorMessages[search.error] ??
        'Não foi possível entrar com o Google. Tente novamente.')
      : null

  async function signIn() {
    setPending(true)
    setFailed(false)
    // On success the browser leaves for Google; only a failure returns here.
    const { error } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: search.redirect ?? '/',
      errorCallbackURL: '/entrar',
    })
    if (error) {
      setPending(false)
      setFailed(true)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="grid w-full max-w-sm justify-items-center gap-6 text-center">
        <SpendleLockup />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Entrar no Spendle
        </h1>
        {message && (
          <p
            role="alert"
            className="flex items-start gap-2 text-left text-sm text-destructive"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {message}
          </p>
        )}
        <Button
          size="lg"
          className="w-full"
          disabled={pending}
          onClick={() => void signIn()}
        >
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <LogIn data-icon="inline-start" />
          )}
          Continuar com Google
        </Button>
      </div>
    </div>
  )
}
