import { CircleAlert } from 'lucide-react'

import { Button } from '#/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '#/components/ui/combobox'
import { groupCategoryOptions } from '#/lib/categories'
import type { CategoryOption } from '#/lib/categories'
import { cn } from '#/lib/utils'

interface CategorySelectProps {
  categories: CategoryOption[]
  value?: string | null
  onValueChange?: (categoryId: string) => void
  allowTransfer?: boolean
  disabled?: boolean
  className?: string
  /** `ghost`: sem borda até o hover, com ponto na cor da categoria. Para listas densas. */
  variant?: 'default' | 'ghost'
  'aria-label': string
}

export function CategorySelect({
  categories,
  value,
  onValueChange,
  allowTransfer = true,
  disabled,
  className,
  variant = 'default',
  'aria-label': ariaLabel,
}: CategorySelectProps) {
  const availableCategories = allowTransfer
    ? categories
    : categories.filter((category) => category.id !== 'transfer')
  const groups = groupCategoryOptions(availableCategories)
  // Base UI filters grouped items and hides groups left without matches.
  const items = [
    { value: 'Receitas', items: groups.income },
    { value: 'Despesas', items: groups.expenses },
  ]
  const selected =
    availableCategories.find((category) => category.id === value) ?? null
  const uncategorized = !value || value === 'uncategorized'

  return (
    <Combobox
      items={items}
      value={selected}
      disabled={disabled}
      itemToStringLabel={(category) => category.name}
      isItemEqualToValue={(item, current) => item.id === current.id}
      onValueChange={(category) => {
        if (category) onValueChange?.(category.id)
      }}
    >
      <ComboboxTrigger
        aria-label={ariaLabel}
        render={
          <Button
            variant={variant === 'ghost' ? 'ghost' : 'outline'}
            size={variant === 'ghost' ? 'sm' : 'default'}
            className={cn(
              'justify-between text-sm font-normal',
              variant === 'ghost'
                ? 'max-w-full hover:border-input hover:bg-muted/50 aria-expanded:border-input aria-expanded:bg-muted/50'
                : 'w-full',
              variant === 'ghost' &&
                uncategorized &&
                'bg-amber-50 text-amber-900 hover:border-amber-200 hover:bg-amber-100',
              className,
            )}
          />
        }
      >
        {variant === 'ghost' &&
          (uncategorized ? (
            <CircleAlert className="size-3.5 text-amber-600" />
          ) : (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: selected?.color ?? '#94a3b8' }}
            />
          ))}
        <span className="flex-1 truncate text-left">
          <ComboboxValue placeholder="Selecione uma categoria" />
        </span>
      </ComboboxTrigger>
      <ComboboxContent className="min-w-56">
        <ComboboxInput showTrigger={false} placeholder="Buscar categoria" />
        <ComboboxEmpty>Nenhuma categoria encontrada.</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof items)[number]) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(category: CategoryOption) => (
                  <ComboboxItem key={category.id} value={category}>
                    {category.name}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
