import { createServerFn } from '@tanstack/react-start'

import { api } from '#/lib/api/client.server'

import { hasActiveRecurrences, ledgerSetup } from './onboarding.server'

export const getOnboardingStatusFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const [ledger, recurrences] = await Promise.all([
      api(ledgerSetup),
      api(hasActiveRecurrences),
    ])
    return { ...ledger, recurrences }
  },
)
