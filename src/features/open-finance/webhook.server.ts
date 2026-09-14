import { timingSafeEqual } from 'node:crypto'

import { getPluggyConfiguration } from './config.server'
import { pluggyWebhookSchema } from './normalization'
import { enqueuePluggyWebhook } from './open-finance.server'

const maximumBodyBytes = 64 * 1024

function authorized(header: string | null, secret: string) {
  if (!header) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const received = Buffer.from(header)
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  )
}

export async function handlePluggyWebhookRequest(request: Request) {
  let configuration
  try {
    configuration = getPluggyConfiguration()
  } catch {
    return Response.json({ error: 'Webhook não configurado.' }, { status: 503 })
  }
  if (!configuration.webhookSecret) {
    return Response.json({ error: 'Webhook não configurado.' }, { status: 503 })
  }
  if (
    !authorized(
      request.headers.get('authorization'),
      configuration.webhookSecret,
    )
  ) {
    return Response.json({ error: 'Não autorizado.' }, { status: 401 })
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (declaredLength > maximumBodyBytes) {
    return Response.json({ error: 'Payload muito grande.' }, { status: 413 })
  }
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > maximumBodyBytes) {
    return Response.json({ error: 'Payload muito grande.' }, { status: 413 })
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return Response.json({ error: 'JSON inválido.' }, { status: 400 })
  }
  const payload = pluggyWebhookSchema.safeParse(json)
  if (!payload.success) {
    return Response.json({ error: 'Evento inválido.' }, { status: 400 })
  }
  const result = await enqueuePluggyWebhook(payload.data)
  return Response.json(result, { status: 202 })
}
