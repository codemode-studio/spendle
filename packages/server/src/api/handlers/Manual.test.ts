import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Statement from 'effect/sql/Statement'
import * as Tracer from 'effect/Tracer'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { drain } from '../../testing/FakePluggy.ts'

const ofx = (lines: string, start: string, end: string, closing: string) =>
  `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>${start}<DTEND>${end}
${lines}
</BANKTRANLIST><LEDGERBAL><BALAMT>${closing}<DTASOF>${end}</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

const upload = (accountId: string, content: string, name: string) => {
  const data = new FormData()
  data.append('accountId', accountId)
  data.append('file', new Blob([content]), name)
  return data
}

const september = ofx(
  `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>1000.00<FITID>a1<MEMO>Salário</STMTTRN>`,
  '20260901',
  '20260930',
  '1000.00',
)

const october = ofx(
  `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>-50.00<FITID>b1<MEMO>Farmácia Central</STMTTRN>`,
  '20261001',
  '20261003',
  '950.00',
)

const checking = Effect.gen(function* () {
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
  return { client, owner, account }
})

describe('manual entries API', () => {
  it.effect('answers a typed-in transfer once its pair is suggested', () =>
    Effect.gen(function* () {
      // Signalled when a request starts waiting for the projections.
      const settling = yield* Deferred.make<void>()
      const base = yield* Effect.tracer
      const observe = Tracer.make({
        ...(base.context ? { context: base.context } : {}),
        span: (options) => {
          if (options.name === 'Reactors.settle')
            Deferred.doneUnsafe(settling, Effect.void)
          return base.span(options)
        },
      })
      yield* Effect.gen(function* () {
        const { client, owner, account } = yield* checking
        const savings = yield* client.accounts.open({
          payload: {
            ownerId: owner.id,
            institutionName: 'Inter',
            name: 'Inter',
            kind: 'checking',
            purpose: 'operating',
            currency: 'BRL',
          },
        })
        yield* drain
        // A catch-up holds reconciliation at its cursor until a request
        // settles, so no background pass pairs the entries before then.
        const reached = yield* Deferred.make<void>()
        const hold: Statement.Transformer = (statement) => {
          const [text, params] = statement.compile()
          return text.includes('FROM reactor_cursors') &&
            params.includes('reconciliation') &&
            !Deferred.isDoneUnsafe(reached)
            ? Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(settling)),
                Effect.as(statement),
              )
            : Effect.succeed(statement)
        }
        const held = yield* drain.pipe(
          Effect.provideService(Statement.CurrentTransformer, hold),
          Effect.forkChild,
        )
        yield* Deferred.await(reached)

        for (const [accountId, amountCents, description] of [
          [account.id, -50000, 'Pix enviado Donald'],
          [savings.id, 50000, 'Pix recebido Donald'],
        ] as const) {
          yield* client.manual.createTransaction({
            payload: {
              accountId,
              bookedOn: '2026-09-12',
              amountCents,
              description,
            },
          })
        }
        // What the transactions screen reads right after the response.
        const relations = yield* client.reconciliation.relations({ query: {} })
        yield* Deferred.succeed(settling, undefined)
        yield* Fiber.join(held)

        assert.deepStrictEqual(
          relations.map((relation) => relation.kind),
          ['internal_transfer'],
        )
      }).pipe(Effect.provide(apiTest()), Effect.withTracer(observe))
    }),
  )

  it.effect(
    'records a typed-in transaction as an entry with its category and note',
    () =>
      Effect.gen(function* () {
        const { client, account } = yield* checking
        const receipt = yield* client.manual.createTransaction({
          payload: {
            accountId: account.id,
            bookedOn: '2026-09-12',
            amountCents: -4590,
            description: '  Feira do bairro  ',
            categoryId: 'groceries',
            note: 'Paguei em dinheiro',
          },
        })
        yield* drain
        const [entry] = (yield* client.entries.list({
          query: { accountId: account.id },
        })).entries
        const byNote = yield* client.entries.list({
          query: { text: 'dinheiro' },
        })
        const detail = yield* client.entries.get({
          params: { entryId: entry!.id },
        })
        assert.deepStrictEqual(
          {
            receipt: receipt.entryId === entry!.id,
            entry: [
              entry!.bookedOn,
              entry!.amountCents,
              entry!.description,
              entry!.manualId === receipt.externalId,
              entry!.note,
            ],
            category: [entry!.category?.categoryId, entry!.category?.origin],
            byNote: byNote.entries.map((found) => found.id),
            evidence: detail.evidence.map((evidence) => [
              evidence.sourceKind,
              evidence.version,
            ]),
          },
          {
            receipt: true,
            entry: [
              '2026-09-12',
              -4590,
              'Feira do bairro',
              true,
              'Paguei em dinheiro',
            ],
            category: ['groceries', 'decision'],
            byNote: [entry!.id],
            evidence: [['manual', 1]],
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'keeps every version: an edit is the next one and a deletion removes the entry',
    () =>
      Effect.gen(function* () {
        const { client, account } = yield* checking
        const { externalId } = yield* client.manual.createTransaction({
          payload: {
            accountId: account.id,
            bookedOn: '2026-09-12',
            amountCents: -4590,
            description: 'Feira',
          },
        })
        const revised = yield* client.manual.reviseTransaction({
          params: { externalId },
          payload: {
            bookedOn: '2026-09-13',
            amountCents: -5090,
            description: 'Feira do bairro',
          },
        })
        const detail = yield* client.entries.get({
          params: { entryId: revised.entryId! },
        })
        yield* client.manual.removeTransaction({ params: { externalId } })
        const after = yield* client.entries.list({
          query: { accountId: account.id },
        })
        const again = yield* client.manual
          .removeTransaction({ params: { externalId } })
          .pipe(Effect.flip)
        // Blank once trimmed: the client cannot know, the server refuses it.
        const blank = yield* client.manual
          .createTransaction({
            payload: {
              accountId: account.id,
              bookedOn: '2026-09-12',
              amountCents: -100,
              description: '  x  ',
            },
          })
          .pipe(Effect.flip)
        assert.deepStrictEqual(
          {
            edited: [
              detail.entry.bookedOn,
              detail.entry.amountCents,
              detail.entry.description,
            ],
            version: detail.evidence.map((evidence) => evidence.version),
            after: after.total,
            again: [again._tag, 'reason' in again ? again.reason : null],
            blank: [blank._tag, 'reason' in blank ? blank.reason : null],
          },
          {
            edited: ['2026-09-13', -5090, 'Feira do bairro'],
            version: [2],
            after: 0,
            again: ['NotFound', 'manual_transaction_not_found'],
            blank: ['InvalidRequest', 'invalid_input'],
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'merges with the bank line of the same movement, and the note stays when the typed one goes',
    () =>
      Effect.gen(function* () {
        const { client, account } = yield* checking
        const typed = yield* client.manual.createTransaction({
          payload: {
            accountId: account.id,
            bookedOn: '2026-10-02',
            amountCents: -5000,
            description: 'Farmácia',
          },
        })
        yield* client.manual.setNote({
          params: { entryId: typed.entryId! },
          payload: { note: 'Remédio da Ana' },
        })
        yield* client.imports.upload({
          payload: upload(account.id, october, 'out.ofx'),
        })
        yield* drain
        const merged = (yield* client.entries.list({
          query: { accountId: account.id },
        })).entries
        yield* client.manual.removeTransaction({
          params: { externalId: typed.externalId },
        })
        yield* drain
        const bankOnly = (yield* client.entries.list({
          query: { accountId: account.id },
        })).entries
        assert.deepStrictEqual(
          {
            merged: merged.map((entry) => [
              entry.sources,
              entry.note,
              entry.manualId === typed.externalId,
            ]),
            bankOnly: bankOnly.map((entry) => [
              entry.sources,
              entry.note,
              entry.manualId,
            ]),
          },
          {
            merged: [[2, 'Remédio da Ana', true]],
            bankOnly: [[1, 'Remédio da Ana', null]],
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect('updates and clears a note on any entry', () =>
    Effect.gen(function* () {
      const { client, account } = yield* checking
      yield* client.imports.upload({
        payload: upload(account.id, september, 'set.ofx'),
      })
      yield* drain
      const [salary] = (yield* client.entries.list({
        query: { accountId: account.id },
      })).entries
      const note = (text: string | null) =>
        client.manual.setNote({
          params: { entryId: salary!.id },
          payload: { note: text },
        })
      const first = yield* note('Bônus incluso')
      const second = yield* note('Sem bônus')
      const shown = (yield* client.entries.get({
        params: { entryId: salary!.id },
      })).entry.note
      const cleared = yield* note('   ')
      const after = (yield* client.entries.get({
        params: { entryId: salary!.id },
      })).entry.note
      const missing = yield* client.manual
        .setNote({ params: { entryId: 'nope' }, payload: { note: 'x' } })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        {
          notes: [first.note, second.note, shown, cleared.note, after],
          missing: [missing._tag, 'reason' in missing ? missing.reason : null],
        },
        {
          notes: ['Bônus incluso', 'Sem bônus', 'Sem bônus', null, null],
          missing: ['NotFound', 'entry_not_found'],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'checks an informed balance in the proof, and stops when the person withdraws it',
    () =>
      Effect.gen(function* () {
        const { client, owner, account } = yield* checking
        yield* client.imports.upload({
          payload: upload(account.id, september, 'set.ofx'),
        })
        yield* drain
        const proof = () =>
          client.entries
            .balanceProof({ params: { accountId: account.id } })
            .pipe(
              Effect.map((found) =>
                found.supported
                  ? {
                      intervals: found.intervals.map((interval) => [
                        interval.to,
                        interval.differenceCents,
                      ]),
                      checkpoints: found.checkpoints.map((checkpoint) => [
                        checkpoint.asOf,
                        checkpoint.sourceKind,
                      ]),
                    }
                  : null,
              ),
            )
        // R$ 30 spent in cash that nobody typed in yet: a gap of -30.
        const { id } = yield* client.manual.recordCheckpoint({
          params: { accountId: account.id },
          payload: { asOf: '2026-10-10', balanceCents: 97_000 },
        })
        const withGap = yield* proof()
        const balance = (yield* client.accounts.get({
          params: { accountId: account.id },
        })).lastCheckpoint
        yield* client.manual.createTransaction({
          payload: {
            accountId: account.id,
            bookedOn: '2026-10-08',
            amountCents: -3000,
            description: 'Táxi',
          },
        })
        const closed = yield* proof()
        yield* client.manual.withdrawCheckpoint({
          params: { checkpointId: id },
        })
        const withdrawn = yield* proof()
        const again = yield* client.manual.recordCheckpoint({
          params: { accountId: account.id },
          payload: { asOf: '2026-10-10', balanceCents: 97_000 },
        })
        const restored = yield* proof()
        const fileCheckpoint = (yield* client.entries.balanceProof({
          params: { accountId: account.id },
        })) as {
          checkpoints: ReadonlyArray<{ id: string; sourceKind: string }>
        }
        const notManual = yield* client.manual
          .withdrawCheckpoint({
            params: {
              checkpointId: fileCheckpoint.checkpoints.find(
                (checkpoint) => checkpoint.sourceKind === 'file',
              )!.id,
            },
          })
          .pipe(Effect.flip)
        const card = yield* client.accounts.open({
          payload: {
            ownerId: owner.id,
            institutionName: 'Nubank',
            name: 'Cartão',
            kind: 'credit_card',
            purpose: 'operating',
            currency: 'BRL',
            card: {
              closingDay: 3,
              dueDay: 10,
              limitCents: null,
              lastFour: null,
            },
          },
        })
        const onCard = yield* client.manual
          .recordCheckpoint({
            params: { accountId: card.id },
            payload: { asOf: '2026-10-10', balanceCents: 0 },
          })
          .pipe(Effect.flip)
        assert.deepStrictEqual(
          {
            withGap,
            balance: [balance?.balanceCents, balance?.sourceKind],
            closed: closed?.intervals,
            withdrawn,
            sameObservation: again.id === id,
            restored: restored?.intervals,
            errors: [notManual, onCard].map((error) =>
              'reason' in error ? error.reason : error._tag,
            ),
          },
          {
            withGap: {
              intervals: [['2026-10-10', -3000]],
              checkpoints: [
                ['2026-09-30', 'file'],
                ['2026-10-10', 'manual'],
              ],
            },
            balance: [97_000, 'manual'],
            closed: [['2026-10-10', 0]],
            withdrawn: { intervals: [], checkpoints: [['2026-09-30', 'file']] },
            sameObservation: true,
            restored: [['2026-10-10', 0]],
            errors: ['not_a_manual_checkpoint', 'checkpoint_on_card'],
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )
})
