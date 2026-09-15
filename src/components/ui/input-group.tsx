import * as React from 'react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { Textarea } from '#/components/ui/textarea.tsx'
import { cn } from '#/lib/utils.ts'

function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        'group/input-group relative flex h-8 w-full min-w-0 items-center rounded-lg border border-input bg-background shadow-xs transition-colors outline-none has-disabled:bg-input/50 has-disabled:opacity-50 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>textarea]:h-auto',
        className,
      )}
      {...props}
    />
  )
}

const inputGroupAddonVariants = cva(
  'flex h-auto cursor-text items-center gap-2 text-sm text-muted-foreground',
  {
    variants: {
      align: {
        'inline-start': 'order-first py-1.5 pl-2',
        'inline-end': 'order-last py-1.5 pr-2',
        'block-end': 'order-last w-full justify-end px-2 pb-2',
      },
    },
    defaultVariants: { align: 'inline-start' },
  },
)

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return
        event.currentTarget.parentElement
          ?.querySelector<HTMLElement>('textarea, input')
          ?.focus()
      }}
      {...props}
    />
  )
}

function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<'textarea'>) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        'min-h-12 max-h-32 flex-1 resize-none rounded-none border-0 bg-transparent px-3 py-3 shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent',
        className,
      )}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupTextarea }
