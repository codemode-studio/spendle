import { assign } from '../domain/Assignment.ts'
import { dayNumber, daysBetween } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'
import { descriptionWords } from '../ledger/Resolution.ts'

export type RelationKind = 'internal_transfer' | 'card_payment'

/** An entry as the matcher sees it. */
export interface MatchableEntry {
  readonly id: string
  readonly accountId: string
  readonly accountKind:
    'checking' | 'savings' | 'cash' | 'investment' | 'credit_card'
  readonly bookedOn: string
  readonly amountCents: number
  readonly currency: string
  readonly status: 'pending' | 'posted'
  /** The entry's own description, from the report that speaks for it. */
  readonly description: string
  /**
   * What every source currently reports for the entry, `description` first.
   * Evidence for a pair may come from any of them; any one naming a third
   * party or contradicting the pair keeps it suggested, whichever source
   * came first.
   */
  readonly descriptions: ReadonlyArray<string>
  /** The account's institution, which a transfer description may name. */
  readonly institution?: string
  /** Who owns the account: a name both sides share is evidence only when it is theirs. */
  readonly ownerName?: string
}

export type Decision = 'confirmed' | 'rejected'

export interface MatchedRelation {
  /** `kind:outId+inId`; stable because entry ids are. Keys decisions too. */
  readonly key: string
  readonly kind: RelationKind
  readonly outflowId: string
  readonly inflowId: string
  /**
   * `conflict`: the person confirmed it, but the facts changed since (amounts
   * or currencies no longer match) and it needs their review.
   */
  readonly status: 'suggested' | 'confirmed' | 'conflict'
  readonly origin: 'auto' | 'person'
  /** 0 to 100. */
  readonly score: number
  readonly reasons: ReadonlyArray<string>
}

/**
 * A person's confirmation that cannot hold its entries: one no longer exists
 * (`entry_missing`), or another confirmation already holds one
 * (`overlapping_confirmation`, after entries merged). The entries it can
 * still hold stay reserved.
 */
export interface OrphanedDecision {
  readonly key: string
  readonly missing: ReadonlyArray<string>
  readonly reason: 'entry_missing' | 'overlapping_confirmation'
  /** The entries it still reserves. */
  readonly reserved: ReadonlyArray<string>
}

export interface Matching {
  readonly relations: ReadonlyArray<MatchedRelation>
  readonly orphaned: ReadonlyArray<OrphanedDecision>
}

export const relationKey = (
  kind: RelationKind,
  outflowId: string,
  inflowId: string,
) => `${kind}:${outflowId}+${inflowId}`

export const parseRelationKey = (key: string) => {
  const [kind = '', pair = ''] = key.split(':')
  const [outflowId = '', inflowId = ''] = pair.split('+')
  return { kind, outflowId, inflowId }
}

/** Auto-confirm needs this score and no rival within the margin. */
export const autoConfirmScore = 80
export const rivalMargin = 10

const hints: Record<RelationKind, RegExp> = {
  internal_transfer:
    /\b(pix|transf|transferencia|ted|doc|tev|aplicacao|aplic|resgate|investimento|envio|enviad[oa]|recebid[oa]|deposito|mesma titularidade)\b/,
  card_payment: /\b(fatura|pagamento|pgto|pag|cartao|card)\b/,
}

// Wording that says the movement is something else: income on the receiving
// side, a purchase on the paying side, a refund or cashback on a card.
const contradictions: Record<
  RelationKind,
  { readonly outflow: RegExp; readonly inflow: RegExp }
> = {
  internal_transfer: {
    outflow: /\b(compra|boleto|tarifa|iof|juros)\b/,
    inflow:
      /\b(salario|folha|rendimento|rendimentos|juros|cashback|estorno|reembolso|dividendo|premio|restituicao)\b/,
  },
  card_payment: {
    outflow: /\b(compra|tarifa)\b/,
    inflow: /\b(estorno|cashback|reembolso|credito de|ajuste)\b/,
  },
}

// Wording that only says a movement is a transfer, or when, not who is on the
// other side.
const transferWords = new Set([
  'transferido',
  'transferida',
  'envio',
  'recebimento',
  'mesma',
  'titularidade',
  'titular',
  'mesmo',
  'entre',
  'contas',
  'propria',
  'proprio',
  'proprias',
  'saida',
  'entrada',
  'agendado',
  'agendada',
  'banco',
  'bank',
  'instituicao',
  'pagamentos',
  'aplicacao',
  'aplic',
  'resgate',
  'investimento',
  'poupanca',
  'cpf',
  'cnpj',
  'de',
  'da',
  'do',
  'dos',
  'das',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'ao',
  'aos',
  'os',
  'as',
  'ag',
  'cc',
  'cp',
  'nr',
  'sa',
  'pelo',
  'pela',
  'via',
  'app',
  'remetente',
  'destinatario',
  'favorecido',
])

