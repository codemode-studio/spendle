/**
 * Builds a one-page text PDF without bank or customer data, the way V1's
 * `generate-pdf-fixture.mjs` did. Each entry is a line of Helvetica text,
 * stacked from the top unless it gives its own position. Text must be ASCII.
 */
export const syntheticPdf = (
  entries: ReadonlyArray<
    string | { readonly text: string; readonly x: number; readonly y: number }
  >,
): Uint8Array => {
  const escape = (text: string) =>
    text.replace(/[\\()]/g, (char) => `\\${char}`)
  const content = entries
    .map((entry, index) => {
      const { text, x, y } =
        typeof entry === 'string'
          ? { text: entry, x: 36, y: 790 - index * 20 }
          : entry
      return `BT /F1 10 Tf ${x} ${y} Td (${escape(text)}) Tj ET`
    })
    .join('\n')
  const encoder = new TextEncoder()
  const length = (text: string) => encoder.encode(text).length
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${length(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: Array<number> = []
  for (const [index, object] of objects.entries()) {
    offsets.push(length(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = length(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(pdf)
}

/** A text fragment as the PDF extractor would report it. */
export const positionedText = (
  text: string,
  page: number,
  x: number,
  y: number,
) => ({
  text,
  page,
  x,
  y,
  width: text.length * 5,
  height: 10,
  itemType: 'Text',
})

/** Layout input whose lines are the given text, top to bottom on page 1. */
export const textLayout = (text: string) => ({
  text,
  lines: text.split('\n').map((line, index) => ({
    text: line,
    bounds: { page: 1, x: 0, y: 1000 - index, width: 100, height: 1 },
  })),
})

/** A Mercado Pago account statement with made-up rows. */
export const mercadoPagoStatement = [
  'EXTRATO DE CONTA - FIXTURE SINTETICA',
  'Mercado Pago Instituicao de Pagamento Ltda. mercadopago.com.br',
  'Periodo: 01-08-2026 a 02-08-2026',
  'Saldo inicial: R$ 0,00',
  'Entradas: R$ 1.000,00',
  'Saidas: R$ 100,00',
  'Saldo final: R$ 900,00',
  'DETALHE DOS MOVIMENTOS',
  'Data Descricao ID da operacao Valor Saldo',
  '01-08-2026 Receita sintetica 90000001 R$ 1.000,00 R$ 1.000,00',
  '02-08-2026 Mercado sintetico 90000002 R$ -100,00 R$ 900,00',
]
