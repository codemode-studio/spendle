// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { readAccountForm } from './account-form'
import { AccountFormFields } from './accounts-section'
import { readCardForm } from './card-form'

afterEach(cleanup)

const scopes = [{ id: 'household', name: 'Família' }]
const reserve = {
  id: 'acc-1',
  name: 'Reserva',
  institution: {
    id: 'inst-1',
    name: 'Nubank',
    country: 'BR',
    createdAt: new Date(0),
  },
  ownershipScopeId: 'household',
  kind: 'savings' as const,
  purpose: 'reserve' as const,
  currency: 'BRL',
}

function mount() {
  render(
    <form data-testid="form">
      <AccountFormFields scopes={scopes} account={reserve} />
    </form>,
  )
  return () =>
    readAccountForm(new FormData(screen.getByTestId<HTMLFormElement>('form')))
}

it('keeps a savings reserve when only the name is edited', () => {
  const read = mount()
  fireEvent.change(screen.getByLabelText('Nome'), {
    target: { value: 'Reserva da família' },
  })
  expect(read()).toMatchObject({
    name: 'Reserva da família',
    kind: 'savings',
    purpose: 'reserve',
  })
})

it('locks the purpose to investments for a brokerage account', () => {
  const read = mount()
  fireEvent.change(screen.getByLabelText('Tipo'), {
    target: { value: 'investment' },
  })
  const purpose = screen.getByLabelText<HTMLSelectElement>('Finalidade')
  expect([purpose.disabled, purpose.value]).toEqual([true, 'investment'])
  expect(read()).toMatchObject({ kind: 'investment', purpose: 'investment' })
})

it('saves a card with no due day instead of rejecting the edit', () => {
  const form = new FormData()
  for (const [key, value] of Object.entries({
    name: 'Ultravioleta',
    institutionName: 'Nubank',
    ownershipScopeId: 'household',
    currency: 'BRL',
    limit: '1.000,00',
    closingDay: '3',
    dueDay: '',
  }))
    form.set(key, value)
  expect(readCardForm(form)).toMatchObject({
    name: 'Ultravioleta',
    dueDay: undefined,
    limitCents: 100000,
  })
})
