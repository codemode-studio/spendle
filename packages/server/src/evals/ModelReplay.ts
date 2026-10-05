import type { ClassifyItem } from '../categories/Classifier.ts'
import { examplePicker } from '../categories/Examples.ts'
import { knowledgeKey } from '../categories/Patterns.ts'
import type { EvalItem } from './Scoreboard.ts'

/**
 * What the model is asked about the exam, as the server would ask it: the
 * context split stands for the person's past decisions (later items count
 * as more recent) and each exam item gets its examples from them alone,
 * chosen by the same `examplePicker`. Without examples every item is asked
 * bare, for comparison. Transfers in the context (no category) teach
 * nothing, as confirmed transfers never become examples in the app.
 */
export const modelQuestions = (
  context: ReadonlyArray<EvalItem>,
  exam: ReadonlyArray<EvalItem>,
  options: { readonly examples: boolean },
): ReadonlyArray<ClassifyItem> => {
  const pick = examplePicker(
    options.examples
      ? context.flatMap((item, index) =>
          item.expectedCategoryId === null
            ? []
            : [
                {
                  description: item.description,
                  amountCents: item.amountCents,
                  categoryId: item.expectedCategoryId,
                  revision: index + 1,
                },
              ],
        )
      : [],
  )
  return exam.map((item) => {
    const direction = item.amountCents < 0 ? 'expense' : 'income'
    const examples = pick({ description: item.description, direction })
    return {
      pattern: knowledgeKey(item)?.pattern ?? item.id,
      direction,
      description: item.description,
      amountCents: item.amountCents,
      ...(examples.length > 0 ? { examples } : {}),
    }
  })
}
