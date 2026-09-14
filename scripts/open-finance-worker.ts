import { config } from 'dotenv'

config({ path: ['.env.local', '.env'], quiet: true })

const { processNextPluggyWebhook, recoverAbandonedPluggyEvents } =
  await import('../src/features/open-finance/open-finance.server')

await recoverAbandonedPluggyEvents()
console.log('Worker Open Finance aguardando eventos.')

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
  })
}

function shouldStop() {
  return stopping
}

while (!shouldStop()) {
  const processed = await processNextPluggyWebhook()
  if (!processed) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}
