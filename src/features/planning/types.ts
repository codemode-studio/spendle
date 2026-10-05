import type {
  AccountView,
  Category,
  MonthView,
  PlanningState,
  RecurrenceBook,
  RecurrenceView,
} from '@spendle/server/api'

/** What Orçamento e metas and Recorrências read, all from V2. */
export interface PlanningData {
  state: PlanningState
  /** The current month. */
  month: MonthView
  book: RecurrenceBook
  accounts: ReadonlyArray<AccountView>
  categories: ReadonlyArray<Category>
}

export type { RecurrenceView }
export type OccurrenceView = RecurrenceView['occurrences'][number]
export type MatchView = OccurrenceView['matches'][number]

/** `<recurrenceId>|<expectedDate>` as the API builds occurrence ids. */
export function occurrenceRef(occurrenceId: string) {
  const [recurrenceId = '', expectedDate = ''] = occurrenceId.split('|')
  return { recurrenceId, expectedDate }
}

/** The payload that names one match: its occurrence and entry. */
export function matchRef(match: Pick<MatchView, 'occurrenceId' | 'entryId'>) {
  return { ...occurrenceRef(match.occurrenceId), entryId: match.entryId }
}