// Words common to many names, so sharing one says nothing about who it is.
const genericNameWords = new Set([
  'internet',
  'net',
  'telecom',
  'servico',
  'servicos',
  'comercio',
  'loja',
  'store',
  'shop',
  'digital',
  'brasil',
  'grupo',
  'empresa',
  'eireli',
  'tecnologia',
  'solucoes',
])

// Wording that says both sides belong to the same person.
const ownAccountWording =
  /\b(mesma titularidade|mesmo titular|entre contas|conta propria|contas proprias)\b/

const months = 'jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez'

// Words whose shape marks them as a reference rather than a name: only
// digits (agencies, accounts, endings), a day glued to a month (`10set`,
// `10set26`), a card mask (`xxxx`, `xxxx1234`), or a long id with at most a
// short letter prefix (e2e ids). A name with digits (`tec2000`) is a name.
const code = new RegExp(
  `^(?:\\d+|\\d{1,2}(?:${months})\\d{0,4}|x{3,}\\d*|\\*+\\d+|[a-z]{0,3}\\d{8,}[a-z0-9]*)$`,
)
// Only these shapes are codes; any other word with letters, short
// alphanumeric names like `88i` or `99pay` included, may name someone.
const isCode = (word: string) => code.test(word)

// A bank name glued to its `bank` suffix names the same bank as its words
// apart: `C6BANK` is `C6 Bank`, `Nubank` is `Nu Pagamentos`.
const unglue = (word: string) =>
  word.length > 5 && word.endsWith('bank') ? word.slice(0, -4) : word

// Banks whose names are made of common words, folded into one token so
// their words never pass for another institution's (`Banco do Brasil` is
// `bb`, never Santander's `Brasil`).
const bankNames: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbanco do brasil\b/g, 'bb'],
  [/\bcaixa economica( federal)?\b/g, 'caixa'],
  [/\bbanco do nordeste\b/g, 'bnb'],
  [/\bbanco da amazonia\b/g, 'basa'],
  [/\bnu pagamentos\b/g, 'nubank'],
]

/** A folded text with multi-word bank names as single tokens. */
const bankAliases = (text: string) =>
  bankNames.reduce(
    (folded, [name, token]) => folded.replace(name, token),
    foldDescription(text),
  )

/**
 * Words of a text that can name a party, short names and alphanumeric ones
 * (`nu`, `c6`, `99pay`) included: not bank or transfer wording, not numbers
 * or codes. A name it does not recognize still names someone.
 */
const nameWords = (text: string) =>
  new Set(
    [...descriptionWords(bankAliases(text))]
      .filter(
        (word) =>
          !transferWords.has(word) && /[a-z]/.test(word) && !isCode(word),
      )
      .map(unglue),
  )

