import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  answerFinanceQuestion,
  getLatestMonthlyAnalysis,
  generateMonthlyAnalysis,
  getAssistantStatus,
} from './analysis.server'

export const getAssistantStatusFn = createServerFn({ method: 'GET' }).handler(
  () => getAssistantStatus(),
)

export const getLatestMonthlyAnalysisFn = createServerFn({
  method: 'POST',
})
  .validator(z.object({ refreshInitial: z.boolean().default(false) }))
  .handler(({ data }) => getLatestMonthlyAnalysis(data.refreshInitial))

export const askFinanceQuestionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      question: z.string().trim().min(3).max(500),
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(10000),
          }),
        )
        .max(20)
        .default([]),
    }),
  )
  .handler(({ data }) => answerFinanceQuestion(data.question, data.history))

export const generateMonthlyAnalysisFn = createServerFn({ method: 'POST' })
  .validator(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }))
  .handler(({ data }) => generateMonthlyAnalysis(data.month))
