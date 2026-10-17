/**
 * Emails allowed to sign in, from `SPENDLE_ALLOWED_EMAILS`: separated by
 * commas or whitespace, compared without case. An empty list allows no one.
 */
export function parseAllowedEmails(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isAllowedEmail(email: string, allowed: ReadonlySet<string>) {
  return allowed.has(email.trim().toLowerCase())
}