// Letters joined by punctuation are one name (`C&A`, `D&A`, `D'Avila`),
// kept apart from ordinary words with `_` so `D&A` never reads as the
// stopword `da`. A corporation suffix (`S.A.`, `S/A`, `S-A`) reads as `sa`,
// understood only right after a bank's name.
const joinInitials = (text: string) =>
  text
    .replace(/\b[a-z0-9](?:[&.\/'-][a-z0-9])+\b\.?/g, (run) => {
      const letters = run.replace(/[^a-z0-9]/g, '')
      return letters === 'sa' ? 'sa' : `_${letters}_`
    })
    // A lone letter with a period is an initial (`A. Silva`), never an article.
    .replace(/(^|[^a-z0-9_])([a-z])\./g, '$1_$2_')

/** Every description of an entry, its own first. */
const descriptionsOf = (entry: MatchableEntry) => [
  ...new Set([entry.description, ...entry.descriptions]),
]

/** Whether any description of an entry, folded, matches. */
const describes = (entry: MatchableEntry, pattern: RegExp) =>
  descriptionsOf(entry).some((text) => pattern.test(foldDescription(text)))

/** The words of every description of an entry. */
const wordsOf = (
  entry: MatchableEntry,
  words: (text: string) => ReadonlySet<string>,
) => new Set(descriptionsOf(entry).flatMap((text) => [...words(text)]))

// Words of an institution's registered name that say where or what it is,
// not which one: `Banco Santander (Brasil) S.A.` is `santander`, so a
// description naming `Banco do Brasil` never passes for it.
const institutionNoise = new Set([
  'brasil',
  'brazil',
  'br',
  'sa',
  'financeira',
  'holding',
  'investimentos',
  'multiplo',
  'sociedade',
  'cooperativa',
])

const institutionWords = (entry: MatchableEntry) =>
  new Set(
    [...nameWords(entry.institution ?? '')].filter(
      (word) => !institutionNoise.has(word),
    ),
  )

/** A description's words: folded, bank names aliased, initials joined. */
const tokens = (text: string) =>
  joinInitials(bankAliases(text))
    .split(/[^a-z0-9_]+/)
    .filter((word) => word !== '')

// A one-letter word, dotted or not, may be someone's initial.
const isLetter = (word: string) => word.replace(/_/g, '').length < 2

// Words a description may open with to say how the money moved. They are
// read only at the start: past the first other word, any of them may be
// part of a name (`Pix enviado Ted`).
const movementPhrase = new Set([
  'pix',
  'transferencia',
  'transf',
  'pagamento',
  'pgto',
  'pagto',
  'fatura',
  'cartao',
  'credito',
  'debito',
  'deposito',
  'envio',
  'recebimento',
  'enviado',
  'enviada',
  'recebido',
  'recebida',
  'transferido',
  'transferida',
  'efetuado',
  'efetuada',
  'agendado',
  'agendada',
  'chave',
  'aleatoria',
  'evp',
  'qr',
  'qrcode',
  'code',
  'celular',
  'telefone',
  'email',
  'conta',
  'de',
  'da',
  'do',
  'dos',
  'das',
  'para',
  'em',
  'no',
  'na',
  'ao',
])

// Card-bill wording, understood anywhere in a card payment's descriptions.
const cardBill = new Set(['fatura', 'cartao', 'cartoes', 'credito'])

// Rails that are also first names: a rail only as a description's first word.
const railNames = new Set(['ted', 'doc', 'tev'])

// Wording that says both sides belong to the same person, longest first.
const ownAccountPhrases = [
  'entre contas proprias',
  'mesma titularidade',
  'mesmo titular',
  'entre contas',
  'conta propria',
  'contas proprias',
].map((phrase) => phrase.split(' '))

// Words of an institution's registered name that say what kind of company or
// where it is, never which one.
const legalWords = new Set([
  ...institutionNoise,
  'banco',
  'bco',
  'bank',
  'instituicao',
  'pagamento',
  'pagamentos',
  'ltda',
  'de',
  'do',
  'da',
  'dos',
  'das',
])

// Bank names that are nobody's name, so they name the bank on their own.
// Words that are also names (`Inter`, `Safra`) need `Banco` before them.
const bankWords = new Set([
  'bb',
  'c6',
  'caixa',
  'bnb',
  'basa',
  'itau',
  'bradesco',
  'santander',
  'btg',
  'sicoob',
  'sicredi',
  'banrisul',
])

/** An institution's name words, without legal or geographic words. */
const institutionCore = (institution: string) =>
  tokens(institution)
    .map(unglue)
    .filter((word) => !legalWords.has(word) && !isLetter(word))

/** An account owner's name words and their first name, read as written. */
interface Owner {
  readonly words: ReadonlySet<string>
  readonly first: string | null
}

const ownerOf = (name: string): Owner => {
  const words = tokens(name).filter((word) => !isLetter(word))
  const [first] = tokens(name)
  return {
    words: new Set(words),
    first: first === undefined || isLetter(first) ? null : first,
  }
}

/** What a description may say and still be understood. */
interface Vocabulary {
  /** Whose name it may carry: a word must belong to every one of them. */
  readonly owners: ReadonlyArray<Owner>
  /** Which banks it may name (see `institutionCore`). */
  readonly institutions: ReadonlyArray<ReadonlyArray<string>>
  /** Whether card-bill wording (`fatura`, `final 1234`) is understood anywhere. */
  readonly card: boolean
}

/**
 * How many words at `at` name one of the institutions as a bank: after
 * `banco`/`bco`, glued to `bank` (`Nubank`, `C6BANK`), followed by `bank`
 * (`C6 Bank`), or a bank name that is nobody's name (`Itau`). A bare word
 * that is also a name (`Joao Safra`) is 0.
 */
const bankReference = (
  words: ReadonlyArray<string>,
  at: number,
  institutions: ReadonlyArray<ReadonlyArray<string>>,
) => {
  const prefix = (from: number, core: ReadonlyArray<string>) => {
    let length = 0
    while (length < core.length && words[from + length] === core[length])
      length++
    return length
  }
  const word = words[at]!
  const lengths = institutions.map((core) => {
    if (core.length === 0) return 0
    if (word === 'banco' || word === 'bco') {
      const glued = words[at + 1]
      if (
        glued !== undefined &&
        unglue(glued) !== glued &&
        unglue(glued) === core[0]
      )
        return 2
      const length = prefix(at + 1, core)
      return length > 0 ? 1 + length : 0
    }
    if (unglue(word) !== word && unglue(word) === core[0]) return 1
    const length = prefix(at, core)
    if (length === 0) return 0
    if (words[at + length] === 'bank') return length + 1
    // A bare bank name (`santander`) carries no bank context: marked
    // negative so a description that also names a person rejects it.
    return bankWords.has(word) ? -length : 0
  })
  // A reference with bank context wins over a bare one.
  const contextual = Math.max(0, ...lengths)
  return contextual > 0 ? contextual : Math.min(0, ...lengths)
}

/**
 * Reads a description against an allowlist: past an opening movement
 * phrase (`Pix enviado para`), every word must be the owner's name, a bank
 * reference to one of the accounts' institutions (with its `S.A.`),
 * own-account wording, a code, or, for a card payment, card-bill wording.
 * Any other word (an unknown name, an initial, a company suffix, a bank word
 * beside a person's name) leaves it not understood, and naming the owner
 * also needs their first name: a surname alone is relatives' and strangers'
 * too. `bank` says whether it names one of the banks.
 */
const read = (description: string, vocabulary: Vocabulary) => {
  const words = tokens(description)
  const ownAccount = (at: number) =>
    ownAccountPhrases.find((phrase) =>
      phrase.every((part, index) => words[at + index] === part),
    )
  let at = 0
  if (railNames.has(words[0] ?? '')) at++
  while (
    at < words.length &&
    movementPhrase.has(words[at]!) &&
    ownAccount(at) === undefined
  )
    at++
  const named = new Set<string>()
  let bank = false
  let bare = false
  while (at < words.length) {
    const word = words[at]!
    const reference = bankReference(words, at, vocabulary.institutions)
    if (reference !== 0) {
      bank = true
      bare ||= reference < 0
      at += Math.abs(reference)
      if (words[at] === 'sa') at++
      continue
    }
    const own = ownAccount(at)
    if (own !== undefined) {
      at += own.length
      continue
    }
    if (isCode(word) || (vocabulary.card && cardBill.has(word))) {
      at++
      continue
    }
    if (vocabulary.card && word === 'final' && isCode(words[at + 1] ?? '')) {
      at += 2
      continue
    }
    if (
      !isLetter(word) &&
      vocabulary.owners.length > 0 &&
      vocabulary.owners.every((owner) => owner.words.has(word))
    ) {
      named.add(word)
      at++
      continue
    }
    return { understood: false, bank }
  }
  const proven = vocabulary.owners.every(
    (owner) => owner.first !== null && named.has(owner.first),
  )
  // Beside a person's name a bare bank word may be their surname
  // (`Carlos Santander`): without `banco` it is not a bank reference.
  if (bare && named.size > 0) return { understood: false, bank }
  return { understood: named.size === 0 || proven, bank }
}

/** What either entry of a pair may say: its owners, its two banks. */
const vocabularyOf = (
  kind: RelationKind,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
): Vocabulary => ({
  owners: [outflow, inflow].map((entry) => ownerOf(entry.ownerName ?? '')),
  institutions: [outflow, inflow].map((entry) =>
    institutionCore(entry.institution ?? ''),
  ),
  card: kind === 'card_payment',
})

/** Whether every description of the entry is understood (see `read`). */
const understood = (entry: MatchableEntry, vocabulary: Vocabulary) =>
  descriptionsOf(entry).every((text) => read(text, vocabulary).understood)

/** Who a text names, without generic name words or institution wording. */
const counterparties = (text: string, institutions: ReadonlySet<string>) =>
  new Set(
    [...nameWords(text)].filter(
      (word) => !genericNameWords.has(word) && !institutions.has(word),
    ),
  )

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].some((word) => b.has(word))

