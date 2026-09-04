import { formatCurrency } from '#/domain/currency'
import {
  DESTINATION_CONFLICT_MESSAGE,
  IDENTICAL_FILE_CONFLICT_MESSAGE,
} from '#/domain/import-audit'
import type {
  ImportAuditReasonCode,
  ImportBalanceReview,
  ImportCoverageSource,
  ImportReviewGuidance,
} from '#/domain/import-audit'

export interface ImportReviewGuidanceCopy {
  title: string
  explanation: string
  steps: string[]
}

export interface ImportReviewGuidanceCopyContext {
  targetName: string
  period: string
  totals: string
  currency?: string
}

type GuidanceKind = ImportReviewGuidance['kind']
type GuidanceFor<TKind extends GuidanceKind> = Extract<
  ImportReviewGuidance,
  { kind: TKind }
>
type GuidanceCopyFactories = {
  [Kind in GuidanceKind]: (
    guidance: GuidanceFor<Kind>,
    context: ImportReviewGuidanceCopyContext,
  ) => ImportReviewGuidanceCopy
}

function importedGuidance(
  guidance: Pick<ImportReviewGuidance, 'message' | 'targetType'>,
): ImportReviewGuidanceCopy {
  return {
    title: 'Arquivo lido com sucesso',
    explanation:
      guidance.message ??
      'Os lançamentos foram lidos e podem ser consolidados. Este arquivo não fornece sozinho um saldo reconciliado.',
    steps: [
      'Revise as categorias e as transferências abaixo.',
      'Clique em Consolidar para incluir as transações.',
      guidance.targetType === 'account'
        ? 'Depois, use Atualizar saldo na página Contas para informar o valor exibido pelo banco.'
        : 'Quando a fatura fechar, use Confirmar fatura na página Cartões.',
    ],
  }
}

function manualReviewSteps(
  guidance: Pick<ImportReviewGuidance, 'targetType'> & {
    parsedTransactionCount: number
  },
  context: ImportReviewGuidanceCopyContext,
) {
  const targetKind = guidance.targetType === 'account' ? 'conta' : 'cartão'
  return [
    `Confirme que o arquivo pertence à ${targetKind} ${context.targetName}.`,
    `Compare com o extrato original: período ${context.period}, ${guidance.parsedTransactionCount} lançamentos, ${context.totals}.`,
    'Se estiver correto, marque a confirmação abaixo e consolide. Se algo não conferir, rejeite o lote e envie o extrato correto.',
  ]
}

function blockedGuidance(
  message: string | null,
  steps: string[],
): ImportReviewGuidanceCopy {
  return {
    title: 'Este lote não pode ser consolidado',
    explanation:
      message ??
      'A auditoria encontrou uma divergência que precisa ser corrigida.',
    steps,
  }
}

