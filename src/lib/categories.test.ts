import { describe, expect, it } from 'vite-plus/test'

import { groupCategoryOptions } from './categories'

describe('groupCategoryOptions', () => {
  it('separates income from expenses and sorts each group', () => {
    const groups = groupCategoryOptions([
      { id: 'travel', name: 'Viagens', bucket: 'lifestyle' },
      { id: 'salary', name: 'Salário', bucket: 'income' },
      { id: 'housing', name: 'Moradia', bucket: 'essential' },
      { id: 'rent', name: 'Aluguéis recebidos', bucket: 'income' },
    ])

    expect(groups.income.map((category) => category.id)).toEqual([
      'rent',
      'salary',
    ])
    expect(groups.expenses.map((category) => category.id)).toEqual([
      'housing',
      'travel',
    ])
  })

  it('omits inactive categories', () => {
    const groups = groupCategoryOptions([
      { id: 'active', name: 'Ativa', bucket: 'essential', active: true },
      { id: 'inactive', name: 'Inativa', bucket: 'income', active: false },
    ])

    expect(groups.income).toEqual([])
    expect(groups.expenses.map((category) => category.id)).toEqual(['active'])
  })
})
