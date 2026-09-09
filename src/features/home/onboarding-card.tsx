import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Circle, CircleCheck } from 'lucide-react'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '#/components/ui/card'
import { Progress } from '#/components/ui/progress'
import { Skeleton } from '#/components/ui/skeleton'
import { onboardingOptions } from '#/features/finance/queries'
import { cn } from '#/lib/utils'

export function OnboardingCard() {
  const status = useQuery(onboardingOptions())
  const steps = [
    {
      key: 'accounts',
      label: 'Contas e cartões',
      to: '/configuracoes',
      search: { tab: 'contas' },
    },
    { key: 'transactions', label: 'Adicionar lançamentos', to: '/transacoes' },
    {
      key: 'categories',
      label: 'Classificar lançamentos',
      to: '/transacoes',
      search: { category: 'uncategorized' },
    },
    {
      key: 'recurrences',
      label: 'Cadastrar recorrências',
      to: '/configuracoes',
      search: { tab: 'recorrencias' },
    },
  ] as const
  const completed = status.data
    ? steps.filter((step) => status.data[step.key]).length
    : 0
  return (
    <Card size="sm" className="mx-2 group-data-[collapsible=icon]:hidden">
      <CardHeader>
        <CardTitle>Onboarding</CardTitle>
        <CardDescription>
          {status.isPending
            ? 'Carregando etapas…'
            : status.isError
              ? 'Progresso indisponível'
              : completed === steps.length
                ? 'Tudo pronto para acompanhar.'
                : `${completed} de ${steps.length} etapas concluídas`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status.isPending ? (
          <Skeleton className="h-32" />
        ) : status.isError ? (
          <Button variant="outline" onClick={() => void status.refetch()}>
            Tentar novamente
          </Button>
        ) : (
          <div className="flex flex-col gap-2">
            <Progress
              value={(completed / steps.length) * 100}
              aria-label={`${completed} de ${steps.length} etapas do onboarding concluídas`}
            />
            <ol className="flex flex-col">
              {steps.map((step) => {
                const done = status.data[step.key]
                const Icon = done ? CircleCheck : Circle
                return (
                  <li key={step.key}>
                    <Link
                      to={step.to}
                      search={'search' in step ? step.search : undefined}
                      aria-label={`${step.label}: ${done ? 'concluída' : 'pendente'}`}
                      className="flex min-h-11 items-center gap-2 rounded-md px-1 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          'size-4 shrink-0',
                          done ? 'text-success' : 'text-muted-foreground',
                        )}
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1',
                          done && 'text-muted-foreground',
                        )}
                      >
                        {step.label}
                      </span>
                      {!done && (
                        <ArrowUpRight
                          aria-hidden="true"
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      )}
                    </Link>
                  </li>
                )
              })}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
