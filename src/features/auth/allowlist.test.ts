import { expect, it } from 'vite-plus/test'

import { isAllowedEmail, parseAllowedEmails } from './allowlist'

it('allows listed emails regardless of case or separators', () => {
  const allowed = parseAllowedEmails(' Ana@Example.com,\nbeto@example.com  ')
  expect(isAllowedEmail('ana@example.com', allowed)).toBe(true)
  expect(isAllowedEmail('BETO@example.com', allowed)).toBe(true)
  expect(isAllowedEmail('carla@example.com', allowed)).toBe(false)
})

it('allows no one when the list is missing or blank', () => {
  expect(isAllowedEmail('ana@example.com', parseAllowedEmails(undefined))).toBe(
    false,
  )
  expect(isAllowedEmail('', parseAllowedEmails(' , '))).toBe(false)
})
