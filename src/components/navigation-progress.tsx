import { useHydrated, useRouterState } from '@tanstack/react-router'

import { cn } from '#/lib/utils'

/**
 * Thin bar at the top of the viewport while a client navigation loads.
 *
 * The server renders while the router is still `pending`, but the client
 * hydrates an `idle` router, so the bar stays hidden until hydration finishes
 * and both renders produce the same markup.
 */
export function NavigationProgress() {
  const hydrated = useHydrated()
  const pending = useRouterState({
    select: (state) => state.status === 'pending',
  })
  const navigating = hydrated && pending

  return (
    <div
      aria-hidden="true"
      className={cn(
        'fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-primary transition-transform duration-200',
        navigating ? 'scale-x-100' : 'scale-x-0',
      )}
    />
  )
}
