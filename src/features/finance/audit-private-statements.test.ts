import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

import { readStatement } from './statement-reader.server'

interface EvidenceRow {
  source: string
  account: string
  cycle: string | null
  currency: string
  cents: number
  flow: string
}
interface EvidenceLedger {
  inventory: Array<{ file: string }>
  transactions: EvidenceRow[]
}
const ledgerPath = process.env.AUDIT_LEDGER_PATH
const statementDirectory = process.env.AUDIT_STATEMENT_DIRECTORY

it.skipIf(!ledgerPath || !statementDirectory)(
  'confere todos os documentos com uma extração independente fornecida localmente',
  async () => {
    const ledger = JSON.parse(
      await readFile(ledgerPath!, 'utf8'),
    ) as EvidenceLedger
    const results = []
    for (const entry of ledger.inventory) {
      const filename = entry.file
      const rows = ledger.transactions.filter((row) => row.source === filename)
      const expected = rows.filter(
        (row) => !(row.cycle && row.flow === 'pagamento de cartão'),
      )
      const result = await readStatement({
        buffer: await readFile(resolve(statementDirectory!, filename)),
        filename,
        targetType: rows.some((row) => row.cycle) ? 'card' : 'account',
        targetCurrency: rows[0]?.currency ?? 'BRL',
        targetInstitution:
          rows[0]?.account === 'Global Account'
            ? 'Inter'
            : (rows[0]?.account.split(' ')[0] ?? 'BTG'),
        targetIdentifiers: [],
        aiConsent: false,
        learnedCoverageTemplates: [],
      })
      expect(result.diagnostics.blockingReason, filename).toBeFalsy()
      expect(
        result.transactions.map((row) => row.amountCents).sort((a, b) => a - b),
        filename,
      ).toEqual(expected.map((row) => row.cents).sort((a, b) => a - b))
      results.push({
        filename,
        count: result.transactions.length,
        controls: result.controls,
      })
    }
    if (process.env.AUDIT_RESULTS_PATH)
      await writeFile(
        process.env.AUDIT_RESULTS_PATH,
        JSON.stringify(results, null, 2),
      )
  },
  120_000,
)
