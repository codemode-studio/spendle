import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { drain } from '../../testing/FakePluggy.ts'

const ofx = (closing = '900.00') => `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>1000.00<FITID>a1<MEMO>Salário</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910<TRNAMT>-100.00<FITID>a2<MEMO>Padaria</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>${closing}<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

const form = (accountId: string, content: string, name = 'setembro.ofx') => {
  const data = new FormData()
  data.append('accountId', accountId)
  data.append('file', new Blob([content]), name)
  return data
}

const withAccount = Effect.gen(function* () {
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Donald', kind: 'person' },
  })
  const account = yield* client.accounts.open({
    payload: {
      ownerId: owner.id,
      institutionName: 'Itaú',
      name: 'Conta',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    },
  })
  return { client, account }
})

describe('imports API', () => {
  it.effect('previews, imports once and lists a statement', () =>
    Effect.gen(function* () {
      const { client, account } = yield* withAccount
      const preview = yield* client.imports.preview({
        payload: form(account.id, ofx()),
      })
      const first = yield* client.imports.upload({
        payload: form(account.id, ofx()),
      })
      const again = yield* client.imports.upload({
        payload: form(account.id, ofx(), 'copia.ofx'),
      })
      yield* drain
      const listed = yield* client.imports.list({
        query: { accountId: account.id },
      })
      const checked = yield* client.accounts.get({
        params: { accountId: account.id },
      })

      assert.deepStrictEqual(
        {
          preview: [
            preview.lineCount,
            preview.inflowCents,
            preview.outflowCents,
          ],
          first: [first.recorded, first.alreadyImported],
          again: again.alreadyImported,
          listed: listed.map((found) => [found.fileName, found.format]),
          checkpoint: checked.lastCheckpoint?.balanceCents,
        },
        {
          preview: [2, 100000, -10000],
          first: [2, false],
          again: true,
          listed: [['setembro.ofx', 'ofx']],
          checkpoint: 90000,
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('refuses a file that is not a statement', () =>
    Effect.gen(function* () {
      const { client, account } = yield* withAccount
      const refused = yield* client.imports
        .upload({ payload: form(account.id, 'not a statement', 'x.txt') })
        .pipe(Effect.flip)
      const missing = yield* client.imports
        .preview({ payload: form('nope', ofx()) })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [refused, missing].map((error) => [
          error._tag,
          'reason' in error ? error.reason : null,
        ]),
        [
          ['Rejected', 'no_statement'],
          ['NotFound', 'account_not_found'],
        ],
      )
      assert.deepStrictEqual(yield* client.imports.list({ query: {} }), [])
    }).pipe(Effect.provide(apiTest())),
  )
})
