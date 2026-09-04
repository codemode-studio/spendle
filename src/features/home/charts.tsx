import { useEffect, useRef, useState } from 'react'

import type { CashPoint, CategoryShare } from './insights'

/**
 * Largura do contêiner medida no cliente. Fica `null` durante a renderização
 * no servidor e na hidratação, para o SVG só ser desenhado com a medida real.
 */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next) setWidth(next)
    })
    observer.observe(node)
    setWidth(node.getBoundingClientRect().width || 640)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

export function compactBRL(cents: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100)
}

function niceStep(range: number, count: number) {
  const raw = range / count
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude)
  return candidates.find((c) => c >= raw) ?? candidates[candidates.length - 1]
}

const LINE = '#1f9d63'
const LINE_FUTURE = '#b9c0c9'
const AXIS = '#8a929c'
const GRID = '#eef0f2'

export function CashChart({
  points,
  todayIndex,
  height: baseHeight = 232,
  formatCents,
  formatDate,
}: {
  points: Array<CashPoint>
  todayIndex: number
  height?: number
  formatCents: (cents: number) => string
  formatDate: (iso: string) => string
}) {
  const { ref, width: measured } = useContainerWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  // Gráfico mais baixo em telas estreitas para não dominar a tela.
  const height =
    measured !== null && measured < 480
      ? Math.round(baseHeight * 0.8)
      : baseHeight
  if (measured === null) {
    return <div ref={ref} style={{ height }} aria-hidden="true" />
  }
  return (
    <CashChartBody
      containerRef={ref}
      width={measured}
      points={points}
      todayIndex={todayIndex}
      height={height}
      formatCents={formatCents}
      formatDate={formatDate}
      hover={hover}
      setHover={setHover}
    />
  )
}

