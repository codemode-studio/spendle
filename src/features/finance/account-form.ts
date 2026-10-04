import { parseCurrency } from '#/domain/currency'
import type { AccountSnapshot } from '#/features/finance/snapshot.types'

/** Reads the account dialog. Every field is submitted, so an edit never resets one. */
export function readAccountForm(form: FormData) {
  const kind = String(form.get('kind')) as AccountSnapshot['kind']
  // A brokerage account is always an investment; other kinds keep the chosen purpose.
  const purpose =
    kind === 'investment'
      ? 'investment'
      : (String(form.get('purpose')) as AccountSnapshot['purpose'])
  return {
    name: String(form.get('name')),
    institutionName: String(form.get('institutionName')),
    ownershipScopeId: String(form.get('ownershipScopeId')),
    kind,
    purpose,
    currency: parseCurrency(String(form.get('currency'))),
  }
}
