import { ArrowUpRight, Check, Sparkles } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { toast } from 'sonner'

import { CategorySelect } from '#/components/category-select'
import { Panel } from '#/components/ui'
import { Button } from '#/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { formatCurrency } from '#/lib/currency'
import { formatShortDate } from '#/lib/period'
import {
  confirmCategoryFn,
  correctCategoryFn,
} from '#/features/data/entries.functions'
import {
  categoriesOptions,
  categoryReviewOptions,
  patchEntryCategory,
} from '#/features/data/queries'
import { errorMessage } from '#/lib/api/errors'
import { invalidateFinance } from '#/features/finance/queries'
import { cn } from '#/lib/utils'

const visible = 6

/**
 * Movements whose category the person should confirm or correct. Each
 * answer is a decision the knowledge base learns from.
 */
export function CategoryReviewQueue() {
  const { data: items } = useSuspenseQuery(categoryReviewOptions())
  const { data: categories } = useSuspenseQuery(categoriesOptions())
  const queryClient = useQueryClient()
  const confirm = useServerFn(confirmCategoryFn)
  const correct = useServerFn(correctCategoryFn)
  const assignable = categories.filter((item) => !item.system)
  const nameOf = new Map(categories.map((item) => [item.id, item.name]))
  const mutation = useMutation({
    mutationFn: (input: {
      entryId: string
      categoryId: string
      confirm: boolean
    }) =>
      input.confirm
        ? confirm({ data: { entryId: input.entryId } })
        : correct({
            data: { entryId: input.entryId, categoryId: input.categoryId },
          }),
    onMutate: async (input) => ({
      rollback: await patchEntryCategory(queryClient, input),
    }),
    onSuccess: () => void invalidateFinance(queryClient, 'ledger'),
    onError: (error, _input, context) => {
      context?.rollback()
      toast.error(errorMessage(error, 'Não foi possível salvar a categoria.'))
    },
  })

  if (!items.length) return null
  return (
    <Panel
      title={`${items.length} ${items.length === 1 ? 'lançamento aguarda' : 'lançamentos aguardam'} sua revisão`}
      action={
        items.length > visible ? (
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link to="/transacoes" search={{ category: 'review' }} />}
          >
            Ver todos
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        ) : undefined
      }
      className="mb-4"
    >
      <ul className="divide-y rounded-lg border">
        {items.slice(0, visible).map((item) => {
          const entryId = item.inference.entryId
          const suggested = item.inference.categoryId
          const fromModel = item.inference.origin === 'model'
          const pending =
            mutation.isPending && mutation.variables.entryId === entryId
          return (
            <li
              key={entryId}
              className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {item.description}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatShortDate(item.bookedOn)} ·{' '}
                  <span
                    className={cn(item.amountCents > 0 && 'text-emerald-700')}
                  >
                    {formatCurrency(item.amountCents)}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-1">
                <CategorySelect
                  variant="ghost"
                  categories={assignable}
                  value={suggested ?? 'uncategorized'}
                  allowTransfer={false}
                  disabled={pending}
                  aria-label={`Categoria de ${item.description}`}
                  onValueChange={(categoryId) =>
                    mutation.mutate({ entryId, categoryId, confirm: false })
                  }
                />
                {suggested ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          disabled={pending}
                          aria-label={`Confirmar ${nameOf.get(suggested) ?? 'sugestão'} para ${item.description}`}
                          onClick={() =>
                            mutation.mutate({
                              entryId,
                              categoryId: suggested,
                              confirm: true,
                            })
                          }
                        />
                      }
                    >
                      {fromModel ? <Sparkles /> : <Check />}
                    </TooltipTrigger>
                    <TooltipContent>
                      Confirmar {nameOf.get(suggested)}
                      {fromModel ? ' (sugestão do assistente)' : ''}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
