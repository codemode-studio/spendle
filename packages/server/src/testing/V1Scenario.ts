import * as Effect from 'effect/Effect'

import type { V1Writer } from './V1Fixture.ts'

/**
 * A V1 household for migration tests: accounts, cards, categories, the
 * knowledge base, and transactions carrying each kind of decision V1
 * records, with the statements V2 later imports for the same movements.
 */

const ofx = (lines: string) =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><STMTRS><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST></STMTRS></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

// One import per V1 target, so staged lines have somewhere to belong.
const transaction = (
  v1: V1Writer,
  input: {
    readonly id: string
    readonly account?: string
    readonly card?: string
    readonly postedAt: string
    readonly amountCents: number
    readonly description: string
    readonly categoryId: string | null
    readonly staged?: {
      readonly source: string
      readonly categoryId: string | null
      readonly matchKind?: string
    }
    readonly sourceKey?: string
    readonly notes?: string
  },
) =>
  Effect.gen(function* () {
    yield* v1.insert('transactions', {
      id: input.id,
      account_id: input.account ?? null,
      credit_card_id: input.card ?? null,
      category_id: input.categoryId,
      source_key: input.sourceKey ?? `file:${input.id}`,
      fingerprint: `fp-${input.id}`,
      posted_at: input.postedAt,
      description: input.description,
      normalized_description: input.description.toLowerCase(),
      amount_cents: input.amountCents,
      currency: 'BRL',
      notes: input.notes ?? null,
    })
    if (input.staged) {
      const importId = `import-${input.account ?? input.card}`
      yield* v1.insert('staged_transactions', {
        id: `staged-${input.id}`,
        import_id: importId,
        fingerprint: `fp-${input.id}`,
        posted_at: input.postedAt,
        description: input.description,
        normalized_description: input.description.toLowerCase(),
        amount_cents: input.amountCents,
        currency: 'BRL',
        suggested_category_id: input.staged.categoryId,
        suggestion_source: input.staged.source,
      })
      yield* v1.insert('transaction_evidence', {
        id: `evidence-${input.id}`,
        staged_transaction_id: `staged-${input.id}`,
        transaction_id: input.id,
        match_kind: input.staged.matchKind ?? 'created',
      })
    }
  })

const category = (
  v1: V1Writer,
  id: string,
  name: string,
  bucket: string,
  extra: Record<string, string | number | null> = {},
) => v1.upsert('categories', { id, name, bucket, ...extra })