const within = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].every((word) => b.has(word))

/**
 * Whether two counterparty names are one party: every word of one appears in
 * the other (`Donald` and `Donald Silveira`), `same`; no word in common,
 * `different`; a shared word with others that disagree (`Maria Silva` and
 * `Joao Silva`), `uncertain`.
 */
const compareNames = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0 || b.size === 0) return 'unnamed'
  if (!intersects(a, b)) return 'different'
  return within(a, b) || within(b, a) ? 'same' : 'uncertain'
}

/**
 * How every source's names on one side compare with every source's on the
 * other (see `compareNames`), never pooled: pooling `Joao Silva` and `Joao
 * Carlos da Silva` would make `Carlos Silva` fit. `same` only when every
 * pair of descriptions that both name someone agrees, `different` when every
 * such pair has no word in common, `uncertain` when any pair is unsure or
 * pairs disagree with each other, `unnamed` when no pair names someone on
 * both sides.
 */
const compareSources = (
  outflow: ReadonlyArray<ReadonlySet<string>>,
  inflow: ReadonlyArray<ReadonlySet<string>>,
) => {
  const compared = new Set(
    outflow
      .flatMap((out) => inflow.map((into) => compareNames(out, into)))
      .filter((result) => result !== 'unnamed'),
  )
  if (compared.size === 0) return 'unnamed'
  if (compared.size > 1) return 'uncertain'
  return [...compared][0]!
}

