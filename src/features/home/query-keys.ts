export const assistantQueryKeys = {
  all: ['assistant'] as const,
  status: () => [...assistantQueryKeys.all, 'status'] as const,
}
