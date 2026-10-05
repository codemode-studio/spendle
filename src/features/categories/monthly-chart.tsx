import { useId, useState } from 'react'

import { formatCurrency } from '#/lib/currency'
import { compactBRL, useContainerWidth } from '#/features/home/charts'
import { cn } from '#/lib/utils'

import type { CategoryTrend, MonthPoint } from './analysis'

const OTHER_COLOR = '#94a3b8'
const MAX_SERIES = 7

interface Series {
  id: string
  name: string
  color: string
  monthly: Array<number>
  cents: number
}

/** Até 7 categorias com cor própria; o resto vira "Outras" (cinza). */
export function stackSeries(items: Array<CategoryTrend>): Array<Series> {
  const ranked = items.filter((item) => item.cents > 0)
  if (ranked.length <= MAX_SERIES) return ranked
  const head = ranked.slice(0, MAX_SERIES - 1)
  const tail = ranked.slice(MAX_SERIES - 1)
  const monthly = tail[0].monthly.map((_, index) =>
    tail.reduce((sum, item) => sum + (item.monthly[index] ?? 0), 0),
  )
  return [
    ...head,
    {
      id: 'other',
      name: `Outras (${tail.length})`,
      color: OTHER_COLOR,
      monthly,
      cents: tail.reduce((sum, item) => sum + item.cents, 0),
    },
  ]
}

function niceStep(max: number, ticks: number) {
  const raw = max / ticks
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  const candidates = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude)
  return candidates.find((step) => step >= raw) ?? candidates[4]
}

const HEIGHT = 240
const PAD = { top: 22, right: 8, bottom: 26, left: 8 }
const MAX_BAR = 40

/**
 * Colunas mensais empilhadas por categoria. Com `highlightId`, a categoria
 * fica na cor dela e as outras em cinza (ênfase), sem mudar de lugar.
 */
