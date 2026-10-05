/**
 * Opens the Pluggy Connect widget in the browser. The widget only receives
 * the 30-minute connect token the server created; the Pluggy credentials and
 * the API token never leave the server.
 */

const scriptUrl =
  'https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js'

export interface PluggyConnectCallbacks {
  onSuccess: (itemId: string) => void
  onError: (message: string) => void
  onClose: () => void
}

interface PluggyConnectInstance {
  init: () => Promise<void>
  destroy?: () => void
}

type PluggyConnectConstructor = new (options: {
  connectToken: string
  updateItem?: string
  onSuccess: (data: { item: { id: string } }) => void
  onError: (error: { message?: string }) => void
  onClose: () => void
}) => PluggyConnectInstance

declare global {
  interface Window {
    PluggyConnect?: PluggyConnectConstructor
  }
}

let loading: Promise<PluggyConnectConstructor> | null = null

function loadPluggyConnect() {
  if (window.PluggyConnect) return Promise.resolve(window.PluggyConnect)
  loading ??= new Promise<PluggyConnectConstructor>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = scriptUrl
    script.async = true
    script.onload = () =>
      window.PluggyConnect
        ? resolve(window.PluggyConnect)
        : reject(new Error('O widget da Pluggy não carregou.'))
    script.onerror = () => {
      loading = null
      reject(
        new Error(
          'Não foi possível carregar o widget da Pluggy. Confira a conexão com a internet.',
        ),
      )
    }
    document.head.append(script)
  })
  return loading
}

export async function openPluggyConnect(
  input: { connectToken: string; updateItem?: string } & PluggyConnectCallbacks,
) {
  const PluggyConnect = await loadPluggyConnect()
  let settled = false
  const widget = new PluggyConnect({
    connectToken: input.connectToken,
    updateItem: input.updateItem,
    onSuccess: (data) => {
      settled = true
      input.onSuccess(data.item.id)
    },
    onError: (error) =>
      input.onError(error.message ?? 'A Pluggy não concluiu a conexão.'),
    onClose: () => {
      if (!settled) input.onClose()
    },
  })
  await widget.init()
}
