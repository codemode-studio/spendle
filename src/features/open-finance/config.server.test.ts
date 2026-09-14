import { describe, expect, it } from 'vitest'

import { parsePluggyConfiguration } from './config.server'

describe('parsePluggyConfiguration', () => {
  it('keeps the integration disabled when every optional value is absent', () => {
    expect(parsePluggyConfiguration({ NODE_ENV: 'production' })).toEqual({
      enabled: false,
      automaticSync: false,
      clientId: null,
      clientSecret: null,
      webhookUrl: null,
      webhookSecret: null,
      includeSandbox: false,
    })
  })

  it('accepts credentials without webhook for manual copy mode', () => {
    expect(
      parsePluggyConfiguration({
        PLUGGY_CLIENT_ID: 'client',
        PLUGGY_CLIENT_SECRET: 'secret',
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ enabled: true, automaticSync: false })
  })

  it.each([
    [{ PLUGGY_CLIENT_ID: 'client' }, 'PLUGGY_CLIENT_SECRET'],
    [{ PLUGGY_WEBHOOK_URL: 'https://example.com/hook' }, 'WEBHOOK_SECRET'],
    [
      {
        PLUGGY_CLIENT_ID: 'client',
        PLUGGY_CLIENT_SECRET: 'secret',
        PLUGGY_WEBHOOK_URL: 'http://example.com/hook',
        PLUGGY_WEBHOOK_SECRET: 'hook-secret',
      },
      'HTTPS',
    ],
  ])('rejects partial or unsafe configuration', (environment, message) => {
    expect(() =>
      parsePluggyConfiguration({ NODE_ENV: 'production', ...environment }),
    ).toThrow(message)
  })

  it('allows sandbox only outside production or in QA', () => {
    expect(
      parsePluggyConfiguration({
        PLUGGY_CLIENT_ID: 'client',
        PLUGGY_CLIENT_SECRET: 'secret',
        PLUGGY_INCLUDE_SANDBOX: '1',
        NODE_ENV: 'development',
      }).includeSandbox,
    ).toBe(true)
    expect(() =>
      parsePluggyConfiguration({
        PLUGGY_CLIENT_ID: 'client',
        PLUGGY_CLIENT_SECRET: 'secret',
        PLUGGY_INCLUDE_SANDBOX: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow('desenvolvimento ou QA')
  })
})
