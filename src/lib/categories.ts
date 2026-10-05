export interface CategoryOption {
  id: string
  name: string
  bucket: string
  active?: boolean
  color?: string
}

export function groupCategoryOptions(categories: CategoryOption[]) {
  const visibleCategories = categories
    .filter((category) => category.active !== false)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'))

  return {
    income: visibleCategories.filter(
      (category) => category.bucket === 'income',
    ),
    expenses: visibleCategories.filter(
      (category) => category.bucket !== 'income',
    ),
  }
}
