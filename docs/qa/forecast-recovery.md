# Previsão e recuperação de caixa

09/09/2026. Base `c5ad7b1` com alterações locais. QA sintética na porta 3102, run `.qa/run-hFGaJ3`; desktop 1280 × 800 e 1440 × 1000, celular 390 × 844.

## Resultados no navegador

- Sem movimentos, a tela pediu importação de extratos.
- Despesa de R$ 6.000,00 e receita de R$ 18.000,00 criadas pela interface resultaram em saldo de R$ 12.000,00. `qa:inspect` confirmou dois lançamentos e nenhuma violação de chave estrangeira.
- Horizontes de 30, 60 e 90 dias mostraram R$ 9.000,00, R$ 6.000,00 e R$ 3.000,00.
- Em 60 dias, redução de 100% do histórico de R$ 3.000,00/mês e extras de R$ 5.000,00/mês resultaram em R$ 22.000,00. A tela indicou falta de R$ 19.000,00/mês para a meta.
- Redução de 50% e extras de R$ 27.000,00/mês resultaram em R$ 63.000,00 e meta coberta.
- Entrada negativa foi rejeitada. Limpar ou reabrir a página descartou a simulação.
- Compras abriu `/transacoes?category=shopping&direction=out`, mostrando a despesa de R$ 6.000,00.
- Orçamento preservou base de R$ 60.000,00 e estratégia 40/20/30/10. Premissas abriram; celular sem rolagem horizontal.

O controle de redução funcionou por ponteiro. Teclado não confirmado no navegador.

## Ajustes de apresentação

No run `.qa/run-5AAe9k`, com 121 despesas sintéticas, a tela deixou de mostrar o nome da estratégia e a exploração de gastos. Premissas ficaram recolhidas e o resultado da simulação passou a aparecer após um ajuste.

Em 1440 × 1000 e 390 × 844, caixa de -R$ 121,00 e previsão de -R$ 242,20 em 60 dias foram preservados. Extras de R$ 1.000,00/mês produziram R$ 1.757,80; limpar restaurou a previsão. Sem rolagem horizontal.

No run `.qa/run-bUb0T7`, o seletor de período passou a usar `SegmentedControl`. Selecionar 90 dias marcou a opção e mostrou -R$ 302,80. Desktop 1440 × 900 e celular 390 × 844 conferidos.

## Verificação e limites

`pnpm setup:check` e `pnpm verify` passaram nas três rodadas; 487 testes aprovados e 10 privados/IA pulados. Testes cobrem déficit antes da recuperação, acúmulo da meta, centavos, histórico, limite de redução e entradas inválidas. Importação não foi repetida no navegador. Ambientes encerrados e removidos.

Benchmark da primeira rodada: 4.000 linhas reconciliadas em 11,02 ms; snapshot com 28 consultas, configuração com 13 e página de transações com 10. Medição local, sem comparação de ganho. Não repetido nos ajustes visuais.

A simulação distribui a melhora a partir de amanhã e mantém a meta mensal no horizonte. Não agenda recebimentos, desconta novos aportes ou grava decisões. Datas reais e mudanças de estratégia podem alterar o saldo mínimo.
