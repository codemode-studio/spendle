import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { generateMonthlyAnalysisFn } from './analysis.functions'

export function MonthlyAssistant({
  month,
  revision,
  configured,
}: {
  month: string
  revision: string
  configured: boolean
}) {
  const analysis = useQuery({
    queryKey: ['monthly-assistant', month, revision],
    queryFn: () => generateMonthlyAnalysisFn({ data: { month } }),
    enabled: configured,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
  return (
    <section
      aria-label="Análise do assistente"
      className="flex items-start gap-3 py-2"
    >
      <Sparkles
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 text-primary"
      />
      <div className="min-w-0 flex-1" aria-live="polite">
        {!configured ? (
          <p className="text-sm">
            Ative o assistente em Configurações para receber uma análise deste
            mês.
          </p>
        ) : analysis.isPending ? (
          <p className="text-sm">
            Analisando o caixa, os gastos e as metas deste mês…
          </p>
        ) : analysis.isError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              Não foi possível gerar a análise deste mês.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void analysis.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        ) : (
          <>
            <h4 className="text-sm font-semibold">{analysis.data.headline}</h4>
            <p className="mt-1 text-sm leading-relaxed">
              {analysis.data.summary}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
