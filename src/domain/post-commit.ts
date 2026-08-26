export type PostCommitStep =
  { status: 'completed' | 'skipped' } | { status: 'deferred'; message: string }

export async function runPostCommitStep(
  action: (() => Promise<unknown>) | null,
): Promise<PostCommitStep> {
  if (!action) return { status: 'skipped' }
  try {
    await action()
    return { status: 'completed' }
  } catch (error) {
    return {
      status: 'deferred',
      message:
        error instanceof Error
          ? error.message
          : 'Falha desconhecida na finalização da importação.',
    }
  }
}
