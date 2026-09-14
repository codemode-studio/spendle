import { z } from 'zod'

const pluggyEnvironmentSchema = z.object({
  PLUGGY_CLIENT_ID: z.string().trim().optional(),
  PLUGGY_CLIENT_SECRET: z.string().trim().optional(),
  PLUGGY_WEBHOOK_URL: z.string().trim().optional(),
  PLUGGY_WEBHOOK_SECRET: z.string().trim().optional(),
  PLUGGY_INCLUDE_SANDBOX: z.string().trim().optional(),
  NODE_ENV: z.string().trim().optional(),
  FINANCAS_QA: z.string().trim().optional(),
})

export interface PluggyConfiguration {
  enabled: boolean
  automaticSync: boolean
  clientId: string | null
  clientSecret: string | null
  webhookUrl: string | null
  webhookSecret: string | null
  includeSandbox: boolean
}

function optionalValue(value: string | undefined) {
  return value || null
}

export function parsePluggyConfiguration(
  environment: Record<string, string | undefined>,
): PluggyConfiguration {
  const parsed = pluggyEnvironmentSchema.parse(environment)
  const clientId = optionalValue(parsed.PLUGGY_CLIENT_ID)
  const clientSecret = optionalValue(parsed.PLUGGY_CLIENT_SECRET)
  const webhookUrl = optionalValue(parsed.PLUGGY_WEBHOOK_URL)
  const webhookSecret = optionalValue(parsed.PLUGGY_WEBHOOK_SECRET)

  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      'Configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET juntos, ou deixe ambos ausentes.',
    )
  }
  if (Boolean(webhookUrl) !== Boolean(webhookSecret)) {
    throw new Error(
      'Configure PLUGGY_WEBHOOK_URL e PLUGGY_WEBHOOK_SECRET juntos, ou deixe ambos ausentes.',
    )
  }
  if (webhookUrl && !clientId) {
    throw new Error(
      'O webhook da Pluggy exige PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET.',
    )
  }
  if (webhookUrl) {
    const url = z.url().parse(webhookUrl)
    if (!url.startsWith('https://')) {
      throw new Error('PLUGGY_WEBHOOK_URL deve usar HTTPS.')
    }
  }

  const sandboxValue = parsed.PLUGGY_INCLUDE_SANDBOX
  if (sandboxValue && sandboxValue !== '1') {
    throw new Error('PLUGGY_INCLUDE_SANDBOX aceita somente o valor 1.')
  }
  const includeSandbox = sandboxValue === '1'
  const isDevelopment =
    parsed.NODE_ENV !== 'production' || parsed.FINANCAS_QA === '1'
  if (includeSandbox && !isDevelopment) {
    throw new Error(
      'PLUGGY_INCLUDE_SANDBOX=1 só pode ser usado em desenvolvimento ou QA.',
    )
  }

  return {
    enabled: Boolean(clientId && clientSecret),
    automaticSync: Boolean(webhookUrl && webhookSecret),
    clientId,
    clientSecret,
    webhookUrl,
    webhookSecret,
    includeSandbox,
  }
}

export function getPluggyConfiguration() {
  return parsePluggyConfiguration(process.env)
}
