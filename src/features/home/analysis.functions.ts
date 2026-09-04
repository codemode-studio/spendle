import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  answerFinanceQuestion,
  generateFortnightAnalysis,
  getAssistantStatus,
} from './analysis.server'

export const getAssistantStatusFn = createServerFn({ method: 'GET' }).handler(
  () => getAssistantStatus(),
)

export const generateFortnightAnalysisFn = createServerFn({
  method: 'POST',
}).handler(() => generateFortnightAnalysis())

export const askFinanceQuestionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ question: z.string().trim().min(3).max(500) }))
  .handler(({ data }) => answerFinanceQuestion(data.question))