/**
 * What the descriptions say about the other side of a transfer: the
 * accounts' owner named on both sides (see `compareSources`), own-account
 * wording, or the other account's institution named are evidence it is the
 * person's own money moving; two different counterparties contradict it.
 * A description with any word `read` cannot account for may name someone
 * else, which outweighs every other evidence: a bank or own-account wording
 * never makes `Maria Silva` and `Joao Silva` one person, and `Maria Silva`
 * on both sides of the owner's accounts is a payment to and from her, not
 * proof the money stayed.
 */
const counterpartEvidence = (
  outflow: MatchableEntry,
  inflow: MatchableEntry,
) => {
  const vocabulary = vocabularyOf('internal_transfer', outflow, inflow)
  const outInstitution = institutionWords(outflow)
  const inInstitution = institutionWords(inflow)
  const institutions = new Set([...outInstitution, ...inInstitution])
  const compared = compareSources(
    descriptionsOf(outflow).map((text) => counterparties(text, institutions)),
    descriptionsOf(inflow).map((text) => counterparties(text, institutions)),
  )
  const different = compared === 'different'
  const thirdParty = ![outflow, inflow].every((entry) =>
    understood(entry, vocabulary),
  )
  const reasons: Array<string> = thirdParty ? ['unrecognized_words'] : []
  if (compared === 'same')
    reasons.push(thirdParty ? 'same_third_party' : 'same_counterparty')
  if (different) reasons.push('different_counterparties')
  if (compared === 'uncertain') reasons.push('uncertain_counterparties')
  if (compared === 'unnamed' && thirdParty) reasons.push('names_third_party')
  if ([outflow, inflow].some((entry) => describes(entry, ownAccountWording)))
    reasons.push('own_account_wording')
  const namesOther = (
    entry: MatchableEntry,
    other: Set<string>,
    own: Set<string>,
  ) =>
    intersects(
      wordsOf(entry, nameWords),
      new Set([...other].filter((word) => !own.has(word))),
    )
  if (
    namesOther(outflow, inInstitution, outInstitution) ||
    namesOther(inflow, outInstitution, inInstitution)
  )
    reasons.push('names_other_account')
  const evidence = [
    'same_counterparty',
    'own_account_wording',
    'names_other_account',
  ]
  return {
    different,
    // Names that only partly agree (`Joao Silva` and `Carlos Silva`) may be
    // two people even when both fit the owner's name: no wording outweighs it.
    evidenced:
      !thirdParty &&
      compared !== 'uncertain' &&
      reasons.some((reason) => evidence.includes(reason)),
    reasons,
  }
}

// Wording on the paying side that says the money goes to a card bill, not
// just that something was paid.
const cardBillWording = /\b(fatura|cartao|cartoes)\b/

/**
 * What the paying side says about which card it pays: whether it speaks of a
 * card bill at all, and whether it names only this card's institution,
 * nobody, or anyone else (another issuer, even beside this one, or a payee
 * such as a school's boleto). A name it does not recognize is someone else
 * too. A card only receives payments, so its side says nothing about the
 * payer.
 */
const cardTarget = (outflow: MatchableEntry, card: MatchableEntry) => {
  // Read with the issuer as the only bank and no one's name, so naming the
  // paying bank, the owner or an unknown issuer (`Pag Bank`) is `other`.
  const readings = descriptionsOf(outflow).map((text) =>
    read(text, {
      owners: [],
      institutions: [institutionCore(card.institution ?? '')],
      card: true,
    }),
  )
  const bill = describes(outflow, cardBillWording)
  const target = readings.some((reading) => !reading.understood)
    ? 'other'
    : readings.some((reading) => reading.bank)
      ? 'named'
      : 'unnamed'
  return { bill, target } as const
}

