const base = 'http://spendle.invalid'

/**
 * The in-app path to return to after sign-in, or undefined. Resolving against
 * a fixed origin catches every form that leaves the app, including `//host`
 * and `/\host`, which browsers read as another origin.
 */
export function safeRedirect(value: string) {
  if (!value.startsWith('/')) return undefined
  const url = new URL(value, base)
  if (url.origin !== base) return undefined
  return `${url.pathname}${url.search}${url.hash}`
}
