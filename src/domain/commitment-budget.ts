import { isCardPaymentDescription } from './card-payment'
import { daysBetween } from './period'
import { knowledgeExactPatterns } from './knowledge-pattern'

export type CommitmentBucket =
  'essential' | 'lifestyle' | 'investment' | 'reserve' | 'other'
export interface CommitmentLine {
  id: string
  description: string
  date: string
  cents: number
  categoryId: string | null
  bucket: CommitmentBucket
  transactionId?: string
  importId?: string | null
  temporaryUntil?: string
  installment?: string
  certainty: 'documented' | 'scheduled' | 'estimated'
  paidCents: number
  origin: 'account' | 'card' | 'recurrence' | 'variable'
}
export interface CommitmentTransaction {
  id: string
  description: string
  date: string
  cents: number | null
  nativeCents: number
  currency: string
  categoryId: string | null
  bucket: string | null
  cardId: string | null
  importId: string | null
  status: string
  excluded: boolean
}
export interface CommitmentStatement {
  id: string
  cardId: string
  name: string
  dueDate: string
  cents: number
  closed: boolean
  lines: CommitmentLine[]
  paymentIds: string[]
}
export interface CommitmentRecurrence {
  chargeDate?: string
  id: string
  name: string
  date: string
  cents: number | null
  nativeCents: number
  currency: string
  categoryId: string | null
  bucket: string | null
  variable: boolean
  categoryWide?: boolean
  patterns: string[]
  transactionIds: string[]
  status: string
  cardId: string | null
  toleranceDays: number
}
export interface CommitmentInput {
  month: string
  today: string
  incomeCents: number
  targets: Record<'essential' | 'lifestyle' | 'investment' | 'reserve', number>
  transactions: CommitmentTransaction[]
  statements: CommitmentStatement[]
  recurrences: CommitmentRecurrence[]
  coveragePartial: boolean
}
export function commitmentBucket(bucket: string | null): CommitmentBucket {
  return bucket === 'essential' ||
    bucket === 'lifestyle' ||
    bucket === 'investment' ||
    bucket === 'reserve'
    ? bucket
    : 'other'
}

