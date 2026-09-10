# Estrutura estável ao trocar de mês

08/09/2026. QA sintética `.qa/run-Rso1V8`, porta 3117.

O resumo manteve Caixa inicial, Entradas recebidas, Saídas pagas e Caixa nessa ordem. Setembro acrescentou Previsão do mês abaixo; agosto mostrou somente o realizado.

Fixture preparado por SQL com recebimentos de R$ 700,00 em agosto e R$ 1.000,00 em setembro. Botões anterior/próximo confirmaram os valores e a estrutura. Saldo inicial de agosto sem referência mostrou Sem saldo registrado. Desktop 1280 × 800 e celular 390 × 844 conferidos, sem rolagem horizontal. Não houve mutação pelo navegador.

Teste de componente verificou setembro → agosto → setembro. `pnpm setup:check`, teste focado e `pnpm verify` passaram: 480 testes aprovados e 10 pulados.
