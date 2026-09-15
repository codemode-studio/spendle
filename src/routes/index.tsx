import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import {
  financeSnapshotOptions,
  strategyHistoryOptions,
} from '#/features/finance/queries'
import { Home } from '#/features/home/home'
import { assistantStatusOptions } from '#/features/home/queries'

export const Route = createFileRoute('/')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(financeSnapshotOptions()),
      context.queryClient.ensureQueryData(assistantStatusOptions()),
      context.queryClient.prefetchQuery(strategyHistoryOptions(11)),
    ]),
  component: HomePage,
})

function HomePage() {
  const { data } = useSuspenseQuery(financeSnapshotOptions())
  const { data: assistant } = useSuspenseQuery(assistantStatusOptions())
  return <Home snapshot={data} assistantConfigured={assistant.configured} />
}
