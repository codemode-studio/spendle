import { queryOptions } from '@tanstack/react-query'

import { financeQueryKeys } from '#/features/finance/queries'

import { getAssistantStatusFn } from './analysis.functions'

export const assistantStatusOptions = () =>
  queryOptions({
    // Sob a chave de finanças: salvar consentimento de IA em Configurações
    // invalida `financeQueryKeys.all` e atualiza o assistente na hora.
    queryKey: [...financeQueryKeys.all, 'assistant', 'status'] as const,
    queryFn: () => getAssistantStatusFn(),
    staleTime: 5 * 60_000,
  })
