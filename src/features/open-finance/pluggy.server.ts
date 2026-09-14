import type {
  Account,
  Item,
  Transaction,
  TransactionCursorFilters,
} from 'pluggy-sdk'
import { PluggyClient } from 'pluggy-sdk'

import { getPluggyConfiguration } from './config.server'

export interface PluggyGateway {
  createConnectToken: (input: {
    clientUserId: string
    itemId?: string
  }) => Promise<{ accessToken: string }>
  fetchItem: (itemId: string) => Promise<Item>
  fetchAccounts: (itemId: string) => Promise<Account[]>
  fetchAllTransactions: (
    accountId: string,
    filters?: Omit<TransactionCursorFilters, 'after'>,
  ) => Promise<Transaction[]>
  fetchTransactionsByIds: (
    accountId: string,
    transactionIds: string[],
  ) => Promise<Transaction[]>
  deleteItem: (itemId: string) => Promise<void>
  ensureWebhook: (input: { url: string; secret: string }) => Promise<void>
}

export class PluggyIntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'PluggyIntegrationError'
  }
}

function statusCodeFor(error: unknown) {
  if (!error || typeof error !== 'object') return null
  const response = Reflect.get(error, 'response')
  if (!response || typeof response !== 'object') return null
  const statusCode = Reflect.get(response, 'statusCode')
  return typeof statusCode === 'number' ? statusCode : null
}

function codeFor(error: unknown) {
  if (!error || typeof error !== 'object') return 'PLUGGY_UNEXPECTED_ERROR'
  const direct = Reflect.get(error, 'code')
  if (typeof direct === 'string') return direct
  const response = Reflect.get(error, 'response')
  const body =
    response && typeof response === 'object'
      ? Reflect.get(response, 'body')
      : null
  if (body && typeof body === 'object') {
    const bodyCode = Reflect.get(body, 'code')
    if (typeof bodyCode === 'string') return bodyCode
  }
  return 'PLUGGY_UNEXPECTED_ERROR'
}

function translatePluggyError(error: unknown) {
  const code = codeFor(error)
  const status = statusCodeFor(error)
  const retryable = status === 429 || Boolean(status && status >= 500)
  if (code === 'ITEM_NOT_FOUND' || status === 404) {
    return new PluggyIntegrationError(
      code,
      'A conexão não existe mais na Pluggy. Conecte a instituição novamente.',
      false,
    )
  }
  if (['ITEM_LOGIN_ERROR', 'INVALID_CREDENTIALS'].includes(code)) {
    return new PluggyIntegrationError(
      code,
      'A instituição pediu novas credenciais. Use Reconectar.',
      false,
    )
  }
  if (status === 429) {
    return new PluggyIntegrationError(
      code,
      'A Pluggy limitou as requisições. Tente novamente em instantes.',
      true,
    )
  }
  if (retryable) {
    return new PluggyIntegrationError(
      code,
      'A Pluggy está temporariamente indisponível. Tente novamente.',
      true,
    )
  }
  return new PluggyIntegrationError(
    code,
    'Não foi possível consultar a Pluggy. Tente novamente.',
    false,
  )
}

async function retryTransient<T>(operation: () => Promise<T>) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const translated = translatePluggyError(error)
      if (!translated.retryable || attempt === 2) throw translated
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt))
    }
  }
  throw translatePluggyError(lastError)
}

function cursorFromNext(next: string) {
  const cursor = new URL(next, 'https://api.pluggy.ai').searchParams.get(
    'after',
  )
  if (!cursor)
    throw new Error('A paginação da Pluggy retornou um cursor inválido.')
  return cursor
}

export function createPluggyGateway(client: PluggyClient): PluggyGateway {
  return {
    createConnectToken: ({ clientUserId, itemId }) =>
      retryTransient(() =>
        client.createConnectToken(itemId, {
          clientUserId,
          avoidDuplicates: true,
        }),
      ),
    fetchItem: (itemId) => retryTransient(() => client.fetchItem(itemId)),
    fetchAccounts: async (itemId) =>
      (await retryTransient(() => client.fetchAccounts(itemId))).results,
    fetchAllTransactions: async (accountId, filters = {}) => {
      const collected: Transaction[] = []
      let after: string | undefined
      do {
        const page = await retryTransient(() =>
          client.fetchTransactionsCursor(accountId, { ...filters, after }),
        )
        collected.push(...page.results)
        after = page.next ? cursorFromNext(page.next) : undefined
      } while (after)
      return collected
    },
    fetchTransactionsByIds: async (accountId, transactionIds) => {
      const collected: Transaction[] = []
      for (let offset = 0; offset < transactionIds.length; offset += 500) {
        const ids = transactionIds.slice(offset, offset + 500)
        collected.push(
          ...(await retryTransient(() =>
            client.fetchAllTransactions(accountId, { ids }),
          )),
        )
      }
      return collected
    },
    deleteItem: (itemId) => retryTransient(() => client.deleteItem(itemId)),
    ensureWebhook: async ({ url, secret }) => {
      const webhooks = await retryTransient(() => client.fetchWebhooks())
      const existing = webhooks.results.find(
        (webhook) => webhook.url === url && webhook.event === 'all',
      )
      if (existing) {
        await retryTransient(() =>
          client.updateWebhook(existing.id, {
            url,
            event: 'all',
            headers: { Authorization: `Bearer ${secret}` },
            enabled: true,
          }),
        )
        return
      }
      await retryTransient(() =>
        client.createWebhook('all', url, {
          Authorization: `Bearer ${secret}`,
        }),
      )
    },
  }
}

let gateway: PluggyGateway | null = null

export function getPluggyGateway() {
  const configuration = getPluggyConfiguration()
  if (
    !configuration.enabled ||
    !configuration.clientId ||
    !configuration.clientSecret
  ) {
    throw new Error(
      'Configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET para usar Open Finance.',
    )
  }
  gateway ??= createPluggyGateway(
    new PluggyClient({
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
    }),
  )
  return gateway
}
