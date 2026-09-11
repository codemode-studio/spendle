import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Panel } from '#/components/ui'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { reviewDestination } from './review'
import type { pendingReviewItems } from './review'

export function ReviewCard({
  items,
}: {
  items: ReturnType<typeof pendingReviewItems>
}) {
  if (!items.length) return null

  return (
    <Panel title="Revisar">
      <ul className="flex flex-col divide-y">
        {items.map((item) => (
          <li
            key={item.code}
            className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{item.label}</span>
                <Badge variant="secondary">{item.count}</Badge>
              </div>
              {item.detail && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {item.detail}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link {...reviewDestination(item.destination)} />}
            >
              {item.actionLabel}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
