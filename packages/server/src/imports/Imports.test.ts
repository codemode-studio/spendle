import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

import { EventLog } from '../events/EventLog.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import { ImportsTest } from '../testing/layers.ts'
import { Imports } from './Imports.ts'

const utf8 = (text: string) => new TextEncoder().encode(text)

const ofx = (currency = 'BRL', extra = '') =>
  utf8(`OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${currency}
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>1000.00<FITID>a1<MEMO>Salário</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910<TRNAMT>-100.00<FITID>a2<MEMO>Padaria</STMTTRN>${extra}
</BANKTRANLIST><LEDGERBAL><BALAMT>900.00<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`)

const setup = Effect.gen(function* () {
  const accounts = yield* Accounts
  const owner = yield* accounts.createOwner({ name: 'Donald', kind: 'person' })
  const open = (name: string) =>
    accounts.open({
      ownerId: owner.id,
      institutionName: 'Nubank',
      name,
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    })
  const card = yield* accounts.open({
    ownerId: owner.id,
    institutionName: 'Nubank',
    name: 'Cartão',
    kind: 'credit_card',
    purpose: 'operating',
    currency: 'BRL',
    card: new CardTerms({
      closingDay: 3,
      dueDay: 10,
      limitCents: null,
      lastFour: '1889',
    }),
  })
  return {
    imports: yield* Imports,
    observations: yield* Observations,
    open,
    card,
  }
})

describe('Imports', () => {
  it.effect(
    'records a statement once, however often the file is uploaded',
    () =>
      Effect.gen(function* () {
        const { imports, observations, open } = yield* setup
        const account = yield* open('Conta')

        const first = yield* imports.importFile({
          accountId: account.id,
          fileName: 'set.ofx',
          bytes: ofx(),
        })
        const again = yield* imports.importFile({
          accountId: account.id,
          fileName: 'copia.ofx',
          bytes: ofx(),
        })

        assert.deepStrictEqual(
          [
            first.recorded,
            first.alreadyImported,
            again.alreadyImported,
            again.importId === first.importId,
          ],
          [2, false, true, true],
        )
        assert.deepStrictEqual(
          [
            first.inflowCents,
            first.outflowCents,
            first.period,
            first.closingBalance,
          ],
          [
            100000,
            -10000,
            { start: '2026-09-01', end: '2026-09-30' },
            { asOf: '2026-09-30', cents: 90000 },
          ],
        )
        const current = yield* observations.current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.amountCents,
            observation.status,
          ]),
          [
            ['id:a1@1', 100000, 'posted'],
            ['id:a2@1', -10000, 'posted'],
          ],
        )
        const sql = yield* SqlClient.SqlClient
        const balances = yield* sql<{ kind: string; balanceCents: number }>`
        SELECT kind, balance_cents AS balanceCents FROM balance_observations
      `
        assert.deepStrictEqual(balances, [
          { kind: 'statement', balanceCents: 90000 },
        ])
        const imported = (yield* (yield* EventLog).readAfter(0, 50)).filter(
          (event) => event.type === 'FileImported',
        )
        assert.strictEqual(imported.length, 1)
      }).pipe(Effect.provide(ImportsTest)),
  )

  it.effect('refuses a file already imported into another account', () =>
    Effect.gen(function* () {
      const { imports, open } = yield* setup
      const first = yield* open('Conta A')
      const second = yield* open('Conta B')
      yield* imports.importFile({
        accountId: first.id,
        fileName: 'set.ofx',
        bytes: ofx(),
      })

      const error = yield* imports
        .importFile({ accountId: second.id, fileName: 'set.ofx', bytes: ofx() })
        .pipe(Effect.flip)
      assert.strictEqual(
        error._tag === 'ImportRejected' && error.reason,
        'imported_to_other_account',
      )
    }).pipe(Effect.provide(ImportsTest)),
  )

  it.effect(
    'refuses files that cannot belong to the account without storing anything',
    () =>
      Effect.gen(function* () {
        const { imports, observations, open, card } = yield* setup
        const account = yield* open('Conta')
        const reasons = yield* Effect.forEach(
          [
            { accountId: account.id, bytes: ofx('USD') },
            { accountId: account.id, bytes: utf8('%PDF-1.7 binary') },
            {
              accountId: card.id,
              bytes:
                utf8(`<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL
              <CCACCTFROM><ACCTID>5555********4242</CCACCTFROM><BANKTRANLIST></BANKTRANLIST>
              </CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`),
            },
          ],
          (input) =>
            imports.importFile({ ...input, fileName: 'x' }).pipe(
              Effect.flip,
              Effect.map((error) =>
                error._tag === 'ImportRejected' ? error.reason : error._tag,
              ),
            ),
        )

        assert.deepStrictEqual(reasons, [
          'currency_mismatch',
          'unsupported_format',
          'account_mismatch',
        ])
        assert.strictEqual((yield* observations.current(account.id)).length, 0)
      }).pipe(Effect.provide(ImportsTest)),
  )

  it.effect('reads a card export with purchases as outflows', () =>
    Effect.gen(function* () {
      const { imports, observations, card } = yield* setup
      yield* imports.importFile({
        accountId: card.id,
        fileName: 'nubank-2026-09.csv',
        bytes: utf8(
          'date,title,amount\n2026-09-12,Mercado,89.90\n2026-09-20,Pagamento recebido,-500.00\n',
        ),
      })
      const current = yield* observations.current(card.id)
      assert.deepStrictEqual(
        current.map((observation) => [
          observation.description,
          observation.amountCents,
        ]),
        [
          ['Mercado', -8990],
          ['Pagamento recebido', 50000],
        ],
      )
    }).pipe(Effect.provide(ImportsTest)),
  )

  it.effect('previews a file without storing it', () =>
    Effect.gen(function* () {
      const { imports, observations, open } = yield* setup
      const account = yield* open('Conta')
      const preview = yield* imports.preview({
        accountId: account.id,
        bytes: ofx(),
      })
      assert.deepStrictEqual(
        [preview.lineCount, preview.firstDate, preview.lastDate],
        [2, '2026-09-05', '2026-09-10'],
      )
      assert.strictEqual((yield* observations.current(account.id)).length, 0)
    }).pipe(Effect.provide(ImportsTest)),
  )

  it.effect('refuses a card OFX for a bank account', () =>
    Effect.gen(function* () {
      const { imports, open } = yield* setup
      const account = yield* open('Conta')
      const error = yield* imports
        .importFile({
          accountId: account.id,
          fileName: 'cartao.ofx',
          bytes: utf8(
            '<OFX><CCSTMTRS><CURDEF>BRL<BANKTRANLIST></BANKTRANLIST></CCSTMTRS></OFX>',
          ),
        })
        .pipe(Effect.flip)
      assert.strictEqual(
        error._tag === 'ImportRejected' && error.reason,
        'account_mismatch',
      )
    }).pipe(Effect.provide(ImportsTest)),
  )
})
