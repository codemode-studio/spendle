export const assistantQueryKeys = {
  all: ['assistant'] as const,
  status: () => [...assistantQueryKeys.all, 'status'] as const,
  analyses: () => [...assistantQueryKeys.all, 'analysis'] as const,
  latestAnalysis: (closedMonths: string) =>
    [...assistantQueryKeys.analyses(), 'latest', closedMonths] as const,
}
