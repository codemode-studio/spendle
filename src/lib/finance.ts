import { formatCurrency as formatCurrencyValue } from './currency'
import { formatMonthLong } from './period'

export type AllocationBucket =
  | 'essential'
  | 'lifestyle'
  | 'investment'
  | 'reserve'

export type BucketAmounts = Record<AllocationBucket, number>

export const bucketLabels: Record<AllocationBucket, string> = {
  essential: 'Essenciais',
  lifestyle: 'Estilo de vida',
  investment: 'Investimentos',
  reserve: 'Reserva',
}

type StrategyTemplate = 'balanced' | 'wealth' | 'aggressive' | 'independence'

interface StrategyAllocation {
  essential: number
  lifestyle: number
  investment: number
  reserve: number
}

export const strategyPresets: Record<
  StrategyTemplate,
  { name: string; allocation: StrategyAllocation; description: string }
> = {
  balanced: {
    name: 'Equilibrada',
    allocation: {
      essential: 4_000,
      lifestyle: 2_000,
      investment: 3_000,
      reserve: 1_000,
    },
    description:
      'Equilíbrio entre conforto presente e construção de patrimônio.',
  },
  wealth: {
    name: 'Patrimonial',
    allocation: {
      essential: 3_500,
      lifestyle: 2_000,
      investment: 3_500,
      reserve: 1_000,
    },
    description: 'Mais espaço para patrimônio sem reduzir o estilo de vida.',
  },
  aggressive: {
    name: 'Agressiva',
    allocation: {
      essential: 3_000,
      lifestyle: 2_000,
      investment: 4_000,
      reserve: 1_000,
    },
    description: 'Prioriza aportes com controle forte de custos essenciais.',
  },
  independence: {
    name: 'Independência',
    allocation: {
      essential: 3_000,
      lifestyle: 1_000,
      investment: 5_000,
      reserve: 1_000,
    },
    description: 'Maximiza aportes para acelerar a independência financeira.',
  },
}

export function allocationAmount(baseCents: number, basisPoints: number) {
  return Math.round((baseCents * basisPoints) / 10_000)
}

export function normalizeDescription(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function formatInstrumentName(name: string) {
  return name.replace(/\s+•\s*(\d{4})$/, ' · $1')
}

export function percentFromBps(bps: number) {
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(
    bps / 100,
  )}%`
}

export const formatCurrency = formatCurrencyValue
export function formatMonth(value: string) {
  return formatMonthLong(value, { capitalize: true })
}
