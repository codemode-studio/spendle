import { describe, expect, it } from 'vitest'

import { runPostCommitStep } from './post-commit'

describe('finalização posterior ao commit', () => {
  it('não transforma falha derivada em falha do commit durável', async () => {
    await expect(
      runPostCommitStep(async () => {
        throw new Error('indisponível')
      }),
    ).resolves.toEqual({ status: 'deferred', message: 'indisponível' })
  })

  it('distingue etapa concluída e etapa não aplicável', async () => {
    await expect(runPostCommitStep(async () => undefined)).resolves.toEqual({
      status: 'completed',
    })
    await expect(runPostCommitStep(null)).resolves.toEqual({
      status: 'skipped',
    })
  })
})