export const importReviewGuidanceCopy = {
  ready: (guidance) =>
    guidance.mode === 'imported'
      ? importedGuidance(guidance)
      : {
          title: 'Conferência automática concluída',
          explanation:
            guidance.message ??
            'A contagem, as movimentações e os saldos conferem.',
          steps: [
            'Revise as categorias dos lançamentos abaixo.',
            'Clique em Consolidar para incluir as transações nos relatórios.',
          ],
        },
  needs_balance: (guidance, context) => {
    if (guidance.mode === 'imported') return importedGuidance(guidance)
    const sourceKind =
      guidance.sourceType === 'csv'
        ? 'CSV'
        : guidance.sourceType === 'ofx'
          ? 'OFX'
          : 'arquivo'
    return {
      title: 'Confira estes dados antes de consolidar',
      explanation:
        guidance.targetType === 'account'
          ? `Os ${guidance.parsedTransactionCount} lançamentos foram lidos, mas este ${sourceKind} não informa o saldo final. Sem esse valor, o sistema não consegue provar que as movimentações fecham o saldo da conta.`
          : `Os ${guidance.parsedTransactionCount} lançamentos foram lidos, mas este ${sourceKind} não informa o total da fatura. Sem esse valor, o sistema não consegue conferir as compras e os créditos.`,
      steps: manualReviewSteps(guidance, context),
    }
  },
  needs_manual_review: (guidance, context) => ({
    title: 'Confira estes dados antes de consolidar',
    explanation:
      guidance.reason === 'unreliable_count'
        ? 'O arquivo informa um saldo final, mas não traz uma contagem confiável dos lançamentos. Por isso, a conferência precisa ser manual.'
        : `Os ${guidance.parsedTransactionCount} lançamentos foram lidos, mas ainda não existe um saldo anterior compatível para conferir o saldo final deste período.`,
    steps: manualReviewSteps(guidance, context),
  }),
  pending_correction: (guidance) =>
    blockedGuidance(guidance.message, [
      'Compare a nova observação com o lançamento atual.',
      'Aceite a correção ou mantenha o original usando as ações abaixo.',
      'Se aceitar, confira novamente os saldos posteriores indicados pelo app.',
    ]),
  identical_file: (guidance, context) =>
    blockedGuidance(guidance.message, [
      `Confirme se ${context.targetName} é o destino correto para este arquivo.`,
      'Rejeite este lote. Depois, crie um novo lote e escolha a conta ou o cartão correto.',
    ]),
  destination_conflict: (guidance, context) =>
    blockedGuidance(guidance.message, [
      `Confirme se ${context.targetName} é o destino correto para este arquivo.`,
      'Rejeite este lote. Depois, crie um novo lote e escolha a conta ou o cartão correto.',
    ]),
  missing_statement_transactions: (guidance) =>
    blockedGuidance(guidance.message, [
      'Confira as autorizações listadas em “não constam na fatura”.',
      'Se foram canceladas ou expiraram, confirme a ausência. O app preservará essa decisão na auditoria.',
      'Depois, revise as categorias restantes e clique em Consolidar.',
    ]),
  statement_match_candidates: (guidance) =>
    blockedGuidance(guidance.message, [
      'Compare as linhas do PDF com os lançamentos pendentes sugeridos abaixo.',
      'Clique em Vincular no par correto. A data, a descrição ou o valor do lançamento serão atualizados com auditoria.',
      'Depois que todas as diferenças forem resolvidas, revise as categorias e clique em Consolidar.',
    ]),
  invalid_rows: (guidance) =>
    blockedGuidance(guidance.message, [
      'Rejeite este lote e exporte o extrato novamente. Prefira OFX ou CSV.',
      'Envie o novo arquivo e confira se todos os lançamentos foram lidos.',
    ]),
  balance_mismatch: (guidance, context) => {
    const targetKind = guidance.targetType === 'account' ? 'conta' : 'cartão'
    return blockedGuidance(guidance.message, [
      `Confira se o arquivo pertence à ${targetKind} ${context.targetName}.`,
      guidance.balanceDifferenceCents === null
        ? 'Os saldos não conferem. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.'
        : `O saldo difere em ${formatCurrency(Math.abs(guidance.balanceDifferenceCents), context.currency)}. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.`,
    ])
  },
  blocked: (guidance) =>
    guidance.reason === 'currency_mismatch'
      ? blockedGuidance(
          'Uma linha da fatura e o lançamento com o mesmo identificador estão em moedas diferentes.',
          [
            'Rejeite este lote e confira a moeda do arquivo e do cartão.',
            'Corrija a origem dos dados e importe a fatura novamente.',
          ],
        )
      : blockedGuidance(guidance.message, [
          'Rejeite este lote e confira se selecionou a conta ou o cartão correto.',
          'Exporte o extrato novamente, prefira OFX ou CSV, e crie um novo lote.',
        ]),
} satisfies GuidanceCopyFactories

export function effectiveImportReviewValidationMessage(input: {
  persistedReason: ImportAuditReasonCode | null
  effectiveReason: ImportAuditReasonCode | null
  persistedMessage: string | null
}) {
  if (input.effectiveReason === input.persistedReason) {
    return input.persistedMessage
  }
  if (input.effectiveReason === 'identical_file') {
    return IDENTICAL_FILE_CONFLICT_MESSAGE
  }
  if (input.effectiveReason === 'destination_conflict') {
    return DESTINATION_CONFLICT_MESSAGE
  }
  if (input.effectiveReason === 'blocked') {
    return importReviewGuidanceCopy.blocked({
      kind: 'blocked',
      targetType: 'account',
      message: null,
      reason: 'generic',
    }).explanation
  }
  return input.persistedMessage
}

export const importCoverageProvenanceCopy: Record<
  ImportCoverageSource,
  string
> = {
  filename: 'Período identificado no nome do arquivo. ',
  metadata: 'Período informado pelo banco. ',
  user: 'Período confirmado por você. ',
  activity: 'Somente dias com movimentação; não prova cobertura completa. ',
  unknown: 'Somente dias com movimentação; não prova cobertura completa. ',
}

export function getImportBalanceReviewCopy(
  balanceReview: ImportBalanceReview,
  currency?: string,
) {
  switch (balanceReview.kind) {
    case 'difference':
      return `Diferença de saldo: ${formatCurrency(balanceReview.differenceCents, currency)}.`
    case 'missing':
      return balanceReview.targetType === 'account'
        ? 'Saldo final não informado.'
        : 'Total da fatura não informado.'
    case 'missing_anchor':
      return 'Sem saldo anterior compatível.'
  }
}