export function buildCommitmentBudget(input: CommitmentInput) {
  const lines: CommitmentLine[] = []
  const warnings: string[] = []
  const month = (date: string) => date.startsWith(input.month)
  const payments = input.transactions.filter(
    (t) =>
      !t.cardId &&
      t.status === 'confirmed' &&
      t.categoryId === 'card_payment' &&
      t.cents !== null &&
      t.cents < 0,
  )
  const usedPayments = new Set<string>()
  const settledBills = new Map<string, number>()
  const paidTransactions = new Map<string, string>()
  const bills = input.statements.filter((s) => month(s.dueDate))
  for (const bill of bills) {
    const explicit = payments.filter((p) => bill.paymentIds.includes(p.id))
    const candidates = explicit.length
      ? explicit
      : payments.filter(
          (p) =>
            p.cents === -bill.cents &&
            Math.abs(daysBetween(p.date, bill.dueDate, { inclusive: false })) <=
              15 &&
            input.statements.filter(
              (s) =>
                s.cents === bill.cents &&
                Math.abs(
                  daysBetween(p.date, s.dueDate, { inclusive: false }),
                ) <= 15,
            ).length === 1,
        )
    // A unique exact payment identifies a settlement; partial matches require explicit reconciliation.
    const matched = candidates.filter((p) => !usedPayments.has(p.id))
    const paid = Math.min(
      bill.cents,
      matched.reduce((n, p) => n - (p.cents ?? 0), 0),
    )
    for (const payment of matched) usedPayments.add(payment.id)
    settledBills.set(bill.id, paid)
    if (matched.length && !explicit.length)
      warnings.push(
        'Um pagamento de fatura foi identificado por valor exato e proximidade de datas. O vínculo permanece uma inferência para revisão.',
      )
    const details = bill.lines.map((l) => ({ ...l, paidCents: 0 }))
    const gap = bill.cents - details.reduce((n, l) => n + l.cents, 0)
    if (gap !== 0) {
      details.push({
        id: bill.id + ':difference',
        description: bill.name + ' · composição não identificada',
        date: bill.dueDate,
        cents: gap,
        categoryId: null,
        bucket: 'other',
        certainty: bill.closed ? 'documented' : 'scheduled',
        paidCents: 0,
        origin: 'card',
      })
      warnings.push('Há saldo de fatura cuja composição não foi identificada.')
    }
    // Allocate settlement in integer cents. This is presentation, never a record write.
    let allocated = 0
    details.forEach((line, index) => {
      line.paidCents =
        index === details.length - 1
          ? paid - allocated
          : bill.cents > 0
            ? Math.round((line.cents * paid) / bill.cents)
            : 0
      allocated += line.paidCents
      if (line.transactionId) paidTransactions.set(line.transactionId, line.id)
      lines.push(line)
    })
    if (paid > 0)
      warnings.push(
        'Pagamentos de fatura foram distribuídos proporcionalmente entre suas categorias, sem alterar lançamentos.',
      )
  }
  for (const t of input.transactions) {
    if (t.cardId || t.excluded || t.status === 'excluded' || !month(t.date))
      continue
    if (t.cents === null) {
      warnings.push(
        'Há valores sem conversão para reais; a margem está incompleta.',
      )
      continue
    }
    if (t.categoryId === 'card_payment') {
      if (usedPayments.has(t.id)) continue
      if (t.cents < 0) {
        lines.push({
          id: t.id,
          transactionId: t.id,
          description: t.description + ' · pagamento sem fatura vinculada',
          date: t.date,
          cents: -t.cents,
          paidCents: t.status === 'confirmed' ? -t.cents : 0,
          categoryId: null,
          bucket: 'other',
          certainty: 'documented',
          origin: 'account',
        })
        warnings.push(
          'Existe pagamento de cartão sem vínculo inequívoco com uma fatura. Revise para evitar reserva duplicada.',
        )
      }
      continue
    }
    if (
      t.cents >= 0 &&
      !['essential', 'lifestyle', 'tax', 'business'].includes(t.bucket ?? '')
    )
      continue
    const debitCents = -t.cents
    if (debitCents > 0 && t.categoryId !== 'transfer') {
      const looksLikePayment = isCardPaymentDescription(t.description)
      const unpaidBillWithSameAmount = bills.find(
        (bill) =>
          bill.cents === debitCents &&
          !(settledBills.get(bill.id) ?? 0) &&
          Math.abs(daysBetween(t.date, bill.dueDate, { inclusive: false })) <=
            15,
      )
      if (looksLikePayment || unpaidBillWithSameAmount) {
        warnings.push(
          `"${t.description}" parece pagamento de fatura, mas está categorizado como despesa. Reclassifique como pagamento de cartão para não contar em dobro.`,
        )
      }
    }
    lines.push({
      id: t.id,
      transactionId: t.id,
      description: t.description,
      date: t.date,
      cents: -t.cents,
      paidCents: t.status === 'confirmed' ? -t.cents : 0,
      categoryId: t.categoryId,
      bucket: commitmentBucket(t.bucket),
      certainty: 'documented',
      origin: 'account',
      importId: t.importId,
    })
    paidTransactions.set(t.id, t.id)
  }
  const active = input.recurrences.filter(
    (r) => month(r.date) && r.status !== 'skipped',
  )
  const claimed = new Set<string>()
  const candidatesFor = (r: CommitmentRecurrence) =>
    input.transactions.filter((t) => {
      if (
        !['confirmed', 'pending'].includes(t.status) ||
        t.excluded ||
        t.nativeCents >= 0 ||
        t.currency !== r.currency ||
        (r.cardId && r.cardId !== t.cardId)
      )
        return false
      if (r.transactionIds.includes(t.id)) return true
      if (
        Math.abs(t.nativeCents) !== r.nativeCents ||
        Math.abs(
          daysBetween(t.date, r.chargeDate ?? r.date, { inclusive: false }),
        ) > r.toleranceDays
      )
        return false
      return knowledgeExactPatterns(t.description).some((p) =>
        r.patterns.includes(p),
      )
    })
  for (const r of active.filter((item) => !item.variable)) {
    if (r.cents === null) {
      warnings.push('Há recorrência sem conversão para reais.')
      continue
    }
    const all = candidatesFor(r)
    const matches = all.filter(
      (t) =>
        r.transactionIds.includes(t.id) ||
        (all.length === 1 &&
          active.filter(
            (other) =>
              !other.variable &&
              candidatesFor(other).some((x) => x.id === t.id),
          ).length === 1),
    )
    const covered = matches.filter((t) => !claimed.has(t.id))
    for (const t of covered) claimed.add(t.id)
    const coveredCents = covered.reduce((n, t) => n + Math.abs(t.cents ?? 0), 0)
    // When a recurrence was prepaid outside the selected month, preserve the settled obligation here.
    for (const t of covered) {
      if (!paidTransactions.has(t.id)) {
        if (t.cardId) {
          warnings.push(
            'Uma recorrência foi reconhecida em compra de cartão de outro vencimento; ela não foi contada novamente.',
          )
          continue
        }
        lines.push({
          id: r.id + ':prepaid:' + t.id,
          transactionId: t.id,
          description:
            r.name +
            (t.status === 'confirmed'
              ? ' · antecipado em '
              : ' · lançamento pendente em ') +
            t.date,
          date: r.date,
          cents: Math.abs(t.cents ?? 0),
          paidCents: t.status === 'confirmed' ? Math.abs(t.cents ?? 0) : 0,
          categoryId: r.categoryId,
          bucket: commitmentBucket(r.bucket),
          certainty: 'documented',
          origin: 'recurrence',
        })
      }
    }
    if (r.status === 'paid' && !covered.length) {
      warnings.push(
        'Há recorrência marcada como paga sem lançamento financeiro identificado.',
      )
      continue
    }
    const remaining = Math.max(0, r.cents - coveredCents)
    if (remaining)
      lines.push({
        id: r.id,
        description: r.name,
        date: r.date,
        cents: remaining,
        paidCents: 0,
        categoryId: r.categoryId,
        bucket: commitmentBucket(r.bucket),
        certainty: 'estimated',
        origin: 'recurrence',
      })
  }
  const variableCategories = new Set<string>()
  const variableMatches = new Set<string>()
  for (const r of active.filter((item) => item.variable)) {
    if (!r.categoryId || r.cents === null) {
      warnings.push('Há estimativa variável sem categoria ou conversão.')
      continue
    }
    if (r.categoryWide && variableCategories.has(r.categoryId)) {
      warnings.push(
        'Mais de uma estimativa geral na mesma categoria; revise o cadastro.',
      )
      continue
    }
    if (r.categoryWide) variableCategories.add(r.categoryId)
    const eligibleIds = new Set(
      input.transactions
        .filter(
          (t) =>
            r.transactionIds.includes(t.id) ||
            (t.currency === r.currency &&
              knowledgeExactPatterns(t.description).some((p) =>
                r.patterns.includes(p),
              )),
        )
        .map((t) => t.id),
    )
    if (!r.categoryWide) {
      for (const t of input.transactions.filter(
        (candidate) =>
          r.transactionIds.includes(candidate.id) &&
          candidate.status === 'confirmed' &&
          !candidate.excluded &&
          !paidTransactions.has(candidate.id) &&
          candidate.cents !== null &&
          candidate.cents < 0,
      )) {
        if (t.cardId) continue
        const paid = Math.abs(t.cents ?? 0)
        lines.push({
          id: r.id + ':prepaid:' + t.id,
          transactionId: t.id,
          description: r.name + ' · antecipado em ' + t.date,
          date: r.date,
          cents: paid,
          paidCents: paid,
          categoryId: r.categoryId,
          bucket: commitmentBucket(r.bucket),
          certainty: 'documented',
          origin: 'recurrence',
        })
        paidTransactions.set(t.id, r.id + ':prepaid:' + t.id)
      }
    }
    const represented = lines.filter((l) =>
      r.categoryWide
        ? l.categoryId === r.categoryId
        : l.transactionId &&
          eligibleIds.has(l.transactionId) &&
          !variableMatches.has(l.id),
    )
    if (!r.categoryWide)
      for (const line of represented) variableMatches.add(line.id)
    const already = represented.reduce((n, l) => n + l.cents, 0)
    const remaining = Math.max(0, r.cents - Math.max(0, already))
    if (remaining)
      lines.push({
        id: r.id,
        description: r.name + ' · restante da estimativa',
        date: r.date,
        cents: remaining,
        paidCents: 0,
        categoryId: r.categoryId,
        bucket: commitmentBucket(r.bucket),
        certainty: 'estimated',
        origin: 'variable',
      })
  }
  if (input.coveragePartial)
    warnings.push(
      'Cobertura dos extratos parcial. Compras ainda não importadas podem reduzir a margem.',
    )
  const buckets = (
    ['essential', 'lifestyle', 'investment', 'reserve', 'other'] as const
  ).map((bucket) => {
    const items = lines.filter((l) => l.bucket === bucket)
    const paidCents = items.reduce((n, l) => n + l.paidCents, 0)
    const variableCents = items
      .filter((l) => l.origin === 'variable')
      .reduce((n, l) => n + l.cents, 0)
    const dueCents = items
      .filter((l) => l.origin !== 'variable')
      .reduce((n, l) => n + l.cents - l.paidCents, 0)
    const targetCents = bucket === 'other' ? 0 : input.targets[bucket]
    return {
      bucket,
      paidCents,
      dueCents,
      variableCents,
      committedCents: paidCents + dueCents + variableCents,
      targetCents,
      remainingCents: targetCents - paidCents - dueCents - variableCents,
    }
  })
  const committedCents = lines.reduce((n, l) => n + l.cents, 0)
  const unfundedGoalsCents = buckets
    .filter((b) => b.bucket === 'investment' || b.bucket === 'reserve')
    .reduce((n, b) => n + Math.max(0, b.remainingCents), 0)
  return {
    month: input.month,
    lines,
    buckets,
    warnings: [...new Set(warnings)],
    committedCents,
    unfundedGoalsCents,
    remainingAfterGoalsCents:
      input.incomeCents - committedCents - unfundedGoalsCents,
    incomeCents: input.incomeCents,
    remainingCents: input.incomeCents - committedCents,
  }
}
export type CommitmentBudget = ReturnType<typeof buildCommitmentBudget>