// TED/DOC and investment movements can land a few business days later.
const slowRail = /\b(ted|doc|aplicacao|aplic|resgate|investimento)\b/

// The widest window any relation allows.
const maxWindowDays = 7

const windowDays = (
  kind: RelationKind,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
) => {
  if (kind === 'card_payment') return 7
  const slow = [outflow, inflow].some((entry) => describes(entry, slowRail))
  return slow ? 5 : 3
}

const kindFor = (
  outflow: MatchableEntry,
  inflow: MatchableEntry,
): RelationKind | null => {
  if (outflow.accountId === inflow.accountId) return null
  if (outflow.accountKind === 'credit_card') return null
  return inflow.accountKind === 'credit_card'
    ? 'card_payment'
    : 'internal_transfer'
}

/** Whether two entries can still be one relation of this kind; checked on every rebuild. */
const validPair = (
  kind: string,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
) =>
  outflow.amountCents < 0 &&
  inflow.amountCents === -outflow.amountCents &&
  outflow.currency === inflow.currency &&
  kindFor(outflow, inflow) === kind

interface Candidate {
  readonly kind: RelationKind
  readonly outflow: MatchableEntry
  readonly inflow: MatchableEntry
  readonly days: number
  readonly score: number
  readonly hintedBoth: boolean
  readonly contradicted: boolean
  readonly evidenced: boolean
  /** Evidenced only if it is the one card the outflow could pay. */
  readonly needsSoleCard: boolean
  readonly reasons: ReadonlyArray<string>
}

const evaluate = (
  kind: RelationKind,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
  days: number,
) => {
  const reasons = ['same_amount', 'own_accounts']
  let score = 50
  if (days === 0) {
    score += 20
    reasons.push('same_day')
  } else if (days === 1) {
    score += 10
    reasons.push('next_day')
  }
  const hinted = [outflow, inflow].filter((entry) =>
    describes(entry, hints[kind]),
  ).length
  if (hinted > 0) {
    score += hinted * 15
    reasons.push(
      hinted === 2 ? 'described_on_both_sides' : 'described_on_one_side',
    )
  }
  const described =
    describes(outflow, contradictions[kind].outflow) ||
    describes(inflow, contradictions[kind].inflow)
  if (described) {
    score -= 30
    reasons.push('conflicting_description')
  }
  // A bank account also receives money from other people, so a transfer
  // needs counterpart evidence; a card payment needs the paying side to say
  // it pays this card's bill. Naming another payee contradicts either.
  const counterpart =
    kind === 'internal_transfer'
      ? { ...counterpartEvidence(outflow, inflow), soleCard: false }
      : cardEvidence(outflow, inflow)
  if (counterpart.different) score -= 30
  reasons.push(...counterpart.reasons)
  return {
    score: Math.max(0, Math.min(100, score)),
    hintedBoth: hinted === 2,
    contradicted: described || counterpart.different,
    evidenced: counterpart.evidenced,
    needsSoleCard: counterpart.soleCard,
    reasons,
  }
}

/**
 * A card payment is evidenced when the paying side speaks of a card bill and
 * names the card's institution, or names no one and turns out to be the only
 * card it could pay (`soleCard`, checked once every candidate is known).
 */
const cardEvidence = (outflow: MatchableEntry, card: MatchableEntry) => {
  const { bill, target } = cardTarget(outflow, card)
  // A card receipt naming anyone but the owner (`Pagamento recebido de Maria
  // Souza`, `de Silva S.A.`, `de Ted`), in any source's report, may be
  // someone else paying the card: never confirmed alone.
  const vocabulary = vocabularyOf('card_payment', outflow, card)
  const thirdPartyPayer = !understood(card, vocabulary)
  const unrecognized = thirdPartyPayer || !understood(outflow, vocabulary)
  const reasons: Array<string> = unrecognized ? ['unrecognized_words'] : []
  if (target === 'named') reasons.push('names_card_institution')
  if (target === 'other') reasons.push('names_other_payee')
  if (thirdPartyPayer) reasons.push('names_third_party_payer')
  return {
    different: target === 'other',
    evidenced: bill && target !== 'other' && !unrecognized,
    soleCard: bill && target === 'unnamed' && !unrecognized,
    reasons,
  }
}

