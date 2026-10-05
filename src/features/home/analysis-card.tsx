import { ArrowDownRight, ChevronDown, TriangleAlert } from 'lucide-react'
import type { MonthlyAnalysis } from '@spendle/server/api'
import { formatCurrency } from '#/lib/currency'

export function AnalysisCard({ analysis }: { analysis: MonthlyAnalysis }) {
  const savingsCents = analysis.actions.reduce(
    (total, action) =>
      total +
      (action.baselineCents !== null && action.proposedLimitCents !== null
        ? Math.max(0, action.baselineCents - action.proposedLimitCents)
        : 0),
    0,
  )
  const hasActions = analysis.actions.length > 0
  return (
    <div className="space-y-3">
      <p className="font-medium leading-snug">{analysis.headline}</p>
      {savingsCents > 0 && (
        <div className="flex items-center gap-2">
          <ArrowDownRight
            aria-hidden="true"
            className="size-5 shrink-0 text-emerald-700"
          />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-xs text-muted-foreground">
              Economia mensal proposta
            </p>
            <p className="text-2xl font-semibold tracking-tight text-emerald-700 tabular-nums">
              {formatCurrency(savingsCents)}
            </p>
          </div>
        </div>
      )}
      {hasActions ? (
        <section aria-label="Plano de economia">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            Próximo mês
          </h4>
          <ol className="divide-y">
            {analysis.actions.map((action, index) => {
              const quantified =
                action.baselineCents !== null &&
                action.proposedLimitCents !== null
              const baseline = action.baselineCents ?? 0
              const limit = action.proposedLimitCents ?? 0
              const saving = Math.max(0, baseline - limit)
              const ratio =
                baseline > 0 ? Math.min(100, (limit / baseline) * 100) : 0
              return (
                <li key={`${index}-${action.title}`} className="py-2">
                  <details className="group">
                    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-medium leading-snug focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                      <span
                        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums"
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                      <span className="min-w-0">{action.title}</span>
                      <span className="sr-only">: como fazer</span>
                      <ChevronDown
                        aria-hidden="true"
                        className="ml-auto size-3.5 shrink-0 text-muted-foreground group-open:rotate-180"
                      />
                    </summary>
                    <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
                      {action.detail}
                    </p>
                  </details>
                  {quantified && (
                    <>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <dt className="text-xs text-muted-foreground">
                            Limite proposto
                          </dt>
                          <dd className="text-base font-semibold tracking-tight tabular-nums">
                            {formatCurrency(limit)}
                          </dd>
                        </div>
                        <div className="flex flex-wrap items-baseline justify-end gap-x-2 text-right">
                          <dt className="text-xs text-muted-foreground">
                            Economia
                          </dt>
                          <dd className="text-base font-semibold text-emerald-700 tabular-nums">
                            {formatCurrency(saving)}
                          </dd>
                        </div>
                      </dl>
                      <div
                        className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-emerald-100"
                        role="img"
                        aria-label={`Gasto de referência ${formatCurrency(baseline)}, limite proposto ${formatCurrency(limit)}, economia ${formatCurrency(saving)}`}
                      >
                        <span
                          className="bg-primary"
                          style={{ width: `${ratio}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        Gasto de referência: {formatCurrency(baseline)}
                      </p>
                    </>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{analysis.summary}</p>
      )}
      <details className="group border-t">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          {analysis.findings.length > 0 && (
            <TriangleAlert
              aria-hidden="true"
              className="size-4 shrink-0 text-amber-600"
            />
          )}
          {analysis.findings.length > 0
            ? `${analysis.findings.length} pontos de atenção`
            : 'Entender a análise'}
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 group-open:rotate-180"
          />
        </summary>
        <div className="space-y-4 pt-2 text-sm">
          {hasActions && (
            <p className="text-muted-foreground">{analysis.summary}</p>
          )}
          {analysis.findings.map((finding, index) => (
            <div key={`${index}-${finding.title}`}>
              <p className="font-medium">{finding.title}</p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                {finding.detail}
              </p>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
