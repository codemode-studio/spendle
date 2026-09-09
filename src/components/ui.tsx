import type { LucideIcon } from 'lucide-react'

import { Badge } from '#/components/ui/badge'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '#/components/ui/empty'
import { Progress } from '#/components/ui/progress'
import { cn } from '#/lib/utils'

/** Container padrão de página: largura máxima e respiro externo da escala. */
export function Page({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('mx-auto w-full max-w-[1250px] p-page', className)}>
      {children}
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="mb-5 flex flex-col items-start justify-between gap-4 sm:mb-6 md:flex-row md:items-start">
      <div>
        {eyebrow && (
          <span className="text-sm text-muted-foreground">{eyebrow}</span>
        )}
        <h1 className="font-heading mt-0.5 text-2xl font-semibold tracking-tight sm:text-3xl md:text-[2rem]">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2 md:pt-1">{actions}</div>}
    </header>
  )
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'default',
  className,
}: {
  label: string
  value: string
  detail: string
  icon: LucideIcon
  tone?: 'default' | 'positive' | 'warning' | 'negative'
  className?: string
}) {
  const badgeVariant =
    tone === 'negative'
      ? 'destructive'
      : tone === 'default'
        ? 'outline'
        : 'secondary'
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardAction>
          <Badge variant={badgeVariant}>
            <Icon />
          </Badge>
        </CardAction>
        <CardTitle className="text-xl tabular-nums md:text-2xl">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="hidden text-xs text-muted-foreground sm:block">
        {detail}
      </CardContent>
    </Card>
  )
}

export function Panel({
  title,
  description,
  action,
  children,
  footer,
  className,
}: {
  title?: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      {(title || action) && (
        <CardHeader
          className={
            action
              ? 'max-sm:grid-cols-1 max-sm:grid-rows-[auto_auto_auto]'
              : undefined
          }
        >
          {title && <CardTitle>{title}</CardTitle>}
          {description && (
            <CardDescription
              className={
                action ? 'max-sm:col-start-1 max-sm:row-start-2' : undefined
              }
            >
              {description}
            </CardDescription>
          )}
          {action && (
            <CardAction className="max-sm:col-start-1 max-sm:row-start-3 max-sm:mt-2 max-sm:justify-self-stretch">
              {action}
            </CardAction>
          )}
        </CardHeader>
      )}
      <CardContent className={footer ? 'flex-1' : undefined}>
        {children}
      </CardContent>
      {footer && <CardFooter className="justify-end">{footer}</CardFooter>}
    </Card>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}

export function ProgressBar({
  value,
  max,
  className,
}: {
  value: number
  max: number
  className?: string
  color?: string
}) {
  const percentage =
    max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <Progress
      value={percentage}
      className={className}
      aria-label={`${Math.round(percentage)}%`}
    />
  )
}

export function StatusBadge({
  tone = 'neutral',
  className,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, 'variant'> & {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
}) {
  return (
    <Badge
      variant={
        tone === 'danger'
          ? 'destructive'
          : tone === 'neutral'
            ? 'outline'
            : tone
      }
      className={cn(
        tone !== 'danger' &&
          tone !== 'warning' &&
          'h-auto rounded-none border-0 bg-transparent px-0 py-0 font-normal text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

/** Cabeçalho de seção dentro de uma página: título, descrição curta e ação. */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}
