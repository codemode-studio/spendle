import { afterEach, describe, expect, it } from 'vitest'

import { v2 } from '#/lib/v2/client.server'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { startV2Api } from '#/test/v2-api'
import type { V2TestApi } from '#/test/v2-api'

import { hasActiveRecurrences, ledgerSetup } from './onboarding.server'

let database: TestDatabase | undefined
let api: V2TestApi | undefined
afterEach(async () => {
  database?.close()
  await api?.close()
  database = undefined
  api = undefined
})

const statement = `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>20260801<DTEND>20260831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260815<TRNAMT>-10.01<FITID>setup-1<MEMO>Despesa de teste</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-10.01<DTASOF>20260831</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

describe('onboarding status', () => {
  it('completes categorization only after every V2 entry has a decided category', async () => {
    api = await startV2Api()
    expect(await v2(ledgerSetup)).toEqual({
      accounts: false,
      transactions: false,
      categories: false,
      uncategorizedCount: 0,
    })
    const owner = await v2((client) =>
      client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
    )
    const account = await v2((client) =>
      client.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Banco',
          name: 'Conta',
          kind: 'checking',
          purpose: 'operating',
          currency: 'BRL',
        },
      }),
    )
    const upload = new FormData()
    upload.append('accountId', account.id)
    upload.append('file', new Blob([statement]), 'agosto.ofx')
    await v2((client) => client.imports.upload({ payload: upload }))
    await api.drain()
    expect(await v2(ledgerSetup)).toEqual({
      accounts: true,
      transactions: true,
      categories: false,
      uncategorizedCount: 1,
    })

    const [entry] = (await v2((client) => client.entries.list({ query: {} })))
      .entries
    const [category] = (
      await v2((client) => client.categories.list({ query: {} }))
    ).filter((item) => !item.system && item.bucket !== 'income')
    await v2((client) =>
      client.categoryDecisions.decide({
        params: { entryId: entry.id },
        payload: { categoryId: category.id },
      }),
    )
    expect(await v2(ledgerSetup)).toMatchObject({
      categories: true,
      uncategorizedCount: 0,
    })
  })

  it('does not treat inactive V1 recurrences as complete', async () => {
    database = await openTestDatabase()
    const { db, schema } = database
    db.insert(schema.recurrences)
      .values({
        id: 'setup-recurring',
        name: 'Internet QA',
        amountCents: 10000,
        frequency: 'monthly',
        nextDate: '2026-10-01',
        active: false,
      })
      .run()
    expect(await hasActiveRecurrences()).toBe(false)
    db.update(schema.recurrences).set({ active: true }).run()
    expect(await hasActiveRecurrences()).toBe(true)
  })
})
