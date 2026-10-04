import { describe, expect, it } from 'vitest'

import { readAccountForm } from './account-form'

function form(fields: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

const base = {
  name: 'Reserva',
  institutionName: 'Banco',
  ownershipScopeId: 'household',
  currency: 'BRL',
}

describe('readAccountForm', () => {
  it('keeps a savings account set aside as a reserve', () => {
    expect(
      readAccountForm(form({ ...base, kind: 'savings', purpose: 'reserve' })),
    ).toMatchObject({ kind: 'savings', purpose: 'reserve' })
  })

  it('treats a brokerage account as an investment whatever the purpose field says', () => {
    expect(
      readAccountForm(
        form({ ...base, kind: 'investment', purpose: 'operating' }),
      ),
    ).toMatchObject({ kind: 'investment', purpose: 'investment' })
  })
})