function CashChartBody({
  containerRef,
  width,
  points,
  todayIndex,
  height,
  formatCents,
  formatDate,
  hover,
  setHover,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  width: number
  points: Array<CashPoint>
  todayIndex: number
  height: number
  formatCents: (cents: number) => string
  formatDate: (iso: string) => string
  hover: number | null
  setHover: (value: number | null) => void
}) {
  const pad = { top: 18, right: 16, bottom: 28, left: 8 }
  const innerW = Math.max(width - pad.left - pad.right, 10)
  const innerH = height - pad.top - pad.bottom
  const values = points.flatMap((p) => [
    p.balanceCents,
    p.lowCents ?? p.balanceCents,
    p.highCents ?? p.balanceCents,
  ])
  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(...values, 1)
  const step = niceStep(rawMax - rawMin, 4)
  const yMin = Math.floor(rawMin / step) * step
  const yMax = Math.ceil(rawMax / step) * step
  const ticks: Array<number> = []
  for (let v = yMin; v <= yMax; v += step) ticks.push(v)

  const x = (i: number) =>
    pad.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : 0)
  const y = (v: number) =>
    pad.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH

  const past = points.slice(0, todayIndex + 1)
  const future = points.slice(todayIndex)
  const line = (list: Array<CashPoint>, offset: number) =>
    list
      .map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'}${x(i + offset).toFixed(1)},${y(p.balanceCents).toFixed(1)}`,
      )
      .join(' ')
  const pastPath = line(past, 0)
  const futurePath = line(future, todayIndex)
  const areaPath = `${pastPath} L${x(todayIndex).toFixed(1)},${y(yMin).toFixed(1)} L${x(0).toFixed(1)},${y(yMin).toFixed(1)} Z`
  const bandPath = future.length
    ? `${future.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i + todayIndex).toFixed(1)},${y(p.highCents ?? p.balanceCents).toFixed(1)}`).join(' ')} ${[
        ...future,
      ]
        .reverse()
        .map(
          (p, i) =>
            `L${x(future.length - 1 - i + todayIndex).toFixed(1)},${y(p.lowCents ?? p.balanceCents).toFixed(1)}`,
        )
        .join(' ')} Z`
    : ''

  // Um rótulo por mês no eixo x.
  const monthTicks = points
    .map((p, i) => ({ p, i }))
    .filter(
      ({ p, i }) =>
        i === 0 || p.date.slice(0, 7) !== points[i - 1].date.slice(0, 7),
    )
    .filter(({ i }) => i === 0 || i > 6)
    .map(({ p, i }) => ({
      i,
      label: new Intl.DateTimeFormat('pt-BR', {
        month: 'short',
        timeZone: 'UTC',
      })
        .format(new Date(`${p.date}T12:00:00Z`))
        .replace('.', ''),
    }))

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left - pad.left
    const i = Math.round((px / innerW) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }

  const active = hover ?? todayIndex
  const activePoint = points[active]
  const reference = points[todayIndex]
  const delta = activePoint.balanceCents - reference.balanceCents
  const tooltipLeft = Math.min(Math.max(x(active), 90), width - 90)

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <div
        className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-xl border border-border bg-background px-3 py-2 text-xs shadow-sm"
        style={{ left: tooltipLeft, top: 0 }}
      >
        <div className="text-muted-foreground">
          {formatDate(activePoint.date)}
          {active === todayIndex
            ? ' · hoje'
            : active > todayIndex
              ? ' · projeção'
              : ''}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-semibold tabular-nums">
          <span
            className="inline-block size-2.5 rounded-full border-2"
            style={{ borderColor: active > todayIndex ? LINE_FUTURE : LINE }}
          />
          {formatCents(activePoint.balanceCents)}
          {active !== todayIndex && (
            <span
              className={
                delta >= 0
                  ? 'font-medium text-emerald-700'
                  : 'font-medium text-red-700'
              }
            >
              {delta >= 0 ? '+' : '−'}
              {formatCents(Math.abs(delta))}
            </span>
          )}
        </div>
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Caixa da família: histórico e projeção"
        className="block touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="cash-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={LINE} stopOpacity={0.16} />
            <stop offset="100%" stopColor={LINE} stopOpacity={0} />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? AXIS : GRID}
              strokeWidth={1}
              strokeDasharray={tick === 0 && yMin < 0 ? '3 3' : undefined}
            />
          </g>
        ))}
        {bandPath && <path d={bandPath} fill={LINE_FUTURE} opacity={0.18} />}
        <path d={areaPath} fill="url(#cash-area)" />
        <path
          d={futurePath}
          fill="none"
          stroke={LINE_FUTURE}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={pastPath}
          fill="none"
          stroke={LINE}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line
          x1={x(todayIndex)}
          x2={x(todayIndex)}
          y1={pad.top}
          y2={pad.top + innerH}
          stroke={AXIS}
          strokeWidth={1}
          strokeDasharray="3 4"
          opacity={0.6}
        />
        {hover !== null && hover !== todayIndex && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={pad.top}
            y2={pad.top + innerH}
            stroke={AXIS}
            strokeWidth={1}
            opacity={0.5}
          />
        )}
        <circle
          cx={x(active)}
          cy={y(activePoint.balanceCents)}
          r={10}
          fill={active > todayIndex ? LINE_FUTURE : LINE}
          opacity={0.2}
        />
        <circle
          cx={x(active)}
          cy={y(activePoint.balanceCents)}
          r={4.5}
          fill={active > todayIndex ? LINE_FUTURE : LINE}
          stroke="#fff"
          strokeWidth={2}
        />
        {monthTicks.map(({ i, label }) => (
          <text
            key={i}
            x={x(i)}
            y={height - 8}
            fontSize={11}
            fill={AXIS}
            textAnchor={i === 0 ? 'start' : 'middle'}
          >
            {label}
          </text>
        ))}
        {ticks
          .filter((_, index) => index > 0 && index < ticks.length)
          .map((tick) => (
            <text
              key={`y-${tick}`}
              x={width - pad.right}
              y={y(tick) - 4}
              fontSize={10}
              fill={AXIS}
              textAnchor="end"
            >
              {compactBRL(tick)}
            </text>
          ))}
      </svg>
    </div>
  )
}

export function CategoryBar({ items }: { items: Array<CategoryShare> }) {
  const visible = items.filter((item) => item.share > 0)
  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
      {visible.map((item) => (
        <div
          key={item.id}
          title={`${item.name}: ${Math.round(item.share * 100)}%`}
          className="h-full min-w-1 rounded-full"
          style={{ width: `${item.share * 100}%`, background: item.color }}
        />
      ))}
    </div>
  )
}