export function StackedMonthly({
  months,
  items,
  highlightId,
  onHighlight,
}: {
  months: Array<MonthPoint>
  items: Array<CategoryTrend>
  highlightId: string | null
  onHighlight: (id: string | null) => void
}) {
  const { ref, width } = useContainerWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const series = stackSeries(items)
  if (months.length === 0 || series.length === 0) return null

  const max = Math.max(...months.map((month) => month.cents), 1)
  const step = niceStep(max, 4)
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step)
  const plotWidth = (width ?? 640) - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const band = plotWidth / months.length
  const bar = Math.min(MAX_BAR, band * 0.6)
  const y = (cents: number) => PAD.top + plotHeight - (cents / top) * plotHeight
  const highlighted = highlightId
    ? (series.find((entry) => entry.id === highlightId) ?? null)
    : null

  const tooltip =
    hover !== null
      ? {
          month: months[hover],
          rows: series
            .map((entry) => ({ entry, cents: entry.monthly[hover] ?? 0 }))
            .filter((row) => row.cents > 0)
            .sort((left, right) => right.cents - left.cents),
        }
      : null

  return (
    <div ref={ref} className="relative w-full">
      {width === null ? (
        <div style={{ height: HEIGHT }} />
      ) : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-labelledby={`${id}-title`}
          className="block overflow-visible"
          onMouseLeave={() => setHover(null)}
        >
          <title id={`${id}-title`}>
            Gasto mensal por categoria
            {highlighted ? `, com ${highlighted.name} em destaque` : ''}
          </title>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={PAD.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth={1}
              />
              {tick > 0 && (
                <text
                  x={PAD.left + plotWidth}
                  y={y(tick) - 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {compactBRL(tick)}
                </text>
              )}
            </g>
          ))}
          {months.map((month, index) => {
            const x = PAD.left + band * index + (band - bar) / 2
            const isActive = hover === index
            let cursor = 0
            return (
              <g key={month.key}>
                {series.map((entry) => {
                  const cents = entry.monthly[index] ?? 0
                  if (cents <= 0) return null
                  const y0 = y(cursor)
                  cursor += cents
                  const y1 = y(cursor)
                  const dimmed =
                    highlightId !== null && entry.id !== highlightId
                  return (
                    <rect
                      key={entry.id}
                      x={x}
                      y={y1}
                      width={bar}
                      height={Math.max(y0 - y1, 0)}
                      fill={dimmed ? OTHER_COLOR : entry.color}
                      fillOpacity={dimmed ? 0.3 : month.partial ? 0.75 : 1}
                      stroke="var(--card)"
                      strokeWidth={2}
                      paintOrder="stroke"
                      className="transition-[fill,fill-opacity] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]"
                    />
                  )
                })}
                {month.cents > 0 && band >= 56 && (
                  <text
                    x={x + bar / 2}
                    y={y(month.cents) - 6}
                    textAnchor="middle"
                    className={cn(
                      'text-[11px] tabular-nums',
                      isActive
                        ? 'fill-foreground font-medium'
                        : 'fill-muted-foreground',
                    )}
                  >
                    {compactBRL(
                      highlighted
                        ? (highlighted.monthly[index] ?? 0)
                        : month.cents,
                    )}
                  </text>
                )}
                <text
                  x={x + bar / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className={
                    isActive
                      ? 'fill-foreground text-[11px] font-medium'
                      : 'fill-muted-foreground text-[11px]'
                  }
                >
                  {month.label}
                  {month.partial ? '*' : ''}
                </text>
                <rect
                  x={PAD.left + band * index}
                  y={PAD.top}
                  width={band}
                  height={plotHeight}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${month.fullLabel}: ${formatCurrency(month.cents)}`}
                  onMouseEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                  className="outline-none focus-visible:stroke-ring"
                />
              </g>
            )
          })}
        </svg>
      )}
      {tooltip && width !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 w-56 rounded-lg border bg-popover p-2.5 text-xs shadow-md"
          style={{
            left: Math.min(
              Math.max(PAD.left + band * hover! + band / 2 - 112, 0),
              width - 224,
            ),
          }}
        >
          <p className="flex justify-between font-medium capitalize">
            <span>
              {tooltip.month.fullLabel}
              {tooltip.month.partial && (
                <span className="ml-1 font-normal text-muted-foreground">
                  (parcial)
                </span>
              )}
            </span>
            <span className="tabular-nums">
              {formatCurrency(tooltip.month.cents)}
            </span>
          </p>
          {tooltip.rows.map(({ entry, cents }) => (
            <p
              key={entry.id}
              className={cn(
                'mt-0.5 flex justify-between gap-2 tabular-nums',
                highlightId !== null &&
                  entry.id !== highlightId &&
                  'text-muted-foreground',
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: entry.color }}
                />
                <span className="truncate">{entry.name}</span>
              </span>
              <span>{formatCurrency(cents)}</span>
            </p>
          ))}
        </div>
      )}
      <ul
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5"
        aria-label="Legenda"
      >
        {series.map((entry) => {
          const dimmed = highlightId !== null && entry.id !== highlightId
          return (
            <li key={entry.id}>
              <button
                type="button"
                aria-pressed={highlightId === entry.id}
                onClick={() =>
                  onHighlight(highlightId === entry.id ? null : entry.id)
                }
                className={cn(
                  'flex items-center gap-1.5 rounded-md text-xs transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transform-none',
                  dimmed ? 'text-muted-foreground/60' : 'text-foreground',
                )}
              >
                <span
                  className="size-2 rounded-full"
                  style={{
                    background: dimmed ? OTHER_COLOR : entry.color,
                    opacity: dimmed ? 0.5 : 1,
                  }}
                />
                {entry.name}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Mapa de calor categoria × mês: um tom só, mais escuro = mais gasto.
 * Legível com qualquer visão de cores e mostra em que mês cada categoria
 * pesou.
 */
export function CategoryHeatmap({
  months,
  items,
  highlightId,
  onHighlight,
}: {
  months: Array<MonthPoint>
  items: Array<CategoryTrend>
  highlightId: string | null
  onHighlight: (id: string | null) => void
}) {
  const rows = items.filter((item) => item.cents > 0)
  if (rows.length === 0 || months.length === 0) return null
  const max = Math.max(...rows.flatMap((item) => item.monthly), 1)
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-y-0.5 text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="w-44 pb-1 text-left font-medium">Categoria</th>
            {months.map((month) => (
              <th
                key={month.key}
                className="pb-1 text-center font-medium capitalize"
              >
                {month.label}
                {month.partial ? '*' : ''}
              </th>
            ))}
            <th className="w-24 pb-1 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const selected = highlightId === item.id
            const dimmed = highlightId !== null && !selected
            return (
              <tr
                key={item.id}
                className={cn(
                  'transition-opacity duration-150',
                  dimmed && 'opacity-40',
                )}
              >
                <th scope="row" className="pr-3 text-left font-normal">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onHighlight(selected ? null : item.id)}
                    className="flex max-w-full items-center gap-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                    />
                    <span className={cn('truncate', selected && 'font-medium')}>
                      {item.name}
                    </span>
                  </button>
                </th>
                {item.monthly.map((cents, index) => {
                  const intensity = cents / max
                  const dark = intensity > 0.55
                  return (
                    <td key={months[index]?.key} className="px-0.5">
                      <div
                        title={`${item.name} · ${months[index]?.fullLabel}: ${formatCurrency(cents)}`}
                        className={cn(
                          'flex h-8 items-center justify-center rounded-md tabular-nums',
                          cents === 0 && 'text-muted-foreground/50',
                          dark ? 'text-primary-foreground' : 'text-foreground',
                        )}
                        style={{
                          background:
                            cents === 0
                              ? 'var(--muted)'
                              : `color-mix(in oklab, var(--primary) ${Math.round(
                                  12 + intensity * 88,
                                )}%, var(--card))`,
                        }}
                      >
                        {cents === 0 ? '·' : compactBRL(cents)}
                      </div>
                    </td>
                  )
                })}
                <td className="pl-3 text-right font-medium tabular-nums">
                  {formatCurrency(item.cents)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Linha de 2px com ponto final de 8px, na cor da categoria. */
export function Sparkline({
  values,
  color,
  className,
}: {
  values: Array<number>
  color: string
  className?: string
}) {
  const width = 72
  const height = 20
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const stepX = (width - 8) / (values.length - 1)
  const points = values.map((value, index) => ({
    x: 4 + index * stepX,
    y: 4 + (1 - value / max) * (height - 8),
  }))
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
    .join(' ')
  const last = points[points.length - 1]
  return (
    <svg width={width} height={height} aria-hidden="true" className={className}>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={last.x}
        cy={last.y}
        r={4}
        fill={color}
        stroke="var(--card)"
        strokeWidth={2}
      />
    </svg>
  )
}
