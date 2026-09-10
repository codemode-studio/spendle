# Fluxo de caixa mensal

08/09/2026. Base `7ee8e81` com alterações locais. QA sintética `.qa/run-F66NYt`, porta 3117.

A leitura passou a usar saldos das contas de movimentação e descontar da projeção apenas compromissos ainda não pagos. Renda base não conta como entrada prevista; metas de aporte aparecem separadas. Histórico usa saldos datados, movimentos confirmados e câmbio registrado, com indicação de dados insuficientes ou diferenças, sem criar ajustes.

## Resultados no navegador

- Entrada de R$ 1.000,00 e despesa Mercado de R$ 10,00 criadas pela interface: caixa e previsão de R$ 990,00, zero ainda a pagar. A despesa paga não foi descontada novamente.
- Categoria alterada para Lazer: resumo e detalhe mensal mostraram R$ 10,00 em Estilo de vida; caixa preservado.
- Navegação, recarga e seleção de agosto/setembro preservaram os valores. Agosto vazio ficou sem comparação. Orçamento manteve base de R$ 60.000,00.
- `qa:inspect` confirmou duas transações de 100000 e -1000 centavos, sem violações de FK.
- Inspeção visual em 1280 × 800 e layout em 320 × 740, sem rolagem horizontal. Gráfico negativo não exercitado no navegador.

## Verificação e limites

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram: 475 testes aprovados, 10 privados/externos ignorados. Testes cobriram saldo inicial, receitas esperadas, despesas pagas, centavos, reconstrução histórica, falta de referência, imutabilidade e igualdade entre resumo e detalhe.

Benchmark: histórico de 12 meses com 28 consultas, 16.343 bytes e cerca de 41 ms; três meses também com 28 consultas. Sem importação no navegador ou IA real. Ambiente encerrado e removido.

A apresentação foi ajustada depois para manter a [mesma estrutura ao trocar de mês](monthly-layout-consistency.md).
