import { Pencil } from 'lucide-react'

import { OpenFinanceLogo } from '#/components/open-finance-logo'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

export interface InstrumentMetric {
  label: string
  value: string
  caption?: string
}

/**
 * Card padrão de conta ou cartão: cabeçalho com as ações em ícones,
 * até três métricas e uma linha de status em badges. Uma conta que vem do
 * Open Finance leva o símbolo dele antes do título.
 */
export function InstrumentCard({
  title,
  subtitle,
  editLabel,
  onEdit,
  metrics,
  status,
  actions,
  linked = false,
}: {
  title: string
  subtitle: string
  editLabel: string
  onEdit: () => void
  metrics: InstrumentMetric[]
  status?: React.ReactNode
  /** Ações extras em ícone, exibidas antes do botão de editar. */
  actions?: React.ReactNode
  /** Sincronizada pelo Open Finance. */
  linked?: boolean
}) {
  const columns =
    metrics.length === 2
      ? 'grid-cols-2'
      : metrics.length >= 3
        ? 'sm:grid-cols-3'
        : undefined
  const divider =
    metrics.length === 2
      ? 'border-l border-border pl-4'
      : metrics.length >= 3
        ? 'sm:border-l sm:border-border sm:pl-4'
        : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {linked ? (
            <span
              title="Sincronizada pelo Open Finance"
              className="flex shrink-0"
            >
              <OpenFinanceLogo
                role="img"
                aria-hidden={false}
                aria-label="Sincronizada pelo Open Finance"
                className="size-4"
              />
            </span>
          ) : null}
          {title}
        </CardTitle>
        <CardDescription>{subtitle}</CardDescription>
        <CardAction className="flex items-center gap-0.5">
          {actions}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={editLabel}
                  onClick={onEdit}
                />
              }
            >
              <Pencil />
            </TooltipTrigger>
            <TooltipContent>Editar</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className={cn('grid gap-4', columns)}>
          {metrics.map((metric, index) => (
            <div
              key={metric.label}
              className={cn(
                'flex min-w-0 flex-col gap-1',
                index > 0 && divider,
              )}
            >
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd className="font-mono text-xl tabular-nums">{metric.value}</dd>
              {metric.caption && (
                <dd className="text-xs text-muted-foreground">
                  {metric.caption}
                </dd>
              )}
            </div>
          ))}
        </dl>
        {status ? (
          <div className="flex flex-wrap items-center gap-1.5">{status}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}