/**
 * Pairs outflows with inflows of the same amount and currency between the
 * person's own accounts: transfers between bank accounts (3 days, 5 for
 * TED/DOC and investments), and payments from a bank account to a card
 * (7 days). Each entry joins at most one relation.
 *
 * A person's confirmation always holds its entries. If the facts changed so
 * the pair no longer adds up, it becomes a `conflict` for review; if an
 * entry disappeared, or merged into one another confirmation already holds,
 * the decision is reported as orphaned and its other entry stays reserved
 * instead of being paired again automatically. Entries in `reserved` (held
 * by a decision the person has yet to resolve) are never paired
 * automatically either. A rejection is never suggested again.
 *
 * Remaining candidates are assigned per amount as a whole, maximizing how
 * many pairs are found, then their scores. Amount and dates alone only ever
 * make a suggestion: a pair is confirmed automatically when it scores at
 * least `autoConfirmScore`, both descriptions say what it is, nothing
 * contradicts it (including two different counterparties), a transfer's
 * descriptions show it stays with the person (see `counterpartEvidence`), a
 * card payment's bank side says it pays this card (see `cardEvidence`),
 * both entries are posted, no rival comes within
 * `rivalMargin`, and the person never rejected a pairing for either entry.
 */
export const matchRelations = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions: ReadonlyMap<string, Decision>,
  reserved: ReadonlySet<string> = new Set(),
): Matching => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const used = new Set<string>()
  const relations: Array<MatchedRelation> = []
  const orphaned: Array<OrphanedDecision> = []

  for (const [key, decision] of [...decisions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (decision !== 'confirmed') continue
    const { kind, outflowId, inflowId } = parseRelationKey(key)
    if (kind !== 'internal_transfer' && kind !== 'card_payment') continue
    const outflow = byId.get(outflowId)
    const inflow = byId.get(inflowId)
    if (!outflow || !inflow) {
      orphaned.push({
        key,
        missing: [outflowId, inflowId].filter((id) => !byId.has(id)),
        reason: 'entry_missing',
        reserved: [outflowId, inflowId].filter((id) => byId.has(id)),
      })
      for (const id of [outflowId, inflowId]) used.add(id)
      continue
    }
    // Entries merged so two confirmations now claim one entry: neither is
    // dropped silently, the later one waits for the person.
    if (used.has(outflowId) || used.has(inflowId)) {
      const reserved = [outflowId, inflowId].filter((id) => !used.has(id))
      orphaned.push({
        key,
        missing: [],
        reason: 'overlapping_confirmation',
        reserved,
      })
      for (const id of reserved) used.add(id)
      continue
    }
    used.add(outflowId)
    used.add(inflowId)
    const valid = validPair(kind, outflow, inflow)
    relations.push({
      key,
      kind,
      outflowId,
      inflowId,
      status: valid ? 'confirmed' : 'conflict',
      origin: 'person',
      score: valid ? 100 : 0,
      reasons: valid
        ? ['confirmed_by_person']
        : ['confirmed_by_person', 'facts_changed'],
    })
  }

  for (const id of reserved) used.add(id)

  const rejectedEntries = new Set(
    [...decisions]
      .filter(([, decision]) => decision === 'rejected')
      .flatMap(([key]) => {
        const { outflowId, inflowId } = parseRelationKey(key)
        return [outflowId, inflowId]
      }),
  )

  // Inflows by amount, then by day, so each outflow only looks at the days
  // its window could reach, in the order entries came.
  const order = new Map(entries.map((entry, index) => [entry.id, index]))
  const inflowsByAmount = new Map<string, Map<number, Array<MatchableEntry>>>()
  for (const entry of entries) {
    if (entry.amountCents <= 0 || used.has(entry.id)) continue
    const group = `${entry.currency}:${entry.amountCents}`
    const byDay = inflowsByAmount.get(group) ?? new Map()
    const day = dayNumber(entry.bookedOn)
    const list = byDay.get(day) ?? []
    list.push(entry)
    byDay.set(day, list)
    inflowsByAmount.set(group, byDay)
  }
  const reachable = (outflow: MatchableEntry, group: string) => {
    const byDay = inflowsByAmount.get(group)
    if (!byDay) return []
    const day = dayNumber(outflow.bookedOn)
    const found: Array<MatchableEntry> = []
    for (let offset = -maxWindowDays; offset <= maxWindowDays; offset++)
      found.push(...(byDay.get(day + offset) ?? []))
    return found.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  }

  const candidatesByGroup = new Map<string, Array<Candidate>>()
  for (const outflow of entries) {
    if (outflow.amountCents >= 0 || used.has(outflow.id)) continue
    const group = `${outflow.currency}:${-outflow.amountCents}`
    for (const inflow of reachable(outflow, group)) {
      const kind = kindFor(outflow, inflow)
      if (kind === null) continue
      if (
        decisions.get(relationKey(kind, outflow.id, inflow.id)) === 'rejected'
      )
        continue
      const days = daysBetween(inflow.bookedOn, outflow.bookedOn)
      if (days > windowDays(kind, outflow, inflow)) continue
      const list = candidatesByGroup.get(group) ?? []
      list.push({
        kind,
        outflow,
        inflow,
        days,
        ...evaluate(kind, outflow, inflow, days),
      })
      candidatesByGroup.set(group, list)
    }
  }

  // The two best scores each entry could reach, to tell clear pairs from ambiguous ones.
  const best = new Map<string, Array<number>>()
  // How many cards each outflow could be paying.
  const cardsOf = new Map<string, Set<string>>()
  for (const candidates of candidatesByGroup.values()) {
    for (const candidate of candidates) {
      if (candidate.kind === 'card_payment') {
        const cards = cardsOf.get(candidate.outflow.id) ?? new Set()
        cards.add(candidate.inflow.accountId)
        cardsOf.set(candidate.outflow.id, cards)
      }
      for (const id of [candidate.outflow.id, candidate.inflow.id]) {
        const scores = best.get(id) ?? []
        scores.push(candidate.score)
        best.set(id, scores)
      }
    }
  }
  const rivalOf = (id: string, own: number) => {
    const scores = [...(best.get(id) ?? [])].sort((a, b) => b - a)
    const index = scores.indexOf(own)
    if (index !== -1) scores.splice(index, 1)
    return scores[0] ?? -Infinity
  }

  // `assign` solves each connected group of candidates on its own: entries
  // that share no candidate cannot affect each other's pairing.
  const pairKey = (outflowId: string, inflowId: string) =>
    `${outflowId}|${inflowId}`
  for (const candidates of candidatesByGroup.values()) {
    const byPair = new Map(
      candidates.map((candidate) => [
        pairKey(candidate.outflow.id, candidate.inflow.id),
        candidate,
      ]),
    )
    const outflows = [
      ...new Map(
        candidates.map((candidate) => [
          candidate.outflow.id,
          candidate.outflow,
        ]),
      ).values(),
    ]
    const inflows = [
      ...new Map(
        candidates.map((candidate) => [candidate.inflow.id, candidate.inflow]),
      ).values(),
    ]
    const find = (outflow: MatchableEntry, inflow: MatchableEntry) =>
      byPair.get(pairKey(outflow.id, inflow.id))
    const rowOf = new Map(outflows.map((outflow, row) => [outflow.id, row]))
    const columnOf = new Map(
      inflows.map((inflow, column) => [inflow.id, column]),
    )
    const chosen = assign(
      candidates.map((candidate) => ({
        row: rowOf.get(candidate.outflow.id)!,
        column: columnOf.get(candidate.inflow.id)!,
        cost: -candidate.score * 1000 + candidate.days,
      })),
    )
    outflows.forEach((outflow, row) => {
      const column = chosen.get(row)
      if (column === undefined) return
      const candidate = find(outflow, inflows[column]!)!
      const rival = Math.max(
        rivalOf(outflow.id, candidate.score),
        rivalOf(candidate.inflow.id, candidate.score),
      )
      const unambiguous = rival < candidate.score - rivalMargin
      const contested =
        rejectedEntries.has(outflow.id) ||
        rejectedEntries.has(candidate.inflow.id)
      const posted =
        outflow.status === 'posted' && candidate.inflow.status === 'posted'
      const confident =
        candidate.score >= autoConfirmScore &&
        candidate.hintedBoth &&
        !candidate.contradicted &&
        candidate.evidenced &&
        (!candidate.needsSoleCard || cardsOf.get(outflow.id)?.size === 1) &&
        posted &&
        unambiguous &&
        !contested
      relations.push({
        key: relationKey(candidate.kind, outflow.id, candidate.inflow.id),
        kind: candidate.kind,
        outflowId: outflow.id,
        inflowId: candidate.inflow.id,
        status: confident ? 'confirmed' : 'suggested',
        origin: 'auto',
        score: candidate.score,
        reasons: [
          ...candidate.reasons,
          ...(posted ? [] : ['pending']),
          ...(unambiguous ? [] : ['ambiguous']),
          ...(contested ? ['previously_rejected'] : []),
        ],
      })
    })
  }
  return {
    relations: relations.sort((a, b) => a.key.localeCompare(b.key)),
    orphaned,
  }
}
