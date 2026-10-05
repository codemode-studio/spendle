import type { RecurrencePresentationStatus } from '#/lib/recurrence'

export function recurrenceStatusBadge(
  status: RecurrencePresentationStatus,
): { label: string; tone: 'info' | 'warning' | 'success' } | null {
  switch (status) {
    case 'in_progress':
      return { label: 'Em andamento', tone: 'info' }
    case 'suggested':
      return { label: 'Candidato encontrado', tone: 'warning' }
    case 'overdue':
      return { label: 'Atrasada', tone: 'warning' }
    case 'done':
      return { label: 'Realizada', tone: 'success' }
    case 'pending':
      return { label: 'Pendente', tone: 'info' }
    case 'paused':
      return null
  }
}