/** A household with a checking and a savings account, two cards and the person's decisions. */
export const seedV1 = (v1: V1Writer) =>
  Effect.gen(function* () {
    yield* v1.insert('ownership_scopes', {
      id: 'home',
      name: 'Família',
      type: 'household',
    })
    yield* v1.insert('ownership_scopes', {
      id: 'firm',
      name: 'Empresa',
      type: 'company_br',
    })
    yield* v1.insert('institutions', { id: 'nu', name: 'Nubank' })
    yield* v1.insert('accounts', {
      id: 'checking',
      ownership_scope_id: 'home',
      institution_id: 'nu',
      name: 'Conta Nubank',
      kind: 'checking',
    })
    yield* v1.insert('accounts', {
      id: 'savings',
      ownership_scope_id: 'home',
      name: 'Reserva',
      kind: 'savings',
      purpose: 'reserve',
    })
    yield* v1.insert('accounts', {
      id: 'closed',
      ownership_scope_id: 'firm',
      institution_id: 'nu',
      name: 'Conta PJ antiga',
      active: 0,
    })
    yield* v1.insert('credit_cards', {
      id: 'ultravioleta',
      ownership_scope_id: 'home',
      institution_id: 'nu',
      name: 'Ultravioleta',
      last_four: '1889',
      limit_cents: 500_000,
      closing_day: 3,
      due_day: 10,
    })
    yield* v1.insert('credit_cards', {
      id: 'no-due-day',
      ownership_scope_id: 'home',
      name: 'Cartão sem vencimento',
      closing_day: 5,
    })

    yield* category(v1, 'groceries', 'Supermercado', 'essential', {
      color: '#111111',
    })
    yield* category(v1, 'leisure', 'Lazer', 'lifestyle', { color: '#db2777' })
    yield* category(v1, 'shopping', 'Compras', 'lifestyle', {
      color: '#ea580c',
    })
    yield* category(v1, 'delivery', 'Delivery', 'lifestyle', {
      color: '#f97316',
    })
    yield* category(v1, 'health', 'Saúde', 'essential', { color: '#dc2626' })
    yield* category(v1, 'pets', 'Pets', 'lifestyle', { color: '#ca8a04' })
    yield* category(v1, 'transfer', 'Transferência', 'excluded')
    yield* category(v1, 'uncategorized', 'Sem categoria', 'excluded', {
      color: '#94a3b8',
    })
    yield* category(v1, 'vet', 'Veterinário', 'lifestyle', {
      parent_id: 'pets',
      color: '#a16207',
      icon: 'paw',
    })
    yield* category(v1, 'old', 'Antiga', 'lifestyle', { active: 0 })

    yield* v1.insert('knowledge_base', {
      id: 'kb-padaria',
      kind: 'category',
      signature: 'padaria do joao',
      pattern: 'padaria do joao',
      direction: 'expense',
      category_id: 'groceries',
      sample_description: 'PADARIA DO JOAO',
      source: 'transaction_review',
      confirmations: 3,
      corrections: 1,
      last_learned_at: 1_788_000_000,
    })
    yield* v1.insert('knowledge_base', {
      id: 'kb-ifd',
      kind: 'category',
      signature: 'ifd',
      pattern: 'ifd',
      match_mode: 'prefix',
      direction: 'expense',
      category_id: 'delivery',
      sample_description: 'IFD*',
      source: 'pattern_approval',
    })
    yield* v1.insert('knowledge_base', {
      id: 'kb-old',
      kind: 'category',
      signature: 'loja antiga',
      pattern: 'loja antiga',
      direction: 'expense',
      category_id: 'old',
      sample_description: 'LOJA ANTIGA',
      source: 'transaction_review',
    })
    yield* v1.insert('recurrences', {
      id: 'rent',
      name: 'Aluguel',
      amount_cents: 200_000,
      frequency: 'monthly',
      next_date: '2026-10-05',
    })
    yield* v1.insert('knowledge_base', {
      id: 'kb-rent',
      kind: 'recurrence',
      signature: 'aluguel',
      pattern: 'aluguel',
      direction: 'expense',
      recurrence_id: 'rent',
      sample_description: 'ALUGUEL',
      source: 'recurrence_approval',
    })

    yield* v1.insert('source_files', {
      id: 'file',
      sha256: 'sha',
      original_name: 'extrato.ofx',
      media_type: 'application/x-ofx',
      size_bytes: 1,
      storage_path: 'uploads/extrato.ofx',
    })
    for (const target of ['checking', 'savings'])
      yield* v1.insert('imports', {
        id: `import-${target}`,
        source_file_id: 'file',
        account_id: target,
        parser: 'ofx',
        status: 'committed',
      })

    // Chosen while reviewing the import.
    yield* transaction(v1, {
      id: 'review',
      account: 'checking',
      postedAt: '2026-09-10',
      amountCents: -1500,
      description: 'MERCADO CENTRAL',
      categoryId: 'groceries',
      staged: { source: 'manual', categoryId: 'groceries' },
      notes: 'Compra do mês',
    })
    // Changed afterwards in the transaction list.
    yield* transaction(v1, {
      id: 'list',
      account: 'checking',
      postedAt: '2026-09-11',
      amountCents: -2500,
      description: 'LOJA X',
      categoryId: 'shopping',
      staged: { source: 'knowledge', categoryId: 'leisure' },
    })
    // Changed by the knowledge base, which comes over as a pattern.
    yield* transaction(v1, {
      id: 'covered',
      account: 'checking',
      postedAt: '2026-09-12',
      amountCents: -900,
      description: 'PADARIA DO JOAO',
      categoryId: 'groceries',
      staged: { source: 'heuristic', categoryId: 'leisure' },
    })
    // Kept as suggested: nobody decided it.
    yield* transaction(v1, {
      id: 'automatic',
      account: 'checking',
      postedAt: '2026-09-13',
      amountCents: -700,
      description: 'CAFE',
      categoryId: 'leisure',
      staged: { source: 'heuristic', categoryId: 'leisure' },
    })
    // A transfer the person confirmed.
    yield* transaction(v1, {
      id: 'sent',
      account: 'checking',
      postedAt: '2026-09-14',
      amountCents: -10_000,
      description: 'TED ENVIADA RESERVA',
      categoryId: 'transfer',
      staged: { source: 'heuristic', categoryId: 'uncategorized' },
    })
    yield* transaction(v1, {
      id: 'received',
      account: 'savings',
      postedAt: '2026-09-14',
      amountCents: 10_000,
      description: 'TED RECEBIDA CONTA',
      categoryId: 'transfer',
      staged: { source: 'heuristic', categoryId: 'uncategorized' },
    })
    yield* v1.insert('reconciliation_groups', {
      id: 'confirmed-by-person',
      type: 'transfer',
      status: 'confirmed',
      confidence: 80,
      reason: 'Valores iguais em contas da mesma família.',
    })
    yield* v1.insert('reconciliation_links', {
      id: 'link-sent',
      group_id: 'confirmed-by-person',
      transaction_id: 'sent',
      role: 'source',
      previous_category_id: 'uncategorized',
    })
    yield* v1.insert('reconciliation_links', {
      id: 'link-received',
      group_id: 'confirmed-by-person',
      transaction_id: 'received',
      role: 'destination',
      previous_category_id: 'uncategorized',
    })
    // V1's own verdicts are not the person's.
    yield* v1.insert('reconciliation_groups', {
      id: 'confirmed-by-v1',
      type: 'card_payment',
      status: 'confirmed',
      confidence: 100,
      reason:
        'Pagamento de fatura com valor e data correspondentes, sem outro candidato.',
    })
    yield* v1.insert('reconciliation_groups', {
      id: 'invalidated-by-v1',
      type: 'transfer',
      status: 'rejected',
      confidence: 80,
      reason:
        'Invalidada porque uma movimentação vinculada ainda não está confirmada.',
    })
    // Typed in by hand: V2 records it again as a manual fact.
    yield* transaction(v1, {
      id: 'typed',
      account: 'checking',
      postedAt: '2026-09-15',
      amountCents: -3000,
      description: 'CONSULTA',
      categoryId: 'health',
      sourceKey: 'manual:typed',
      notes: 'Dra. Ana',
    })
    // Investments: a brokerage account, a reserve position with an opening
    // amount and the value last entered, and a typed-in contribution in it.
    yield* v1.insert('accounts', {
      id: 'brokerage',
      ownership_scope_id: 'home',
      name: 'Corretora',
      kind: 'investment',
      purpose: 'investment',
    })
    yield* v1.insert('investment_goals', {
      id: 'emergency',
      name: 'Reserva de emergência',
      type: 'emergency_reserve',
      target_cents: 3_000_000,
    })
    yield* v1.insert('investment_positions', {
      id: 'tesouro',
      account_id: 'brokerage',
      asset_class_id: 'fixed-income',
      goal_id: 'emergency',
      name: 'Tesouro Selic 2029',
      currency: 'BRL',
      initial_amount_minor: 10_000,
      manual_current_amount_minor: 65_000,
      manual_current_at: '2026-09-30',
    })
    yield* transaction(v1, {
      id: 'aporte',
      account: 'brokerage',
      postedAt: '2026-09-20',
      amountCents: 50_000,
      description: 'APORTE TESOURO',
      categoryId: null,
      sourceKey: 'manual:aporte',
    })
    yield* v1.insert('investment_position_movements', {
      id: 'movement-aporte',
      position_id: 'tesouro',
      transaction_id: 'aporte',
      kind: 'contribution',
      amount_minor: 50_000,
    })
    // Balances informed by hand: one on the checking account, one card
    // statement (V2 checks cards by their cycles), one V1 invalidated.
    yield* v1.insert('balance_checkpoints', {
      id: 'informed',
      account_id: 'checking',
      kind: 'manual',
      source: 'manual',
      balance_cents: 120_000,
      as_of: '2026-09-30',
    })
    yield* v1.insert('balance_checkpoints', {
      id: 'card-informed',
      credit_card_id: 'ultravioleta',
      kind: 'manual',
      source: 'manual',
      balance_type: 'card_statement',
      balance_cents: -5_000,
      as_of: '2026-09-03',
    })
    yield* v1.insert('balance_checkpoints', {
      id: 'stale',
      account_id: 'checking',
      kind: 'manual',
      source: 'manual',
      review_state: 'invalidated',
      balance_cents: 1,
      as_of: '2026-08-31',
    })
    yield* v1.insert('card_statement_payments', {
      id: 'bill-link',
      credit_card_id: 'ultravioleta',
      due_date: '2026-09-10',
      transaction_id: 'automatic',
    })
  })

/** What V2 observes again for the V1 checking account. */
export const checkingStatement = ofx(
  [
    line('a', '20260910', '-15.00', 'MERCADO CENTRAL'),
    line('b', '20260911', '-25.00', 'LOJA X'),
    line('c', '20260912', '-9.00', 'PADARIA DO JOAO'),
    line('d', '20260913', '-7.00', 'CAFE'),
    line('e', '20260914', '-100.00', 'TED ENVIADA RESERVA'),
  ].join(''),
)
/** What V2 observes again for the V1 savings account. */
export const savingsStatement = ofx(
  line('f', '20260914', '100.00', 'TED RECEBIDA CONTA'),
)
