import { createServerFn } from '@tanstack/react-start'

import { v2 } from '#/lib/v2/client.server'

import { hasActiveRecurrences, ledgerSetup } from './onboarding.server'

export const getOnboardingStatusFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const [ledger, recurrences] = await Promise.all([
      v2(ledgerSetup),
      v2(hasActiveRecurrences),
    ])
    return { ...ledger, recurrences }
  },
)
