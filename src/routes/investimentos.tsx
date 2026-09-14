import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { InvestmentsPage } from '#/features/investments/investments-page'
import { investmentsOptions } from '#/features/investments/queries'

export const Route = createFileRoute('/investimentos')({
  loader: ({ context }) => context.queryClient.ensureQueryData(investmentsOptions()),
  component: InvestmentsRoute,
})

function InvestmentsRoute() {
  useSuspenseQuery(investmentsOptions())
  return <InvestmentsPage />
}
