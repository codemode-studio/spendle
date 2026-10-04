import { normalizeDescription } from './finance'

// Single source of truth for "this row is a credit card bill payment".
// Every consumer (categorization, reconciliation, statement totals, budgets)
// must go through these helpers instead of keeping a private regex.

// Bank or card side wording: "Pagamento de fatura", "PAGTO FATURA CARTAO 1234",
// "PAG CARTAO", "PAGAMENTO CARTAO DE CREDITO", "DEB AUT CARTAO", "Fatura paga",
// "Debito automatico fatura", "Pagamento efetuado fatura".
const billPaymentPattern =
  /\b(?:pag(?:to|amento)?|deb(?:ito)?\s*aut(?:omatico)?)(?:\s+(?:de|da|do|efetuado|efetivado))*\s+(?:fatura|cart(?:ao|oes))\b|\bfatura\b(?:\s+\S+){0,2}\s+(?:paga|pagamento|pagto|quitad[ao])\b/

// Card side only: the statement itself reports the money that arrived.
// "Pagamento recebido", "Pagamento em 10 JAN", "Pagamento on line".
const receivedPaymentPattern = /^pagamento\s+(?:recebido|em\b|on\s*line)/

export function isCardPaymentDescription(description: string) {
  return billPaymentPattern.test(normalizeDescription(description))
}

export function isReceivedCardPayment(input: {
  creditCardId: string | null
  amountCents: number
  description: string | null | undefined
}) {
  if (!input.creditCardId || input.amountCents <= 0) return false
  const normalized = normalizeDescription(input.description ?? '')
  return (
    receivedPaymentPattern.test(normalized) ||
    billPaymentPattern.test(normalized)
  )
}

// Card credits that give money back for a purchase are never bill payments,
// even when the provider files them under a payment category.
const refundLikePattern =
  /\b(?:estorno|estornad[ao]|reembolso|chargeback|cash\s*back|devolucao|cancelamento|cancelad[ao]|contestacao)\b/

// Pluggy's "Credit card payment" category (and its Portuguese label).
const providerCardPaymentPattern =
  /\bcredit\s*card\s*payment\b|\bpagamento\s+(?:de\s+)?(?:cartao|fatura)\b/

// Card side evidence strong enough to settle a bill automatically: the card
// statement identifies the credit as a payment receipt, by wording or by the
// provider category, and nothing about it reads like a refund.
export function isIdentifiedCardPaymentReceipt(input: {
  creditCardId: string | null
  amountCents: number
  description: string | null | undefined
  providerCategory?: string | null
}) {
  if (!input.creditCardId || input.amountCents <= 0) return false
  const normalized = normalizeDescription(input.description ?? '')
  if (refundLikePattern.test(normalized)) return false
  return (
    isReceivedCardPayment(input) ||
    providerCardPaymentPattern.test(
      normalizeDescription(input.providerCategory ?? ''),
    )
  )
}

// Rows that never count as card spending: settled category or received payment.
export function isCardPaymentRow(input: {
  creditCardId?: string | null
  amountCents: number
  categoryId?: string | null
  description?: string | null
}) {
  return (
    isSettlementCategory(input.categoryId) ||
    isReceivedCardPayment({
      creditCardId: input.creditCardId ?? 'card',
      amountCents: input.amountCents,
      description: input.description,
    })
  )
}

export function isSettlementCategory(categoryId: string | null | undefined) {
  return categoryId === 'card_payment' || categoryId === 'transfer'
}
