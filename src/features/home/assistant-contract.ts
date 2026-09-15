import { z } from 'zod'

export const INITIAL_ANALYSIS_REFRESH_MS = 15 * 60_000

export const financeQuestionnaireSchema = z.object({
  items: z
    .array(
      z.object({
        question: z.string().min(1).max(180),
        description: z.string().min(1).max(240).nullable(),
        multiple: z.boolean(),
        required: z.boolean(),
        choices: z
          .array(
            z.object({
              label: z.string().min(1).max(100),
              description: z.string().min(1).max(160).nullable(),
            }),
          )
          .min(2)
          .max(4),
        allowOther: z.boolean(),
      }),
    )
    .min(1)
    .max(3),
})

export const financeAnswerSchema = z.object({
  summary: z.string().min(1).max(600),
  metrics: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        valueCents: z.number().int(),
      }),
    )
    .max(3),
  comparison: z
    .object({
      title: z.string().min(1).max(80),
      items: z
        .array(
          z.object({
            label: z.string().min(1).max(60),
            valueCents: z.number().int().nonnegative(),
          }),
        )
        .min(2)
        .max(5),
    })
    .nullable(),
  nextStep: z.string().min(1).max(240).nullable(),
  questionnaire: financeQuestionnaireSchema.nullable().optional(),
})

export type FinanceAnswer = z.infer<typeof financeAnswerSchema>
export type FinanceQuestionnaire = z.infer<typeof financeQuestionnaireSchema>
