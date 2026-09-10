# Histórico da simplificação inicial

06/09/2026. Branch `redesign/simple-family-finance`, base `5d8e07e`. Interface posteriormente revista; veja o [histórico mensal](monthly-family-overview.md).

QA sintética `.qa/run-zzrnBO`, porta 3102, em 1440 × 1000 e 390 × 844. O ambiente começou com uma conta e sem lançamentos.

## Resultados no navegador

- Navegação abriu visão geral, transações, categorias, contas, recorrências, orçamento, metas, importação e configurações.
- Importação de `balanced.ofx`: dois lançamentos, +R$ 1.000,00 e -R$ 100,00, diferença zero antes da consolidação e caixa de R$ 900,00 depois. Mercado mostrou R$ 100,00.
- Guia reconheceu os lançamentos importados. Atalho sem categoria exibiu somente Receita QA, um dos dois lançamentos.
- Detalhes abriram composição, consumo e evolução do caixa. Reação útil no assistente persistiu ao fechar e reabrir o painel.
- Menu móvel abriu, fechou e fechou automaticamente ao navegar para Contas. Página inexistente permitiu voltar à visão geral.
- Após revisão do resumo, despesa Lazer de R$ 40.000,00 criada pela interface produziu caixa de -R$ 39.100,00, excesso de R$ 28.000,00 em Estilo de vida e falta de R$ 4.100,00 após metas. Home e orçamento concordaram.

## Verificação e limites

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram. Última rodada: 453 testes aprovados e 10 ignorados. Benchmark inicial: página de transações com 4.000 registros, 10 consultas e 58.720 bytes.

Não foram exercitados PDFs privados, IA real, importação duplicada, saldo divergente ou estado sem contas. IA desativada no ambiente sintético.
