import { ArrowLeftRight } from 'lucide-react'

import type { Converted, Exchange } from '@spendle/server/api'

import { formatCurrency } from '#/lib/currency'
import { formatShortDate } from '#/lib/period'
import { cn } from '#/lib/utils'

const rateFormat = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

/** `USD 1 = R$ 5,2238` for a rate in reais per unit × 1 000 000. */
export function formatRate(currency: string, rateMicros: number) {
  return `${currency} 1 = ${rateFormat.format(rateMicros / 1_000_000)}`
}

/** How a converted value was converted, for accessible names and titles. */
export function describeConversion(converted: Converted) {
  return `Convertido de ${formatCurrency(
    Math.abs(converted.originalCents),
    converted.currency,
  )} a ${formatRate(converted.currency, converted.rateMicros)} (${converted.source}, ${formatShortDate(converted.rateDate)})`
}

/** The amount in reais beside a value in another currency, marked as converted. */
export function ConvertedAmount({
  converted,
  className,
}: {
  converted: Converted | null
  className?: string
}) {
  if (converted === null) return null
  const { cents } = converted
  const description = describeConversion(converted)
  return (
    <span
      className={cn(
        'flex items-center justify-end gap-1 text-xs font-normal text-muted-foreground',
        className,
      )}
      title={description}
      aria-label={`${formatCurrency(cents)}. ${description}`}
    >
      <ArrowLeftRight className="size-3" aria-hidden="true" />
      <span aria-hidden="true">≈ {formatCurrency(cents)}</span>
    </span>
  )
}

/**
 * Which rates the totals beside it used, and which currencies stay out
 * for lack of one. Renders nothing when everything is in reais.
 */
export function ExchangeNote({
  exchange,
  className,
}: {
  exchange: Exchange
  className?: string
}) {
  if (exchange.rates.length === 0 && exchange.missing.length === 0) return null
  return (
    <p
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground',
        className,
      )}
    >
      <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
      {exchange.rates.map((rate) => (
        <span key={rate.currency}>
          {rate.currency} em reais ·{' '}
          {formatRate(rate.currency, rate.rateMicros)} ({rate.source},{' '}
          {formatShortDate(rate.date)})
        </span>
      ))}
      {exchange.missing.length > 0 && (
        <span className="text-warning">
          {exchange.missing.join(', ')} sem cotação, fora dos totais
        </span>
      )}
    </p>
  )
}
