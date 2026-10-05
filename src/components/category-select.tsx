import { CircleAlert } from 'lucide-react'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { groupCategoryOptions } from '#/lib/categories'
import type { CategoryOption } from '#/lib/categories'
import { cn } from '#/lib/utils'

interface CategorySelectProps {
  categories: CategoryOption[]
  value?: string | null
  defaultValue?: string | null
  onValueChange?: (categoryId: string) => void
  allowTransfer?: boolean
  name?: string
  required?: boolean
  disabled?: boolean
  className?: string
  /** `ghost`: sem borda até o hover, com ponto na cor da categoria. Para listas densas. */
  variant?: 'default' | 'ghost'
  'aria-label': string
}

export function CategorySelect({
  categories,
  value,
  defaultValue,
  onValueChange,
  allowTransfer = true,
  name,
  required,
  disabled,
  className,
  variant = 'default',
  'aria-label': ariaLabel,
}: CategorySelectProps) {
  const availableCategories = allowTransfer
    ? categories
    : categories.filter((category) => category.id !== 'transfer')
  const groups = groupCategoryOptions(availableCategories)
  const items = [...groups.income, ...groups.expenses].map((category) => ({
    label: category.name,
    value: category.id,
  }))
  const currentId = value ?? defaultValue ?? null
  const uncategorized = !currentId || currentId === 'uncategorized'
  const currentColor =
    availableCategories.find((category) => category.id === currentId)?.color ??
    '#94a3b8'

  return (
    <Select
      items={items}
      value={value}
      defaultValue={defaultValue}
      name={name}
      required={required}
      disabled={disabled}
      onValueChange={(categoryId) => {
        if (categoryId) onValueChange?.(categoryId)
      }}
    >
      <SelectTrigger
        size={variant === 'ghost' ? 'sm' : 'default'}
        className={cn(
          variant === 'ghost'
            ? 'max-w-full border-transparent shadow-none hover:border-input hover:bg-muted/50 data-popup-open:border-input data-popup-open:bg-muted/50'
            : 'w-full',
          variant === 'ghost' &&
            uncategorized &&
            'bg-amber-50 text-amber-900 hover:border-amber-200 hover:bg-amber-100',
          className,
        )}
        aria-label={ariaLabel}
      >
        {variant === 'ghost' &&
          (uncategorized ? (
            <CircleAlert className="size-3.5 text-amber-600" />
          ) : (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: currentColor }}
            />
          ))}
        <SelectValue placeholder="Selecione uma categoria" />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectLabel>Receitas</SelectLabel>
          {groups.income.map((category) => (
            <SelectItem key={category.id} value={category.id}>
              {category.name}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Despesas</SelectLabel>
          {groups.expenses.map((category) => (
            <SelectItem key={category.id} value={category.id}>
              {category.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
