# Tema Cristal

09/09/2026. Branch `design/light-glass-exploration`.

Cristal foi escolhido como tema fixo. O seletor e as variantes Porcelana/Sálvia foram removidos; os tokens ficaram no `:root`. HTML confirmou `crystal-shell` e ausência do seletor. A inspeção visual após essa escolha ficou bloqueada por `cgWindowNotFound` em Helium e Zen.

## Cobertura anterior à escolha

QA sintética `.qa/run-bDHEKn`, porta 3100, com 121 despesas.

- Desktop: troca das três variantes e persistência durante navegação confirmadas. Saldo de -R$ 121,00 preservado; Transações mostrou 121 lançamentos de -R$ 1,00.
- Categorias mostrou R$ 121,00 em Mercado. Configurações, seleção de arquivos e página inexistente renderizaram.
- `/planejamento` redirecionou para `/configuracoes?tab=orcamento`, com base de R$ 60.000,00 e estratégia 40/20/30/10.
- Em 428 × 926, visão geral e importação inspecionadas em Cristal, sem corte horizontal observado.

Cliques móveis não foram confiáveis. Abertura do menu, troca de variantes no celular e retorno da página inexistente ficaram sem confirmação. Preferências de transparência reduzida, contraste e fallback de `backdrop-filter` não foram exercitadas.

## Ajustes posteriores

Removidos o rótulo Organização e o `SidebarRail`. Indicador de aba ativa movido para dentro do botão. Recorrências receberam fundos opacos e nomes maiores.

Run `.qa/run-zsaooe`, porta 3100, com 121 lançamentos. HTML confirmou a tela de Recorrências, aba ativa e remoções. Inspeção visual desktop/celular continuou pendente.

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram. A exploração registrou 482 testes aprovados e 10 ignorados. Não houve importação, mutação financeira, benchmark ou uso de fixtures privadas. A cobertura do seletor removido não valida o tema fixo e seus ajustes posteriores.
