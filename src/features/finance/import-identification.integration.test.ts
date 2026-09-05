import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openTestDatabase } from '#/test/database'
import * as schema from '#/db/schema'
import { qaIds } from '#/db/qa-seed.server'
import {
  identifyImportFiles,
  matchImportTargets,
  validateImportFiles,
} from './import-identification.server'
import type { ImportTarget } from './import-identification.server'

const target: ImportTarget = {
  key: 'account:a',
  type: 'account',
  institution: 'Nubank',
  currency: 'BRL',
  identifiers: ['12345678'],
}
describe('import destination identification', () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>> | undefined
  afterEach(() => {
    database?.close()
    database = undefined
  })
  it('does not guess from bank alone, mismatched currency or conflicting identifiers', () => {
    const identity = {
      type: 'account' as const,
      institution: 'Nubank',
      identifier: null,
      currency: 'BRL',
    }
    expect(matchImportTargets(identity, [target])).toEqual([])
    expect(
      matchImportTargets({ ...identity, identifier: '5678' }, [
        target,
        { ...target, key: 'account:b' },
      ]),
    ).toHaveLength(2)
    expect(
      matchImportTargets({ ...identity, identifier: '5678', currency: 'USD' }, [
        target,
      ]),
    ).toEqual([])
    expect(
      matchImportTargets({ ...identity, identifier: '99995678' }, [target]),
    ).toEqual([])
  })
  it('identifies mixed OFX destinations, additional cards and CSV metadata; asks for generic CSV', async () => {
    database = await openTestDatabase({ seed: 'minimal' })
    await database.db
      .update(schema.accounts)
      .set({ externalId: '987654' })
      .where(eq(schema.accounts.id, qaIds.brlAccount))
    await database.db
      .insert(schema.creditCardInstruments)
      .values({
        id: 'virtual',
        creditCardId: qaIds.card,
        lastFour: '5678',
        kind: 'virtual',
      })
    const form = new FormData()
    form.append(
      'files',
      new File(['<STMTRS><CURDEF>BRL<ACCTID>987654</STMTRS>'], 'account.ofx'),
    )
    form.append(
      'files',
      new File(
        ['<CCSTMTRS><CURDEF>BRL<ACCTID>99995678</CCSTMTRS>'],
        'card.ofx',
      ),
    )
    form.append(
      'files',
      new File(['Conta;987654\nData;Descricao;Valor'], 'metadata.csv'),
    )
    form.append(
      'files',
      new File(['Data,Descricao,Valor\n2026-01-01,Compra,10'], 'generic.csv'),
    )
    expect(
      (await identifyImportFiles(form)).map((item) => item.target),
    ).toEqual([
      `account:${qaIds.brlAccount}`,
      `card:${qaIds.card}`,
      `account:${qaIds.brlAccount}`,
      '',
    ])
  })
  it('rejects unsupported, empty and excessive uploads before reading them', () => {
    const form = new FormData()
    form.append('files', new File(['x'], 'bad.exe'))
    expect(() => validateImportFiles(form)).toThrow()
    expect(() => validateImportFiles(new FormData())).toThrow()
    form.delete('files')
    for (let i = 0; i < 25; i++)
      form.append('files', new File(['x'], `${i}.csv`))
    expect(() => validateImportFiles(form)).toThrow()
  })
})
