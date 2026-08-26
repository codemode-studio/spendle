import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { groupCategoryOptions } from '#/domain/categories'
import type { CategoryOption } from '#/domain/categories'
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
      <SelectTrigger className={cn('w-full', className)} aria-label={ariaLabel}>
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
