import { queryOptions } from '@tanstack/react-query'

import { getAssistantStatusFn } from './analysis.functions'
import { assistantQueryKeys } from './query-keys'

export { assistantQueryKeys } from './query-keys'

export const assistantStatusOptions = () =>
  queryOptions({
    queryKey: assistantQueryKeys.status(),
    queryFn: () => getAssistantStatusFn(),
    staleTime: 5 * 60_000,
  })
