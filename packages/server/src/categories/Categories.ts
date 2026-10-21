import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'

export const categoryChanged = 'CategoryChanged'

/** The person's choice to leave a movement without a category. */
export const uncategorized = 'uncategorized'
/** System categories reconciliation assigns to confirmed relations. */
export const transferCategory = 'transfer'
export const cardPaymentCategory = 'card_payment'

/**
 * Whether a person may choose the category for a movement: an active one of
 * their own, or the bill payment, which they mark when reconciliation finds
 * no other side (a card the space does not track, or a provider reporting
 * one payment twice). A transfer always needs both sides.
 */
export const assignableByHand = (category: {
  readonly id: string
  readonly active: boolean
  readonly system: boolean
}) =>
  category.active && (!category.system || category.id === cardPaymentCategory)

export const Bucket = Schema.Literals([
  'essential',
  'lifestyle',
  'investment',
  'reserve',
  'income',
  'business',
  'tax',
  'excluded',
])
export type Bucket = typeof Bucket.Type

export class Category extends Schema.Class<Category>('Category')({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  name: Schema.NonEmptyString,
  bucket: Bucket,
  color: Schema.String,
  icon: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  /** Owned by reconciliation: never edited or learned. */
  system: Schema.Boolean,
  /** See `assignableByHand`. */
  assignable: Schema.Boolean,
}) {}

const CategoryRow = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  name: Schema.NonEmptyString,
  bucket: Bucket,
  color: Schema.String,
  icon: Schema.NullOr(Schema.String),
  active: Schema.BooleanFromBit,
  system: Schema.BooleanFromBit,
})

const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))

export const NewCategory = Schema.Struct({
  name: Schema.NonEmptyString,
  bucket: Bucket,
  color: Schema.optional(Color),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
})
export type NewCategory = typeof NewCategory.Type

export const CategoryChanges = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  bucket: Schema.optional(Bucket),
  color: Schema.optional(Color),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
})
export type CategoryChanges = typeof CategoryChanges.Type

export class CategoriesError extends Schema.TaggedError<CategoriesError>()(
  'CategoriesError',
  {
    reason: Schema.Literals([
      'category_not_found',
      /** Transfer and card payment belong to reconciliation. */
      'system_category',
      /** `uncategorized` must stay available to clear a review. */
      'protected_category',
      'invalid_parent',
      'invalid_input',
    ]),
    categoryId: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return [this.reason, this.categoryId, this.detail]
      .filter((part) => part !== undefined)
      .join(': ')
  }
}

const decodeNew = Schema.decodeUnknownEffect(NewCategory)
const decodeChanges = Schema.decodeUnknownEffect(CategoryChanges)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const crypto = yield* Crypto.Crypto

  const select = sql`
    SELECT id, parent_id AS parentId, name, bucket, color, icon, active, system FROM categories
  `
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CategoryRow,
    execute: () => sql`${select} ORDER BY name, id`,
  })
  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: CategoryRow,
    execute: (id) => sql`${select} WHERE id = ${id}`,
  })

  const toCategory = (row: typeof CategoryRow.Type) =>
    new Category({ ...row, assignable: assignableByHand(row) })

  const invalid = (cause: { readonly message: string }) =>
    new CategoriesError({ reason: 'invalid_input', detail: cause.message })

  /** Every category, archived ones too, by name. */
  const list = findAll(undefined).pipe(
    Effect.map((rows) => rows.map(toCategory)),
    Effect.withSpan('Categories.list'),
  )

  const get = Effect.fn('Categories.get')(function* (categoryId: string) {
    const found = yield* findOne(categoryId)
    if (Option.isNone(found))
      return yield* new CategoriesError({
        reason: 'category_not_found',
        categoryId,
      })
    return toCategory(found.value)
  })

  // A parent must exist, be the person's own, and not make a cycle.
  const checkParent = Effect.fnUntraced(function* (
    categoryId: string,
    parentId: string | null | undefined,
  ) {
    let next = parentId ?? null
    while (next !== null) {
      if (next === categoryId)
        return yield* new CategoriesError({
          reason: 'invalid_parent',
          categoryId,
          detail: 'cycle',
        })
      const parent = yield* findOne(next)
      if (Option.isNone(parent) || parent.value.system)
        return yield* new CategoriesError({
          reason: 'invalid_parent',
          categoryId,
          detail: next,
        })
      next = parent.value.parentId
    }
  })

  const changed = (categoryId: string) =>
    log.append([
      {
        type: categoryChanged,
        streamId: 'categories',
        payload: { categoryId },
      },
    ])

  const create = Effect.fn('Categories.create')(function* (
    unchecked: NewCategory,
  ) {
    const input = yield* decodeNew(unchecked).pipe(Effect.mapError(invalid))
    const name = input.name.trim()
    if (name === '')
      return yield* new CategoriesError({
        reason: 'invalid_input',
        detail: 'blank name',
      })
    const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkParent(id, input.parentId)
        yield* sql`
          INSERT INTO categories (id, parent_id, name, bucket, color, icon, active, system)
          VALUES (${id}, ${input.parentId ?? null}, ${name}, ${input.bucket},
            ${input.color ?? '#64748b'}, ${input.icon ?? null}, 1, 0)
        `
        yield* changed(id)
      }),
    )
    return yield* get(id)
  })

  // System categories are reconciliation's; `uncategorized` may be renamed
  // or recoloured but never archived or moved.
  const editable = Effect.fnUntraced(function* (categoryId: string) {
    const category = yield* get(categoryId)
    if (category.system)
      return yield* new CategoriesError({
        reason: 'system_category',
        categoryId,
      })
    return category
  })

  const update = Effect.fn('Categories.update')(function* (
    categoryId: string,
    unchecked: CategoryChanges,
  ) {
    const changes = yield* decodeChanges(unchecked).pipe(
      Effect.mapError(invalid),
    )
    const name = changes.name?.trim()
    if (name === '')
      return yield* new CategoriesError({
        reason: 'invalid_input',
        categoryId,
        detail: 'blank name',
      })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* editable(categoryId)
        if (
          categoryId === uncategorized &&
          (changes.bucket !== undefined || changes.parentId !== undefined)
        )
          return yield* new CategoriesError({
            reason: 'protected_category',
            categoryId,
          })
        if (changes.parentId !== undefined)
          yield* checkParent(categoryId, changes.parentId)
        yield* sql`
          UPDATE categories SET name = ${name ?? current.name},
            bucket = ${changes.bucket ?? current.bucket},
            color = ${changes.color ?? current.color},
            icon = ${changes.icon === undefined ? current.icon : changes.icon},
            parent_id = ${changes.parentId === undefined ? current.parentId : changes.parentId}
          WHERE id = ${categoryId}
        `
        yield* changed(categoryId)
      }),
    )
    return yield* get(categoryId)
  })

  /**
   * Hides a category from new choices. Decisions keep it; patterns and
   * model answers that point to it stop applying.
   */
  const archive = Effect.fn('Categories.archive')(function* (
    categoryId: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* editable(categoryId)
        if (categoryId === uncategorized)
          return yield* new CategoriesError({
            reason: 'protected_category',
            categoryId,
          })
        yield* sql`UPDATE categories SET active = 0 WHERE id = ${categoryId}`
        yield* changed(categoryId)
      }),
    )
    return yield* get(categoryId)
  })

  return { list, get, create, update, archive }
})

export class Categories extends Context.Service<
  Categories,
  Effect.Success<typeof make>
>()('@spendle/server/categories/Categories') {
  static readonly layer = Layer.effect(Categories, make)
}
