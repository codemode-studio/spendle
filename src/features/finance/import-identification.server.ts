import { extractText } from '@firecrawl/pdf-inspector'
import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { detectIdentity } from './pdf-inspector.server'

export type ImportTarget = {
  key: string
  type: 'account' | 'card'
  institution: string | null
  currency: string
  identifiers: string[]
}
export type DocumentIdentity = {
  type: 'account' | 'card' | null
  institution: string | null
  identifier: string | null
  currency: string | null
}
const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '')
const digits = (value: string) => value.replace(/\D/g, '')

export function matchImportTargets(
  identity: DocumentIdentity,
  targets: ImportTarget[],
) {
  // A bank name or filename alone cannot identify whose account this is.
  if (!identity.identifier || !identity.type) return []
  const identifier = digits(identity.identifier)
  if (identifier.length < 4) return []
  return targets
    .filter(
      (target) =>
        target.type === identity.type &&
        (!identity.currency || target.currency === identity.currency) &&
        (!identity.institution ||
          (target.institution &&
            normalize(target.institution) ===
              normalize(identity.institution))) &&
        target.identifiers.some((value) =>
          identity.type === 'card' || identifier.length === 4
            ? digits(value).slice(-4) === identifier.slice(-4)
            : digits(value) === identifier,
        ),
    )
    .map((target) => target.key)
}

export function validateImportFiles(data: FormData) {
  const files = data.getAll('files')
  if (!files.length || files.length > 24)
    throw new Error('Selecione de 1 a 24 arquivos.')
  if (
    files.some(
      (file) =>
        !(file instanceof File) ||
        !file.size ||
        file.size > 20 * 1024 * 1024 ||
        !/\.(ofx|csv|pdf)$/i.test(file.name),
    )
  ) {
    throw new Error(
      'Envie arquivos OFX, CSV ou PDF não vazios, de até 20 MB cada.',
    )
  }
  return files as File[]
}

export async function getImportTargets(): Promise<ImportTarget[]> {
  await ensureDatabase()
  const institutions = await db.select().from(schema.institutions)
  const accounts = await db.select().from(schema.accounts)
  const cards = await db.select().from(schema.creditCards)
  const instruments = await db.select().from(schema.creditCardInstruments)
  const institution = (id: string | null) =>
    institutions.find((item) => item.id === id)?.name ?? null
  return [
    ...accounts
      .filter((item) => item.active)
      .map((item) => ({
        key: `account:${item.id}`,
        type: 'account' as const,
        institution: institution(item.institutionId),
        currency: item.currency,
        identifiers: item.externalId ? [item.externalId] : [],
      })),
    ...cards
      .filter((item) => item.active)
      .map((item) => ({
        key: `card:${item.id}`,
        type: 'card' as const,
        institution: institution(item.institutionId),
        currency: item.currency,
        identifiers: [
          item.lastFour ?? '',
          ...instruments
            .filter((instrument) => instrument.creditCardId === item.id)
            .map((instrument) => instrument.lastFour),
        ],
      })),
  ]
}

export async function identifyImportFiles(data: FormData) {
  const files = validateImportFiles(data)
  const targets = await getImportTargets()
  const results = []
  for (const file of files) {
    let identity: DocumentIdentity = {
      type: null,
      institution: null,
      identifier: null,
      currency: null,
    }
    let warning: string | null = null
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      if (/\.ofx$/i.test(file.name)) {
        const text = buffer.toString('utf8')
        const tag = (name: string) =>
          new RegExp(`<${name}>\\s*([^<\\r\\n]+)`, 'i')
            .exec(text)?.[1]
            .trim() ?? null
        identity = {
          type: /<CCSTMTRS>/i.test(text)
            ? 'card'
            : /<STMTRS>/i.test(text)
              ? 'account'
              : null,
          institution: tag('ORG'),
          identifier: tag('ACCTID'),
          currency: tag('CURDEF'),
        }
      } else if (/\.csv$/i.test(file.name)) {
        // Only explicit metadata rows identify a destination; transaction text does not.
        const text = buffer.toString('utf8')
        const account = /^conta[;\t]\s*([\d. -]+)\s*$/im.exec(text)?.[1] ?? null
        identity = {
          type: account ? 'account' : null,
          institution: null,
          identifier: account,
          currency: null,
        }
      } else if (/\.pdf$/i.test(file.name)) {
        const detected = detectIdentity(extractText(buffer))
        identity = {
          type:
            detected.kind === 'bank_statement'
              ? 'account'
              : detected.kind === 'card_statement'
                ? 'card'
                : null,
          institution: detected.institution,
          identifier: detected.lastFour,
          currency: detected.currency,
        }
      }
    } catch {
      warning =
        'Não foi possível identificar este documento. Selecione o destino para tentar a leitura completa.'
    }
    const candidates = matchImportTargets(identity, targets)
    results.push({
      target: candidates.length === 1 ? candidates[0] : '',
      message:
        warning ??
        (candidates.length === 1
          ? 'Destino identificado pelo documento.'
          : candidates.length > 1
            ? 'Mais de um destino corresponde. Identifique o correto.'
            : 'Identifique a conta ou cartão deste arquivo.'),
    })
  }
  return results
}
