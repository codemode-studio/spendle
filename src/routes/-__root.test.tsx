import { describe, expect, it } from 'vitest'

import { Route } from './__root'

describe('root route', () => {
  it('owns the fallback for unmatched URLs', () => {
    expect(Route.options.notFoundComponent).toEqual(expect.any(Function))
  })
})
