import type { AccountView, Owner } from '@spendle/server/api'

export type { AccountView, Owner }

export const ownerKindLabels: Record<Owner['kind'], string> = {
  household: 'Família',
  person: 'Pessoa',
  company: 'Empresa',
}

export const accountKindLabels: Record<AccountView['kind'], string> = {
  checking: 'Conta corrente',
  savings: 'Poupança',
  cash: 'Dinheiro',
  investment: 'Corretora',
  credit_card: 'Cartão de crédito',
}

export function isCard(account: Pick<AccountView, 'kind'>) {
  return account.kind === 'credit_card'
}

export function isInvestment(account: Pick<AccountView, 'kind' | 'purpose'>) {
  return account.kind === 'investment' || account.purpose === 'investment'
}

/**
 * The balance the account shows: the latest booked balance a source reported,
 * else the latest available one. Null until a statement or Open Finance
 * reports any.
 */
export function currentBalance(account: Pick<AccountView, 'balances'>) {
  const latest = (kind: AccountView['balances'][number]['kind']) =>
    account.balances
      .filter((balance) => balance.kind === kind)
      .sort((a, b) => b.asOf.localeCompare(a.asOf))
      .at(0)
  return latest('booked') ?? latest('available') ?? latest('statement') ?? null
}

export const balanceSourceLabels: Record<
  AccountView['balances'][number]['sourceKind'],
  string
> = {
  open_finance: 'Open Finance',
  file: 'extrato',
  manual: 'informado',
}

/** `Conta · Nubank` for selects that mix accounts and cards. */
export function accountOptionLabel(
  account: Pick<AccountView, 'kind' | 'name'>,
) {
  return `${isCard(account) ? 'Cartão' : 'Conta'} · ${account.name}`
}
