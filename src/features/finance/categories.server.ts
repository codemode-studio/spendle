import { desc, inArray } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { normalizeDescription } from '#/domain/finance'
import {
  detectOwnedTransferCategory,
  matchLearnedTransferRule,
} from '#/domain/reconciliation'

export type SuggestionSource =
  'none' | 'rule' | 'knowledge' | 'history' | 'heuristic' | 'ai' | 'system'

export interface CategorySuggestion {
  categoryId: string
  counterpartyAccountId?: string | null
  confidence: number
  source: SuggestionSource
}

type ScopeType = 'household' | 'person' | 'company_br' | 'company_us' | null

export async function suggestCategory(input: {
  description: string
  amountCents: number
  accountId: string | null
  creditCardId: string | null
}): Promise<CategorySuggestion> {
  const normalized = normalizeDescription(input.description)
  const rules = await db.select().from(schema.categorizationRules)
  const learnedTransfer = matchLearnedTransferRule({
    description: input.description,
    amountCents: input.amountCents,
    sourceAccountId: input.accountId,
    rules,
  })
  if (learnedTransfer) {
    return { ...learnedTransfer, confidence: 100, source: 'history' }
  }
  const direction = input.amountCents < 0 ? 'outgoing' : 'incoming'
  const rule = rules
    .filter((candidate) => candidate.active)
    .sort((left, right) => left.priority - right.priority)
    .find(
      (candidate) =>
        normalized.includes(candidate.pattern) &&
        (!candidate.accountId || candidate.accountId === input.accountId) &&
        (!candidate.direction || candidate.direction === direction) &&
        (candidate.minAmountCents === null ||
          Math.abs(input.amountCents) >= candidate.minAmountCents) &&
        (candidate.maxAmountCents === null ||
          Math.abs(input.amountCents) <= candidate.maxAmountCents),
    )
  if (rule) {
    return {
      categoryId: rule.categoryId,
      counterpartyAccountId: rule.counterpartyAccountId,
      confidence: 100,
      source: 'rule',
    }
  }

  if (
    input.creditCardId &&
    input.amountCents > 0 &&
    /pagamento\s+(?:de\s+)?(?:fatura|recebido)|fatura.*(?:paga|pagamento)/i.test(
      normalized,
    )
  ) {
    return {
      categoryId: 'card_payment',
      confidence: 100,
      source: 'system',
    }
  }

  const heuristics: Array<[RegExp, string]> = [
    [/^(?:shein|shopee|mercadolivre)\s*\*/i, 'shopping'],
    [/pagamento.*fatura|fatura.*(?:paga|pagamento)/i, 'card_payment'],
    [/aluguel|condominio|iptu/i, 'housing'],
    [/financiamento|consorcio|prestacao|emprestimo|crediario/i, 'financing'],
    [/energia|internet|telefone|agua|gas/i, 'utilities'],
    [/^ifd\*|ifood|99food|rappi|ze delivery|delivery/i, 'delivery'],
    [
      /\bmercado\b(?!\s*\*)(?!\s*(?:livre|pago))|supermercado|atacad|acougue|hortifruti|emporio/i,
      'groceries',
    ],
    [
      /restaurante|\bbar\b|boteco|hamburg|pizzaria|sushi|\bcafe\b|cafeteria|coffee|bakery|padaria|grill|brasa|churrasc|doces|sorvete|crepe|bistro|lanch|confeitaria/i,
      'restaurants',
    ],
    [/uber|posto|combustivel|estacionamento|pedagio/i, 'transport'],
    [/farmacia|hospital|clinica|medico|laboratorio/i, 'health'],
    [/escola|curso|faculdade|livro/i, 'education'],
    [/seguro|protecao veicular/i, 'insurance'],
    [/spotify|netflix|amazon prime|assinatura/i, 'subscriptions'],
    [/cinema|show|lazer/i, 'leisure'],
    [/petshop|veterinari|racao/i, 'pets'],
    [/salao|barbear|cosmetic|estetica/i, 'personal_care'],
    [/tarifa|encargo|juros|anuidade|iof/i, 'fees_interest'],
    [
      /dividendo|rendimento|juros sobre capital/i,
      input.amountCents > 0 ? 'investment_income' : 'uncategorized',
    ],
    [
      /reembolso|restituicao/i,
      input.amountCents > 0 ? 'reimbursements' : 'uncategorized',
    ],
    [/invest|corretora|aplicacao/i, 'investment'],
    [/salario|pro labore/i, input.amountCents > 0 ? 'salary' : 'uncategorized'],
    [/imposto|das|darf|gps|tributo/i, 'tax'],
  ]
  const match = heuristics.find(([pattern]) => pattern.test(normalized))
  return {
    categoryId: match?.[1] ?? 'uncategorized',
    confidence: match ? 80 : 0,
    source: match ? 'heuristic' : 'none',
  }
}

export async function applyHistoricalCategorySuggestions<
  T extends {
    item: { description: string }
    suggestion: CategorySuggestion
  },
>(prepared: T[]) {
  const unresolvedDescriptions = [
    ...new Set(
      prepared
        .filter(({ suggestion }) => suggestion.categoryId === 'uncategorized')
        .map(({ item }) => normalizeDescription(item.description)),
    ),
  ]
  if (!unresolvedDescriptions.length) return
  const history = await db
    .select({
      normalizedDescription: schema.transactions.normalizedDescription,
      categoryId: schema.transactions.categoryId,
      counterpartyAccountId: schema.transactions.counterpartyAccountId,
    })
    .from(schema.transactions)
    .where(
      inArray(
        schema.transactions.normalizedDescription,
        unresolvedDescriptions,
      ),
    )
    .orderBy(desc(schema.transactions.postedAt))
  const byDescription = new Map<
    string,
    { categoryId: string; counterpartyAccountId: string | null }
  >()
  for (const transaction of history) {
    if (
      transaction.categoryId &&
      transaction.categoryId !== 'uncategorized' &&
      !byDescription.has(transaction.normalizedDescription)
    ) {
      byDescription.set(transaction.normalizedDescription, {
        categoryId: transaction.categoryId,
        counterpartyAccountId: transaction.counterpartyAccountId,
      })
    }
  }
  for (const preparedItem of prepared) {
    if (preparedItem.suggestion.categoryId !== 'uncategorized') continue
    const historical = byDescription.get(
      normalizeDescription(preparedItem.item.description),
    )
    if (historical) {
      preparedItem.suggestion = {
        ...historical,
        confidence: 95,
        source: 'history',
      }
    }
  }
}

export function applyTargetCategoryPolicy(input: {
  suggestion: CategorySuggestion
  amountCents: number
  description: string
  raw?: unknown
  purpose: string
  scopeName: string
  scopeType: ScopeType
}) {
  const ownedTransferCategory = detectOwnedTransferCategory({
    amountCents: input.amountCents,
    description: input.description,
    raw: input.raw,
    sourceScopeName: input.scopeName,
    sourceScopeType: input.scopeType,
  })
  if (
    ownedTransferCategory &&
    input.suggestion.source !== 'rule' &&
    !input.suggestion.counterpartyAccountId
  ) {
    return {
      categoryId: ownedTransferCategory,
      confidence: 96,
      source: 'system' as const,
    }
  }
  if (input.amountCents > 0 && input.purpose === 'reserve') {
    return { categoryId: 'reserve', confidence: 100, source: 'system' as const }
  }
  if (input.amountCents > 0 && input.purpose === 'investment') {
    return {
      categoryId: 'investment',
      confidence: 100,
      source: 'system' as const,
    }
  }
  return input.suggestion
}
