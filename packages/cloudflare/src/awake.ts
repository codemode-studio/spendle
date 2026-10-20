/** How long an object stays in memory after its last request. */
const sessionIdle = 5 * 60_000

/**
 * Keeps a Durable Object in memory for a while after each request. An idle
 * object without timers hibernates after ten seconds and rebuilds its
 * services on the next request, which made nearly every page read during a
 * session pay for a cold start. A pending timer prevents that until it fires;
 * the object then hibernates as before, so it is only billed while in use.
 * Call the returned function on each request.
 */
export const keepAwake = () => {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
    }, sessionIdle)
  }
}
