# Histórico da visão mensal

6 a 8 de setembro de 2026. Base `7ee8e81`, com alterações locais. Este relato reúne verificações anteriores ao [fluxo de caixa mensal](monthly-cash-flow.md). Os textos e layouts intermediários foram substituídos.

## Resultados preservados

| Cenário                                                                     | Resultado observado                                                                                                        | Run sintético |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Criar despesa de R$ 10,00 em agosto                                         | Agosto mostrou R$ 10,00; setembro permaneceu vazio. Recarga preservou o lançamento de -1000 centavos, sem violações de FK. | `7ZQ7fc`      |
| Trocar Mercado por Sem categoria e restaurar                                | Onboarding passou de 3/4 para 2/4 e voltou a 3/4 sem recarga manual.                                                       | `7ZQ7fc`      |
| Redimensionar o gráfico de 1440 para 320 e voltar                           | SVG acompanhou o contêiner: 1006 → 239 → 1006 px após correção do ResizeObserver.                                          | `40txxe`      |
| Criar recorrência Internet de R$ 129,90 pela interface                      | Home mostrou o vencimento e total; estado vazio conferido antes da criação.                                                | `O88GUX`      |
| Mover Orçamento, Metas e Recorrências para Configurações                    | Três redirecionamentos antigos e seletor móvel funcionaram. Base salva em R$ 61.000,00 persistiu após navegação.           | `LI7HmY`      |
| Alterar despesa de R$ 10,00 de Mercado para Lazer                           | Resumo e setembro mostraram R$ 10,00 em Estilo de vida; agosto vazio.                                                      | `X6WKx5`      |
| Criar entrada sem categoria de R$ 123,45 e mudar para Transferência interna | Renda confirmada caiu de R$ 123,45 para zero; saldo permaneceu em R$ 123,45 e base em R$ 60.000,00.                        | `IFJXRf`      |

Runs sob `.qa/run-*`, nas portas 3100 ou 3117. Mutações da tabela feitas pelo navegador. As inspeções incluíram desktop e celular, com largura mínima de 320 px.

## Cobertura parcial

- Compositor do assistente: medições DOM em 1280 × 800, 320 × 480 e 320 × 360 confirmaram posição e rolagem do feed. Capturas e teclado nativo não foram exercitados no run `bczCy2`.
- Ajustes intermediários de saudação, orçamento e cards tiveram verificações pelo DOM quando a captura do preview estava indisponível. Isso não equivale a inspeção visual.
- Déficit e sucesso tinham testes de domínio; o navegador da rodada inicial exercitou dados incompletos.
- Importação e IA real não foram repetidas. Dez testes privados/externos ficaram ignorados.

## Verificação automatizada

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram nas rodadas registradas. A última teve 468 testes aprovados e 10 ignorados. A rodada de consistência mensal também executou Vitest com `--exclude 'data/**'` para evitar testes de cópias locais.

Testes cobriram seleção mensal, centavos, metas históricas congeladas, meses vazios, igualdade dos painéis, recebimentos externos, exclusões de transferências, conversões ausentes e imutabilidade. Benchmark final: histórico de três e 12 meses com 28 consultas; 12 meses retornaram 13.356 bytes em cerca de 29 ms.
