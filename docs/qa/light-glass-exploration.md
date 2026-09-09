# Exploração visual clara

Branch: `design/light-glass-exploration`.
Checkout: `/Users/donaldsilveira/Git/financas-familia`.
Data: 9 de setembro de 2026.

## Visual escolhido

Cristal foi escolhido e aplicado como tema fixo. O seletor, o estado React de alternância e os estilos Porcelana/Sálvia foram removidos. Os tokens Cristal estão no `:root`, disponíveis desde a primeira renderização.

A prévia continua em `http://192.168.1.233:3100` na rede local. A resposta HTML confirmou `crystal-shell`, o saldo e a ausência do seletor. A nova inspeção visual ficou bloqueada: Helium e Zen retornaram `cgWindowNotFound` na ferramenta de navegador. A cobertura visual abaixo pertence à exploração anterior.

## Comparação anterior

Na exploração anterior, o seletor “Explorar visual” permitia comparar as opções.

- Cristal: fundo azulado contínuo, painéis claros translúcidos e saldo em destaque.
- Porcelana: fundo quente, painéis opacos, curvas menores e saldo em tipografia serifada.
- Sálvia: fundo verde suave, curvas maiores e uma área própria para o saldo.

Durante a exploração, a escolha acompanhava a navegação e voltava a Cristal ao recarregar. As variantes compartilhavam as telas, os valores e as ações existentes. O tratamento visual está concentrado no bloco final de `src/styles.css`, no shell e em classes da visão geral.

Referência consultada: https://mobbin.com/screens/4685d9fc-3a0a-402c-bd67-620809b6376a.

## Ambiente e verificações

Run sintético: `.qa/run-bDHEKn`, criado com `pnpm qa:start 3100 121`.
URL: `http://127.0.0.1:3100`.
O servidor permanece disponível para comparar as opções. Nenhuma importação ou escrita financeira foi realizada nesta verificação.

- `pnpm setup:check`: passou.
- `pnpm verify`: passou, incluindo tipagem, lint, 482 testes e build.
- Suíte: 77 arquivos passaram; 2 arquivos e 10 testes foram ignorados pela configuração/condições existentes. Não representam cobertura de fixtures privadas.
- `git diff --check`: passou.
- Desktop no Helium: troca entre Cristal, Porcelana e Sálvia confirmada por estado acessível e capturas; saldo sintético preservado em -R$ 121,00. Navegação para Transações preservou Sálvia; tabela exibiu 121 lançamentos e valores de -R$ 1,00.
- Categorias e Configurações no Zen: telas e valores sintéticos renderizados. Categorias apresentou R$ 121,00 em Mercado.
- Importar: seleção de arquivos e ação inicialmente desabilitada renderizadas.
- `/planejamento`: redirecionou para `/configuracoes?tab=orcamento`, com base de R$ 60.000,00 e estratégia 40/20/30/10.
- `/qa-missing`: mensagem de página inexistente e controle “Ir para visão geral” renderizados.
- Responsivo no Zen, 428 × 926: visão geral e importação inspecionadas visualmente em Cristal, sem corte horizontal observado. Configurações apresentou seletor compacto de área.

## Limites da verificação

Os cliques via automação nativa no modo responsivo do Zen não produziram mudanças confiáveis, inclusive em controles preexistentes. A abertura do menu móvel, a troca das variantes nessa largura e o retorno pelo controle da página inexistente permanecem sem confirmação. A troca das três variantes foi confirmada no desktop. O console consultado não mostrou exceções JavaScript; houve 404 de favicon e o 404 esperado da rota inexistente.

As capturas foram inspecionadas na ferramenta, sem exportação de arquivos. Não foram executados importação, mutações financeiras, benchmark ou verificações de fixtures privadas, pois esta mudança é de apresentação.

O CSS inclui versões opacas para preferência de transparência reduzida e maior contraste, além de fallback para ausência de `backdrop-filter`. Esses modos não foram exercitados no navegador.

## Ajustes de contraste e navegação

Removidos o rótulo “Organização” e o `SidebarRail` do shell. A linha da aba ativa agora fica dentro do botão, evitando o corte pelo overflow da lista, com fundo ativo e borda da lista mais definidos. Recorrências usam fundo branco nos lançamentos, cabeçalhos de grupo opacos e nomes maiores.

Run sintético desta rodada: `.qa/run-zsaooe`, URL `http://127.0.0.1:3100`, 121 lançamentos. `pnpm setup:check`, `pnpm verify`, Prettier e `git diff --check` passaram. A resposta HTML de Configurações/Recorrências confirmou a tela, estado ativo das abas e ausência do rótulo e do rail. Isso não substitui inspeção visual desktop/celular, que permanece pendente nesta rodada.
