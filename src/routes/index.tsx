import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { Home } from '#/features/home/home'
import {
  accountsOptions,
  assistantStatusOptions,
  categoryLedgerOptions,
  forecastOptions,
  monthHistoryOptions,
  monthOptions,
  planningStateOptions,
} from '#/features/v2/queries'

export const Route = createFileRoute('/')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(monthOptions()),
      context.queryClient.ensureQueryData(forecastOptions()),
      context.queryClient.ensureQueryData(categoryLedgerOptions()),
      context.queryClient.ensureQueryData(accountsOptions()),
      context.queryClient.ensureQueryData(planningStateOptions()),
      context.queryClient.ensureQueryData(assistantStatusOptions()),
      context.queryClient.prefetchQuery(monthHistoryOptions(11)),
    ]),
  component: HomePage,
})

function HomePage() {
  const { data: month } = useSuspenseQuery(monthOptions())
  const { data: forecast } = useSuspenseQuery(forecastOptions())
  const { data: ledger } = useSuspenseQuery(categoryLedgerOptions())
  const { data: accounts } = useSuspenseQuery(accountsOptions())
  const { data: planning } = useSuspenseQuery(planningStateOptions())
  const { data: assistant } = useSuspenseQuery(assistantStatusOptions())
  return (
    <Home
      data={{
        month,
        forecast,
        ledger,
        hasAccounts: accounts.length > 0,
        closedMonths: planning.budgets
          .map((budget) => budget.month)
          .sort()
          .join(','),
        assistantConfigured: assistant.configured,
      }}
    />
  )
}
