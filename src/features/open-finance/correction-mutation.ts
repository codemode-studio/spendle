import { mutationOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { invalidateFinance } from '#/features/finance/queries'

export interface PluggyCorrectionInput {
  data: { observationId: string; action: 'accept' | 'reject' }
}

// Accepting a Pluggy correction rewrites a ledger fact, so every read built
// on the ledger (including the investment portfolio) must refetch.
export function pluggyCorrectionMutationOptions(
  queryClient: QueryClient,
  resolveCorrection: (input: PluggyCorrectionInput) => Promise<unknown>,
) {
  return mutationOptions({
    mutationFn: resolveCorrection,
    onSuccess: async () => {
      toast.success('Correção revisada.')
      await invalidateFinance(queryClient, 'ledger')
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Falha ao revisar.'),
  })
}
