import { cn } from '#/lib/utils'

export function SpendleLogo({
  variant,
  className,
}: Readonly<{
  variant: 'brandmark' | 'wordmark'
  className?: string
}>) {
  return (
    <span
      aria-hidden="true"
      className={cn('spendle-logo', `spendle-logo--${variant}`, className)}
    />
  )
}

/** Brandmark inside a rounded app-icon tile. */
export function SpendleTile({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'spendle-tile flex size-8 shrink-0 items-center justify-center rounded-[9px]',
        className,
      )}
    >
      <SpendleLogo variant="brandmark" className="size-[18px]" />
    </span>
  )
}

/** Tile + wordmark, the lockup used in app chrome. */
export function SpendleLockup({
  className,
  wordmarkClassName,
}: Readonly<{ className?: string; wordmarkClassName?: string }>) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <SpendleTile />
      <SpendleLogo
        variant="wordmark"
        className={cn('h-5 w-20 text-sidebar-primary', wordmarkClassName)}
      />
    </span>
  )
}
