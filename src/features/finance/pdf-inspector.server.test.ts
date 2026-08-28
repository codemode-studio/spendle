import type { TextItem } from '@firecrawl/pdf-inspector'
import { describe, expect, it } from 'vitest'

import {
  classifyClosingBalanceLabel,
  detectIdentity,
  groupPositionedTextIntoLines,
  parseLocalizedMoney,
} from './pdf-inspector.server'
import { parseInterCardTransactions } from './pdf-parsers/inter-card-v1.server'
import { parseMercadoPagoAccountTransactions } from './pdf-parsers/mercado-pago-account-v1.server'
import { parseNubankAccountTransactions } from './pdf-parsers/nubank-account-v1.server'
import { parseNubankCardTransactions } from './pdf-parsers/nubank-card-v1.server'
import { selectPdfStatementParser } from './pdf-parsers/registry.server'

function textItem(text: string, page: number, x: number, y: number) {
  return {
    text,
    page,
    x,
    y,
    width: text.length * 5,
    height: 10,
    font: 'Inter',
    fontTag: 'F1',
    fontSize: 10,
    isBold: false,
    isItalic: false,
    isUnderline: false,
    isStrikeout: false,
    itemType: 'Text',
  } as TextItem
}

describe('extração posicional de PDF', () => {
  it('seleciona o layout institucional antes de validar o emissor', () => {
    const nubank = selectPdfStatementParser({
      text: `
        Nu Financeira S.A. nubank.com.br
        Saldo final do período Total de entradas Movimentações
        Pix enviado para MERCADO PAGO IP LTDA.
      `,
      lines: [],
      currency: 'BRL',
      institution: 'Mercado Pago',
      kind: 'card_statement',
    })
    const mercadoPago = selectPdfStatementParser({
      text: `
        EXTRATO DE CONTA
        DETALHE DOS MOVIMENTOS
        Data Descrição ID da operação Valor Saldo
        Mercado Pago Instituição de Pagamento Ltda. mercadopago.com.br
        Pix enviado para NU PAGAMENTOS S.A.
      `,
      lines: [],
      currency: 'BRL',
      institution: 'Nubank',
      kind: 'card_statement',
    })
    const interCard = selectPdfStatementParser({
      text: `
        Banco Inter S/A inter.co/atendimento
        Resumo da fatura Fatura atual Despesas da fatura
        CARTÃO 5364****3879
      `,
      lines: [],
      currency: 'BRL',
      institution: null,
      kind: 'unknown',
    })
    const nubankCard = selectPdfStatementParser({
      text: `
        Nu Pagamentos S.A.
        Resumo da fatura atual Período vigente
        Total de compras de todos os cartões Transações
      `,
      lines: [],
      currency: 'BRL',
      institution: null,
      kind: 'unknown',
    })

    expect(nubank?.id).toBe('nubank/account-statement/v1')
    expect(mercadoPago?.id).toBe('mercado-pago/account-statement/v1')
    expect(interCard?.id).toBe('inter/card-statement/v1')
    expect(nubankCard?.id).toBe('nubank/card-statement/v1')
  })

  it('lê compras do Inter, ignora o pagamento e reposiciona parcelas antigas', () => {
    const lines = groupPositionedTextIntoLines([
      textItem(
        'Este é o valor que você precisa pagar nesse mês 15/05/2026',
        1,
        20,
        500,
      ),
      textItem('Fatura atual R$ 350,00', 2, 20, 100),
      textItem('Despesas da fatura', 3, 20, 550),
      textItem('CARTÃO 5364****3879', 3, 20, 520),
      textItem(
        '20 de mar. 2026 Compra antiga (Parcela 02 de 03) - R$ 100,00',
        3,
        20,
        480,
      ),
      textItem('09 de abr. 2026 PAGAMENTO ON LINE - + R$ 500,00', 3, 20, 460),
      textItem(
        '10 de abr. 2026 PAGAMENTO*Estetica T (Parcela 01 de 03) - R$ 250,00',
        3,
        20,
        440,
      ),
      textItem('Data de corte: 08/06/2026', 7, 230, 530),
    ])

    expect(
      parseInterCardTransactions({ lines, currency: 'BRL' }),
    ).toMatchObject({
      sourceTransactionCount: 2,
      controls: {
        closingBalanceCents: 35_000,
        balanceAsOf: '2026-05-08',
        periodStart: '2026-04-09',
        periodEnd: '2026-05-08',
        dueDate: '2026-05-15',
      },
      transactions: [
        {
          postedAt: '2026-04-20',
          description: 'Compra antiga (Parcela 02 de 03)',
          amountCents: -10_000,
        },
        {
          postedAt: '2026-04-10',
          description: 'PAGAMENTO*Estetica T (Parcela 01 de 03)',
          amountCents: -25_000,
        },
      ],
    })
  })

  it('lê compras e outros lançamentos do Nubank sem importar o pagamento', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('Data de vencimento: 10 AGO 2026', 1, 120, 440),
      textItem('Período vigente: 02 JUL a 02 AGO', 1, 120, 415),
      textItem('Total a pagar R$ 350,00', 4, 140, 615),
      textItem('TRANSAÇÕES DE 02 JUL A 02 AGO', 5, 50, 730),
      textItem(
        '02 JUL •••• 2923 Compra parcelada - Parcela 3/5 R$ 100,00',
        5,
        120,
        640,
      ),
      textItem('11 JUL Plano NuCel R$ 250,00', 5, 120, 610),
      textItem('08 JUL Pagamento em 08 JUL −R$ 500,00', 5, 120, 580),
    ])

    expect(
      parseNubankCardTransactions({ lines, currency: 'BRL' }),
    ).toMatchObject({
      sourceTransactionCount: 2,
      controls: {
        closingBalanceCents: 35_000,
        balanceAsOf: '2026-08-02',
        periodStart: '2026-07-02',
        periodEnd: '2026-08-02',
        dueDate: '2026-08-10',
      },
      transactions: [
        {
          postedAt: '2026-07-02',
          description: 'Compra parcelada - Parcela 3/5',
          amountCents: -10_000,
        },
        {
          postedAt: '2026-07-11',
          description: 'Plano NuCel',
          amountCents: -25_000,
        },
      ],
    })
  })

  it('não aplica parser bancário a um layout desconhecido', () => {
    expect(
      selectPdfStatementParser({
        text: 'Pix enviado para MERCADO PAGO IP LTDA. no valor de R$ 10,00',
        lines: [],
        currency: 'BRL',
        institution: 'Mercado Pago',
        kind: 'bank_statement',
      }),
    ).toBeNull()
  })

  it('identifica o emissor do extrato sem confundi-lo com contrapartes', () => {
    const text = `
      Nu Financeira S.A. - Sociedade de Crédito, Financiamento e Investimento
      Nu Pagamentos S.A. - Instituição de Pagamento
      disponíveis em nubank.com.br/contatos
      CPF Agência Conta 5468660-7
      Saldo inicial 101,30
      Saldo final do período 26,07
      Movimentações
      Transferência enviada pelo Pix
      MERCADO PAGO IP LTDA. Agência: 1
      Pagamento de fatura 23.254,90
    `

    expect(detectIdentity(text, 'BRL')).toMatchObject({
      institution: 'Nubank',
      kind: 'bank_statement',
      lastFour: '6607',
      currency: 'BRL',
    })
  })

  it('interpreta o agrupamento de entradas e saídas do extrato Nubank', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('Movimentações', 1, 57, 560),
      textItem('01 AGO 2026 Total de entradas + 1.586,49', 1, 57, 538),
      textItem('Crédito em conta 1.586,49', 1, 120, 517),
      textItem('Total de saídas - 1.600,00', 1, 120, 483),
      textItem('Transferência enviada pelo Pix 1.600,00', 1, 120, 462),
      textItem('07 AGO 2026 Total de entradas + 25.000,00', 1, 57, 377),
      textItem(
        'Transferência recebida pelo Pix EMPRESA 00.000.000/0001- 25.000,00',
        1,
        120,
        356,
      ),
      textItem('Total de saídas - 24.987,79', 1, 120, 282),
      textItem('Pagamento de fatura 23.254,90', 1, 120, 261),
      textItem('Transferência enviada pelo Pix 1.732,89', 1, 120, 240),
      textItem('17 AGO 2026 Total de saídas - 73,93', 1, 57, 155),
      textItem('Débito em conta 73,93', 2, 120, 673),
      textItem(
        'O saldo líquido corresponde ao total de depósitos e rendimentos em conta.',
        2,
        57,
        621,
      ),
    ])

    expect(parseNubankAccountTransactions({ lines, currency: 'BRL' })).toEqual([
      expect.objectContaining({ postedAt: '2026-08-01', amountCents: 158_649 }),
      expect.objectContaining({
        postedAt: '2026-08-01',
        amountCents: -160_000,
      }),
      expect.objectContaining({
        postedAt: '2026-08-07',
        amountCents: 2_500_000,
      }),
      expect.objectContaining({
        postedAt: '2026-08-07',
        amountCents: -2_325_490,
      }),
      expect.objectContaining({
        postedAt: '2026-08-07',
        amountCents: -173_289,
      }),
      expect.objectContaining({ postedAt: '2026-08-17', amountCents: -7_393 }),
    ])
  })

  it('bloqueia o extrato Nubank quando um grupo não fecha', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('Movimentações', 1, 57, 560),
      textItem('01 AGO 2026 Total de entradas + 100,00', 1, 57, 538),
      textItem('Crédito em conta 90,00', 1, 120, 517),
      textItem(
        'O saldo líquido corresponde ao total de depósitos e rendimentos em conta.',
        1,
        57,
        490,
      ),
    ])

    expect(() =>
      parseNubankAccountTransactions({ lines, currency: 'BRL' }),
    ).toThrow(/total de entradas.*não fecha/i)
  })

  it('agrupa fragmentos por página e coordenada vertical', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('01/06/2026', 1, 10, 20),
      textItem('Pix recebido', 1, 90, 20.8),
      textItem('1.234,56 C', 1, 250, 20.2),
      textItem('02/06/2026 Compra 50,00 D', 1, 10, 40),
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      text: '01/06/2026 Pix recebido 1.234,56 C',
      bounds: { page: 1 },
    })
  })

  it('preserva sinal e evidência da linha', () => {
    const lines = groupPositionedTextIntoLines([
      textItem(
        '01-06-2026 Pix recebido 1744539409425 R$ 1.234,56 R$ 2.000,00',
        2,
        10,
        40,
      ),
      textItem(
        '02-06-2026 Compra mercado 161200559281 R$ -50,00 R$ 1.950,00',
        2,
        10,
        20,
      ),
    ])
    expect(
      parseMercadoPagoAccountTransactions({
        lines,
        currency: 'BRL',
      }),
    ).toMatchObject([
      {
        postedAt: '2026-06-01',
        amountCents: 123_456,
        raw: { bounds: { page: 2 } },
      },
      { postedAt: '2026-06-02', amountCents: -5_000 },
    ])
  })

  it('usa Valor, não Saldo, em extratos do Mercado Pago', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('01-06-2026', 1, 40, 130),
      textItem('Rendimentos', 1, 120, 130),
      textItem('1744539409425', 1, 260, 130),
      textItem('R$ 0,29', 1, 400, 130),
      textItem('R$ 618,44', 1, 500, 130),
      textItem('01-06-2026', 1, 40, 100),
      textItem('Pix enviado WHOOSH BR', 1, 120, 100),
      textItem('161200559281', 1, 260, 100),
      textItem('R$ -20,00', 1, 400, 100),
      textItem('R$ 598,44', 1, 500, 100),
    ])

    expect(
      parseMercadoPagoAccountTransactions({
        lines,
        currency: 'BRL',
      }),
    ).toMatchObject([
      {
        postedAt: '2026-06-01',
        description: 'Rendimentos',
        externalId: '1744539409425',
        amountCents: 29,
      },
      {
        postedAt: '2026-06-01',
        description: 'Pix enviado WHOOSH BR',
        externalId: '161200559281',
        amountCents: -2_000,
      },
    ])
  })

  it('reúne descrições quebradas em várias linhas', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('03-06-2026', 1, 40, 200),
      textItem('161510117955', 1, 260, 200),
      textItem('R$ 2.900,00', 1, 400, 200),
      textItem('R$ 3.315,90', 1, 500, 200),
      textItem('Pix recebido DONALD', 1, 120, 208),
      textItem('LOURENCO SILV', 1, 120, 192),
    ])

    expect(
      parseMercadoPagoAccountTransactions({
        lines,
        currency: 'BRL',
      }),
    ).toMatchObject([
      {
        description: 'Pix recebido DONALD LOURENCO SILV',
        externalId: '161510117955',
        amountCents: 290_000,
      },
    ])
  })

  it('interpreta formatos monetários brasileiros sem ponto flutuante', () => {
    expect(parseLocalizedMoney('R$ 1.234,56 CR')).toEqual({
      cents: 123_456,
      explicit: true,
    })
    expect(parseLocalizedMoney('(89,90)')).toEqual({
      cents: -8_990,
      explicit: true,
    })
    expect(parseLocalizedMoney('R$ -325,14')).toEqual({
      cents: -32_514,
      explicit: true,
    })
  })

  it('interpreta oito casas decimais de BTC como satoshis', () => {
    expect(parseLocalizedMoney('BTC 0,00000001 CR', 'BTC')).toEqual({
      cents: 1,
      explicit: true,
    })
  })

  it('preserva saldo disponível como observação, não como saldo contábil', () => {
    expect(
      classifyClosingBalanceLabel('Saldo disponível R$ 1.234,56', 'account'),
    ).toBe('available')
    expect(
      classifyClosingBalanceLabel('Saldo final R$ 1.234,56', 'account'),
    ).toBe('posted')
  })
})
