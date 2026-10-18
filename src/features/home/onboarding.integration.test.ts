import { afterEach, describe, expect, it } from 'vite-plus/test'

import { api } from '#/lib/api/client.server'
import { startTestApi } from '#/test/api'
import type { TestApi } from '#/test/api'

import { hasActiveRecurrences, ledgerSetup } from './onboarding.server'

let testApi: TestApi | undefined
afterEach(async () => {
  await testApi?.close()
  testApi = undefined
})

const statement = `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>20260801<DTEND>20260831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260815<TRNAMT>-10.01<FITID>setup-1<MEMO>Despesa de teste</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-10.01<DTASOF>20260831</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

describe('onboarding status', () => {
  it('completes categorization only after every entry has a decided category', async () => {
    testApi = await startTestApi()
    expect(await api(ledgerSetup)).toEqual({
      accounts: false,
      transactions: false,
      categories: false,
      uncategorizedCount: 0,
    })
    const owner = await api((client) =>
      client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
    )
    const account = await api((client) =>
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
    await api((client) => client.imports.upload({ payload: upload }))
    await testApi.drain()
    expect(await api(ledgerSetup)).toEqual({
      accounts: true,
      transactions: true,
      categories: false,
      uncategorizedCount: 1,
    })

    const [entry] = (await api((client) => client.entries.list({ query: {} })))
      .entries
    const [category] = (
      await api((client) => client.categories.list({ query: {} }))
    ).filter((item) => !item.system && item.bucket !== 'income')
    await api((client) =>
      client.categoryDecisions.decide({
        params: { entryId: entry.id },
        payload: { categoryId: category.id },
      }),
    )
    expect(await api(ledgerSetup)).toMatchObject({
      categories: true,
      uncategorizedCount: 0,
    })
  })

  it('does not treat a paused recurrence as set up', async () => {
    testApi = await startTestApi()
    const { id } = await api((client) =>
      client.recurrences.create({
        payload: {
          name: 'Internet QA',
          accountId: null,
          categoryId: 'utilities',
          amountCents: 10000,
          currency: 'BRL',
          direction: 'expense',
          amountMode: 'fixed',
          matchMode: 'single',
          destinationMode: 'automatic',
          frequency: 'monthly',
          nextDate: '2026-10-01',
        },
      }),
    )
    expect(await api(hasActiveRecurrences)).toBe(true)
    await api((client) =>
      client.recurrences.active({
        params: { recurrenceId: id },
        payload: { active: false },
      }),
    )
    expect(await api(hasActiveRecurrences)).toBe(false)
  })
})
