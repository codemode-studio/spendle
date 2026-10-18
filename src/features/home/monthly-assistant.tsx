import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { AnalysisCard } from './analysis-card'
import { monthlyAnalysisFn } from '#/features/data/planning.functions'

export function MonthlyAssistant({
  month,
  revision,
  configured,
  closed = false,
}: {
  month: string
  revision: string
  configured: boolean
  closed?: boolean
}) {
  const analysis = useQuery({
    queryKey: ['monthly-assistant', month, closed, revision],
    queryFn: () => monthlyAnalysisFn({ data: { month } }),
    enabled: configured && closed,
    staleTime: Infinity,
    retry: 1,
    retryDelay: 1500,
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
            Assistente desligado neste servidor: configure OPENROUTER_API_KEY e
            OPENROUTER_MODEL para receber uma análise deste mês.
          </p>
        ) : !closed ? (
          <p className="text-sm">
            A análise será gerada ao fechar este mês em Orçamento e metas. Use o
            chat para perguntas pontuais.
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
        ) : !analysis.data ? (
          <p className="text-sm">
            A análise será gerada ao fechar este mês em Orçamento e metas. Use o
            chat para perguntas pontuais.
          </p>
        ) : (
          <>
            <AnalysisCard analysis={analysis.data} />
          </>
        )}
      </div>
    </section>
  )
}
