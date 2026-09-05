export async function measureOperation<T>(
  operation: string,
  ids: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  if (process.env.FINANCAS_DEBUG !== '1') return run()
  const started = performance.now()
  let status = 'completed'
  try {
    return await run()
  } catch (error) {
    status = 'failed'
    throw error
  } finally {
    // IDs correlate stages without logging descriptions, document contents or keys.
    console.info(
      JSON.stringify({
        operation,
        ...ids,
        status,
        durationMs: +(performance.now() - started).toFixed(2),
      }),
    )
  }
}
