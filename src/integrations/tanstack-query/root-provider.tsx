import { QueryClient } from '@tanstack/react-query'

export function getContext() {
  const queryClient = new QueryClient({
    // Route loaders read through `ensureQueryData`, which retries nothing
    // unless told to: a read aborted as stuck (`src/start.ts`) is tried
    // again instead of failing the page.
    defaultOptions: { queries: { retry: 2 } },
  })

  return {
    queryClient,
  }
}
