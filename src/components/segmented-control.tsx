import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '#/lib/utils'

export interface SegmentedItem {
  value: string
  label: string
  count?: number
  tone?: 'success' | 'destructive' | 'warning'
}

const toneDot = {
  success: 'bg-success',
  destructive: 'bg-destructive',
  warning: 'bg-warning',
} as const

/**
 * Controle segmentado com indicador deslizante. Em vez de animar cor por
 * botão, a lista é duplicada: a cópia "ativa" fica por cima recortada com
 * clip-path só no segmento selecionado, e o recorte anima entre segmentos.
 */
export function SegmentedControl({
  items,
  value,
  onValueChange,
  className,
  'aria-label': ariaLabel,
}: {
  items: SegmentedItem[]
  value: string
  onValueChange: (value: string) => void
  className?: string
  'aria-label': string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [clip, setClip] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const update = () => {
      const active = list.querySelector<HTMLElement>(
        `[data-value="${CSS.escape(value)}"]`,
      )
      if (!active) {
        setClip(null)
        return
      }
      const listRect = list.getBoundingClientRect()
      const rect = active.getBoundingClientRect()
      const left = rect.left - listRect.left
      const right = listRect.right - rect.right
      setClip(`inset(0 ${right}px 0 ${left}px round 6px)`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(list)
    return () => observer.disconnect()
  }, [value, items])

  // A transição só liga depois da primeira medição: nada de "deslizar" na carga.
  useEffect(() => {
    if (clip !== null && !ready) setReady(true)
  }, [clip, ready])

  const renderItems = (overlay: boolean) =>
    items.map((item) => {
      const selected = item.value === value
      return (
        <button
          key={item.value}
          type="button"
          role="radio"
          aria-checked={overlay ? undefined : selected}
          tabIndex={overlay ? -1 : undefined}
          data-value={item.value}
          onClick={overlay ? undefined : () => onValueChange(item.value)}
          className={cn(
            'inline-flex h-full shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none select-none md:text-[0.8rem]',
            overlay
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] pointer-fine:hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transform-none',
          )}
        >
          {item.tone && (
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full', toneDot[item.tone])}
            />
          )}
          {item.label}
          {item.count !== undefined && (
            <span
              className={cn(
                'tabular-nums',
                overlay ? 'text-muted-foreground' : 'text-muted-foreground/70',
              )}
            >
              {item.count}
            </span>
          )}
        </button>
      )
    })

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'relative inline-flex h-11 max-w-full items-stretch overflow-x-auto rounded-lg bg-muted p-[3px] md:h-8',
        className,
      )}
    >
      {renderItems(false)}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 flex items-stretch p-[3px] transition-[clip-path] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
          ready ? 'duration-200' : 'duration-0',
        )}
        style={{ clipPath: clip ?? 'inset(0 100% 0 0)' }}
      >
        {renderItems(true)}
      </div>
    </div>
  )
}
