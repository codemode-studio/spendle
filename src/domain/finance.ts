import { z } from 'zod'

import { toMinorUnits } from './currency'

export {
  currencyFractionDigits,
  convertMinorUnitsAtRate,
  currencyOptions,
  currencySchema,
  formatCurrency,
  formatMinorUnitsForInput,
  isSupportedCurrency,
  minorUnitsToMajor,
  parseCurrency,
  supportedCurrencies,
  toMinorUnits,
} from './currency'
export type { SupportedCurrency } from './currency'

export const allocationBuckets = [
  'essential',
  'lifestyle',
  'investment',
  'reserve',
] as const

export type AllocationBucket = (typeof allocationBuckets)[number]

export const strategyTemplates = [
  'balanced',
  'wealth',
  'aggressive',
  'independence',
] as const

export type StrategyTemplate = (typeof strategyTemplates)[number]

export interface StrategyAllocation {
  essential: number
  lifestyle: number
  investment: number
  reserve: number
}

export const strategyAllocationSchema = z
  .object({
    essential: z.number().int().min(0).max(10_000),
    lifestyle: z.number().int().min(0).max(10_000),
    investment: z.number().int().min(0).max(10_000),
    reserve: z.number().int().min(0).max(10_000),
  })
  .superRefine((allocation, context) => {
    const total = Object.values(allocation).reduce(
      (sum, value) => sum + value,
      0,
    )
    if (total !== 10_000) {
      context.addIssue({
        code: 'custom',
        message: 'A soma dos percentuais deve ser exatamente 100%.',
      })
    }
  })

export const strategyTemplateSchema = z.enum(strategyTemplates)

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

export function resolveEffectiveAllocation(
  allocation: StrategyAllocation,
  reserveComplete: boolean,
  keepReserveContributions = false,
): StrategyAllocation {
  strategyAllocationSchema.parse(allocation)
  if (!reserveComplete || keepReserveContributions) return { ...allocation }

  return {
    ...allocation,
    investment: allocation.investment + allocation.reserve,
    reserve: 0,
  }
}

export function calculateConservativeBase(
  configuredTargetCents: number,
  closedMonthNetIncomeCents: number[],
): number {
  if (closedMonthNetIncomeCents.length < 3) return configuredTargetCents
  const lastThree = closedMonthNetIncomeCents.slice(-3)
  const average = Math.round(
    lastThree.reduce((sum, amount) => sum + amount, 0) / lastThree.length,
  )
  return Math.min(configuredTargetCents, Math.max(0, average))
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

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`))
}

export function percentFromBps(bps: number) {
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(
    bps / 100,
  )}%`
}

export function toCents(value: string | number, currency = 'BRL') {
  return toMinorUnits(value, currency)
}
