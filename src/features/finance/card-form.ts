import { parseCurrency, toMinorUnits as toCents } from '#/domain/currency'

/** Reads the card dialog. A blank due day stays unknown instead of blocking the save. */
export function readCardForm(form: FormData) {
  const lastFour = String(form.get('lastFour') || '')
  const currency = parseCurrency(String(form.get('currency')))
  const dueDay = String(form.get('dueDay') ?? '').trim()
  return {
    name: String(form.get('name')),
    institutionName: String(form.get('institutionName')),
    ownershipScopeId: String(form.get('ownershipScopeId')),
    currency,
    lastFour: lastFour || undefined,
    limitCents: toCents(String(form.get('limit')), currency),
    closingDay: Number(form.get('closingDay')),
    dueDay: dueDay ? Number(dueDay) : undefined,
  }
}
