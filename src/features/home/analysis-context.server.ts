import { getFinanceSnapshot } from '#/features/finance/finance-snapshot.server'
import { getKnowledgeBaseSnapshot } from '#/features/finance/knowledge-base.server'

/** Leitura apenas: respostas da IA nunca viram aprendizado. Valores em centavos. */
export async function getAnalysisContext(month?: string) {
  const [snapshot, knowledge] = await Promise.all([
    getFinanceSnapshot(month),
    getKnowledgeBaseSnapshot(),
  ])
  const { dashboard } = snapshot
  const { lines, ...family } = dashboard.familyMonth
  const categories = new Map<
    string,
    {
      id: string
      category: string
      bucket: string
      knownCents: number
      estimatedCents: number
    }
  >()
  for (const line of lines) {
    const key = line.categoryId ?? 'uncategorized'
    const item = categories.get(key) ?? {
      id: key,
      category:
        knowledge.categories.find((category) => category.id === line.categoryId)
          ?.name ?? 'Sem categoria',
      bucket: line.bucket,
      knownCents: 0,
      estimatedCents: 0,
    }
    item.knownCents += line.knownCents
    item.estimatedCents += line.estimatedCents
    categories.set(key, item)
  }
  return {
    unit: 'centavos de BRL',
    month: dashboard.currentMonth,
    family,
    categories: [...categories.values()],
    targets: dashboard.budgetTargets,
    integrity: dashboard.integrity,
    knowledge: knowledge.entries.map((entry) => ({
      description: entry.sampleDescription,
      pattern: entry.pattern,
      matchMode: entry.matchMode,
      direction: entry.direction,
      category: entry.category?.name ?? null,
      bucket:
        knowledge.categories.find(
          (category) => category.id === entry.category?.id,
        )?.bucket ?? null,
      recurrence: entry.recurrence?.name ?? null,
      source: 'decisão humana',
    })),
    commitments: snapshot.recurrences
      .filter((entry) => entry.active)
      .map((entry) => ({
        name: entry.name,
        amountCents: entry.baseAmountCents,
        frequency: entry.frequency,
        direction: entry.direction,
        descriptions: entry.knowledgeReferences.map(
          (reference) => reference.description,
        ),
      })),
  }
}
