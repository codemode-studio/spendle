import { describe, expect, it } from 'vitest'

import { DESTINATION_CONFLICT_MESSAGE } from '#/domain/import-audit'
import {
  effectiveImportReviewValidationMessage,
  getImportBalanceReviewCopy,
  importCoverageProvenanceCopy,
  importReviewGuidanceCopy,
} from './import-review-guidance'

const context = {
  targetName: 'Conta da família',
  period: '01/08/2026 a 31/08/2026',
  totals: 'R$ 100,00 em créditos e R$ 20,00 em débitos',
  currency: 'BRL',
}

describe('texto da revisão de importação', () => {
  it('troca a mensagem de sucesso pela cópia do conflito efetivo', () => {
    expect(
      effectiveImportReviewValidationMessage({
        persistedReason: 'ready',
        effectiveReason: 'destination_conflict',
        persistedMessage: 'Arquivo lido com sucesso.',
      }),
    ).toBe(DESTINATION_CONFLICT_MESSAGE)
  })

  it('preserva a orientação de uma conferência automática', () => {
    expect(
      importReviewGuidanceCopy.ready({
        kind: 'ready',
        mode: 'reconciled',
        targetType: 'account',
        message: null,
      }),
    ).toEqual({
      title: 'Conferência automática concluída',
      explanation: 'A contagem, as movimentações e os saldos conferem.',
      steps: [
        'Revise as categorias dos lançamentos abaixo.',
        'Clique em Consolidar para incluir as transações nos relatórios.',
      ],
    })
  })

  it('preserva a orientação manual quando falta saldo', () => {
    expect(
      importReviewGuidanceCopy.needs_balance(
        {
          kind: 'needs_balance',
          mode: 'manual_review',
          sourceType: 'csv',
          parsedTransactionCount: 2,
          targetType: 'account',
          message: null,
        },
        context,
      ),
    ).toEqual({
      title: 'Confira estes dados antes de consolidar',
      explanation:
        'Os 2 lançamentos foram lidos, mas este CSV não informa o saldo final. Sem esse valor, o sistema não consegue provar que as movimentações fecham o saldo da conta.',
      steps: [
        'Confirme que o arquivo pertence à conta Conta da família.',
        'Compare com o extrato original: período 01/08/2026 a 31/08/2026, 2 lançamentos, R$ 100,00 em créditos e R$ 20,00 em débitos.',
        'Se estiver correto, marque a confirmação abaixo e consolide. Se algo não conferir, rejeite o lote e envie o extrato correto.',
      ],
    })
  })

  it('preserva a orientação para conflito de destino sem ler a mensagem', () => {
    expect(
      importReviewGuidanceCopy.identical_file(
        {
          kind: 'identical_file',
          targetType: 'account',
          message:
            'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
        },
        context,
      ),
    ).toEqual({
      title: 'Este lote não pode ser consolidado',
      explanation:
        'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
      steps: [
        'Confirme se Conta da família é o destino correto para este arquivo.',
        'Rejeite este lote. Depois, crie um novo lote e escolha a conta ou o cartão correto.',
      ],
    })
  })

  it('orienta rejeitar um par de mesma identidade com moedas diferentes', () => {
    expect(
      importReviewGuidanceCopy.blocked({
        kind: 'blocked',
        targetType: 'card',
        message: null,
        reason: 'currency_mismatch',
      }),
    ).toEqual({
      title: 'Este lote não pode ser consolidado',
      explanation:
        'Uma linha da fatura e o lançamento com o mesmo identificador estão em moedas diferentes.',
      steps: [
        'Rejeite este lote e confira a moeda do arquivo e do cartão.',
        'Corrija a origem dos dados e importe a fatura novamente.',
      ],
    })
  })

  it.each([
    {
      differenceCents: -500,
      expected:
        'O saldo difere em R$\u00a05,00. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.',
    },
    {
      differenceCents: null,
      expected:
        'Os saldos não conferem. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.',
    },
  ])(
    'explica a diferença de saldo $differenceCents',
    ({ differenceCents, expected }) => {
      const copy = importReviewGuidanceCopy.balance_mismatch(
        {
          kind: 'balance_mismatch',
          balanceDifferenceCents: differenceCents,
          targetType: 'account',
          message: null,
        },
        context,
      )

      expect(copy.steps[1]).toBe(expected)
    },
  )

  it('preserva as frases de proveniência e saldo', () => {
    expect(importCoverageProvenanceCopy.filename).toBe(
      'Período identificado no nome do arquivo. ',
    )
    expect(
      getImportBalanceReviewCopy(
        { kind: 'difference', differenceCents: -500 },
        'BRL',
      ),
    ).toBe('Diferença de saldo: -R$ 5,00.')
  })
})
