import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

const planningSearchSchema = z.object({
  section: z
    .enum(['budget', 'goals', 'recurrences'])
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute('/planejamento')({
  validateSearch: planningSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/configuracoes',
      search: {
        tab: search.section === 'recurrences' ? 'recorrencias' : 'orcamento',
      },
      replace: true,
    })
  },
})
