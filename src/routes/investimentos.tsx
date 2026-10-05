import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { InvestmentsPage } from '#/features/investments/investments-page'
import {
  accountsOptions,
  categoriesOptions,
  investmentsOptions,
  monthOptions,
} from '#/features/v2/queries'

export const Route = createFileRoute('/investimentos')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(investmentsOptions()),
      context.queryClient.ensureQueryData(accountsOptions()),
      context.queryClient.ensureQueryData(categoriesOptions()),
      // The plan's reserve target.
      context.queryClient.ensureQueryData(monthOptions()),
    ]),
  component: InvestmentsRoute,
})

function InvestmentsRoute() {
  useSuspenseQuery(investmentsOptions())
  return <InvestmentsPage />
}
