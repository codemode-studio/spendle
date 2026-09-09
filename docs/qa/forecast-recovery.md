# Previsão e recuperação de caixa

Verificado em 9 de setembro de 2026, no checkout principal baseado em `c5ad7b1`, com alterações locais preexistentes de apresentação preservadas.

## Ambiente

- URL isolada: `http://127.0.0.1:3102`.
- Run: `.qa/run-hFGaJ3`, banco e uploads próprios criados por `pnpm qa:start 3102`.
- Navegador integrado colaborativo, desktop 1280 × 800 e 1440 × 1000; celular 390 × 844.
- Sem leitura de fixtures financeiras privadas. IA desativada pelo ambiente QA.

## Fluxos e resultados

- Estado inicial sem movimentos: pede importação de extratos, sem declarar uma trajetória saudável. Passou.
- Registro pelo navegador de despesa de R$ 6.000,00 em Compras e receita de R$ 18.000,00 em Distribuição de lucros. Saldo esperado e observado de R$ 12.000,00. `qa:inspect` confirmou dois lançamentos e nenhuma violação de chave estrangeira.
- Horizonte de 30, 60 e 90 dias: saldos esperados e observados de R$ 9.000,00, R$ 6.000,00 e R$ 3.000,00. Premissas acompanham o horizonte.
- Redução de 100% do histórico de R$ 3.000,00/mês e entradas extras de R$ 5.000,00/mês: saldo esperado e observado de R$ 22.000,00 em 60 dias; ainda faltam R$ 19.000,00/mês para a meta sintética. Passou.
- Redução de 50% e entradas extras de R$ 27.000,00/mês: saldo esperado e observado de R$ 63.000,00 em 60 dias e indicação de meta coberta. Passou.
- Entrada negativa: mensagem de validação, sem contabilizar o valor inválido. Limpar simulação restaura o cenário base. Reabrir a página também descarta os ajustes.
- Link de Compras abre `/transacoes?category=shopping&direction=out`, com apenas a despesa de R$ 6.000,00. Passou.
- Planejamento e configuração carregam após as mutações, com base de R$ 60.000,00 e estratégia 40/20/30/10; meta de aportes de R$ 24.000,00 coerente com a previsão. Passou.
- Premissas e maiores pagamentos históricos abrem sob demanda. Os relatórios de gastos ficam recolhidos.
- Desktop e celular: propósito, valores, ações, estados, linha de simulação e controles legíveis. Largura do documento de 390 px no viewport de 390 px, sem transbordamento horizontal.
- Ajuste do controle de redução por ponteiro conferido. Comandos de teclado do controlador integrado não produziram resultados consistentes, portanto não são declarados como cobertura de navegador.

Um erro transitório de `EmptyState` durante edição foi corrigido com o ícone obrigatório. O estado vazio foi conferido após a correção. O log do navegador preserva esse erro antigo; não houve novo erro de aplicação nos fluxos finais.

## Verificações automatizadas

- `pnpm setup:check`: passou.
- Testes focados de previsão e insights: 37 testes passaram.
- `pnpm verify`: typecheck, lint, 487 testes e build passaram. 78 arquivos passaram, 2 foram pulados.
- Dez testes de fixtures privadas e IA ao vivo foram pulados por ausência de configuração. Importação não foi repetida pelo navegador nesta mudança; sua cobertura de integração está na suíte completa.
- `pnpm bench`: passou. Reconciliação sintética de 4.000 linhas em 11,02 ms. Snapshot completo com 28 leituras; configuração com 13; página de transações com 10. Medidas desta execução, sem comparação causal de desempenho.
- Testes novos cobrem falta de caixa antes da recuperação final, acúmulo da meta, precisão de centavos, preservação de histórico, limite da redução e entradas inválidas.

## Limites do cenário

A simulação distribui a melhora uniformemente a partir de amanhã. Não agenda recebimentos, não desconta novos aportes e não grava decisões. A meta mensal atual é mantida no horizonte escolhido; datas reais e mudanças futuras da estratégia podem produzir outro saldo mínimo. A projeção financeira existente, seus critérios de duplicidade e os fatos importados foram preservados.

## Capturas

- Desktop: `/Users/donaldsilveira/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mtu6ohcd-b42d9dd8.png`.
- Simulação desktop: `/Users/donaldsilveira/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mtu6nf8f-1b16a003.png`.
- Celular: `/Users/donaldsilveira/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mtu6kt1o-87d83bc6.png`.

O servidor isolado foi encerrado e o run foi removido após registrar a evidência. Uma tentativa inicial na porta 3100 foi recusada por ocupação; esse run vazio também foi removido. Os servidores preexistentes foram preservados.

## Revisão de densidade

Em 9 de setembro de 2026, após reler o AGENTS.md, removidos da Previsão o nome da estratégia e a seção de exploração de gastos e destinos, incluindo os componentes sem uso. Rótulos encurtados, textos repetidos eliminados e explicações de cálculo recolhidas em Premissas. O resultado da simulação aparece apenas após um ajuste.

QA em `http://127.0.0.1:3102`, run `.qa/run-5AAe9k`, com 121 despesas sintéticas. Desktop 1440 × 1000 e celular 390 × 844 conferidos. Nome e seção ausentes; nenhuma rolagem horizontal no celular. Caixa de -R$ 121,00 e previsão de -R$ 242,20 em 60 dias preservados. Entrada extra simulada de R$ 1.000,00/mês produziu R$ 1.757,80 ao final. Premissas abrem e fecham; limpar simulação restaura a previsão. Sem alterações nos cálculos ou gravações financeiras.

`pnpm setup:check` e `pnpm verify` passaram, com 487 testes aprovados e 10 testes privados/IA pulados. Importação e benchmark não repetidos nesta revisão de apresentação. Servidor encerrado e dados sintéticos removidos após a conferência.

## Seletor de período

Substituído o grupo com bordas pelo `SegmentedControl` existente no app, com largura ajustada ao conteúdo. Conferido no navegador isolado `http://127.0.0.1:3102`, run `.qa/run-bUb0T7`: cantos arredondados em desktop 1440 × 900 e celular 390 × 844, sem transbordamento. Selecionar 90 dias atualizou o saldo sintético para -R$ 302,80 e marcou a opção correta. `pnpm setup:check` e `pnpm verify` passaram, com 487 testes e os mesmos 10 testes privados pulados. Servidor encerrado e run removido ao concluir.
