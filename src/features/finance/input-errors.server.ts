import { setResponseStatus } from '@tanstack/react-start/server'

import { InvalidIsoDateError } from '#/domain/period'

import { InvalidManualBalanceCheckpointError } from './checkpoint-chain.server'
import { InvalidStageImportFormDataError } from './import.server'
import { InvalidRecurrenceDestinationError } from './recurrence.server'

type BadRequestDomainError =
  | InvalidIsoDateError
  | InvalidManualBalanceCheckpointError
  | InvalidRecurrenceDestinationError
  | InvalidStageImportFormDataError

function isBadRequestDomainError(
  error: unknown,
): error is BadRequestDomainError {
  return (
    error instanceof InvalidIsoDateError ||
    error instanceof InvalidManualBalanceCheckpointError ||
    error instanceof InvalidRecurrenceDestinationError ||
    error instanceof InvalidStageImportFormDataError
  )
}

/**
 * Runs a server implementation and maps typed input errors to HTTP 400.
 * Server-only: must be called from inside a server function handler.
 */
export async function serverInput<T>(implementation: () => Promise<T>) {
  try {
    return await implementation()
  } catch (error) {
    if (isBadRequestDomainError(error)) setResponseStatus(400)
    throw error
  }
}
