import { createServerFn } from '@tanstack/react-start'
import { getOnboardingStatus } from './onboarding.server'

export const getOnboardingStatusFn = createServerFn({ method: 'GET' }).handler(
  () => getOnboardingStatus(),
)
