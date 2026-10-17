import { expect, it } from 'vite-plus/test'

import { safeRedirect } from './redirect'

it('keeps in-app paths with their query and hash', () => {
  expect(safeRedirect('/transacoes?category=food#top')).toBe(
    '/transacoes?category=food#top',
  )
})

it('rejects destinations that leave the app', () => {
  for (const value of [
    '//example.org',
    '/\\example.org',
    '/\\/example.org',
    'https://example.org',
    'example.org',
    '/.//example.org',
    '/%2e//example.org',
    '/foo/..//example.org',
  ]) {
    expect(safeRedirect(value)).toBeUndefined()
  }
})
