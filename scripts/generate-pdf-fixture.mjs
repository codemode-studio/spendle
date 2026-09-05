// Synthetic text PDF, generated without bank/customer data or a PDF runtime dependency.
import { writeFileSync } from 'node:fs'

const lines = [
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
const content = lines
  .map(
    (line, index) => `BT /F1 10 Tf 36 ${790 - index * 30} Td (${line}) Tj ET`,
  )
  .join('\n')
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
]
let pdf = '%PDF-1.4\n'
const offsets = [0]
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf))
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
}
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
pdf += offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
  .join('')
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
writeFileSync(
  new URL(
    '../src/features/finance/fixtures/synthetic-mercado-pago.pdf',
    import.meta.url,
  ),
  pdf,
)
