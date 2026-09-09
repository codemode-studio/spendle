# Visão geral e comparação mensal

Verificado em 6 de setembro de 2026, no checkout `/Users/donaldsilveira/Git/financas-familia`, a partir de `7ee8e81`.

## Interface

O resumo do mês apresenta uma mensagem grande com um símbolo distinto para dados incompletos, déficit, grupos excedidos e mês dentro do planejamento. A margem continua identificada como estimativa, separada do caixa registrado. Despesas usam barras de limite; aportes pagos usam anéis de progresso. O componente também aparece no orçamento.

A seção Mês a mês apresenta o mês atual e os 11 anteriores. Cada mês pode ser selecionado pelo gráfico ou pelas setas. O detalhe mostra renda do orçamento, despesas classificadas, aportes e valores por grupo contra as metas daquele mês. Meses sem registros permanecem visíveis. Orçamentos fechados usam os valores e metas do histórico existente. O gráfico compara despesas classificadas por data da compra; não representa saldo bancário nem a projeção de compromissos do resumo atual.

Nenhuma regra de cálculo, escrita financeira ou importação foi alterada. A seção usa `strategyHistoryOptions(11)`, já incluída nas invalidações financeiras.

Referências inspecionadas pelo MCP do Mobbin:

- [Origin, orçamento](https://mobbin.com/screens/413f86df-ddd9-4956-8dfa-515256bd949d): hierarquia e agrupamento dos valores.
- [Fey, portfolio](https://mobbin.com/screens/ba4a167d-2b95-49dd-b8d9-fd8ddbeb90dd): tipografia e uso contido de cor.
- [Mercury, movimento mensal](https://mobbin.com/screens/d83e2ef6-913d-4ffb-a91d-06568a3d769b): organização por mês.
- [Rocket Money, metas](https://mobbin.com/screens/bc3080e7-8f92-4d61-8e35-77a47cf4c661): progresso circular dos objetivos.

## Navegador integrado

URL `http://127.0.0.1:3100`, execução isolada `.qa/run-7ZQ7fc`. Dados sintéticos, IA desabilitada. Usado o preview integrado; a descoberta inicial pelo CUA não encontrou navegador disponível.

- Desktop 1280 × 800 e celular 390 × 844: inspeção visual do resumo e da comparação mensal, sem sobreposição de conteúdo.
- Em 390 px, botões dos meses mediram aproximadamente 44,8 px de largura. Em 320 × 740, a grade passou a quatro colunas, com botões de 53,75 px. A largura do documento foi igual à viewport nas duas medições.
- Estado inicial: 12 meses visíveis, setembro selecionado, próximo mês desabilitado, aviso de dados incompletos. Selecionar agosto mostrou a ausência de registros, sem sugerir um mês saudável.
- Criada pela interface uma despesa Mercado QA mensal, em Conta BRL de teste, categoria Mercado, em 15/08/2026, no valor de R$ 10,00. Os campos de data e valor foram preenchidos por eventos DOM após a automação de digitação não conseguir preencher o campo nativo de data corretamente. A validação rejeitou a primeira tentativa inválida; apenas um lançamento foi salvo.
- Após salvar e voltar à visão geral, agosto mostrou R$ 10,00 em despesas classificadas e essenciais. Setembro permaneceu sem registros. Navegação completa e recarga preservaram o resultado.
- Transações mostrou -R$ 10,00 na conta e categoria corretas. Categorias mostrou R$ 10,00. Planejamento e configurações renderizaram sem carregamento persistente; o resumo de setembro no planejamento permaneceu sem despesas.
- `qa:inspect` confirmou um lançamento de -1000 centavos, data 2026-08-15, categoria groceries, status confirmed, sem violações de chaves estrangeiras. O checkpoint posterior foi invalidado, conforme a regra existente.
- Nenhum erro da aplicação observado. O preview registrou dois erros de inicialização do próprio Electron, relativos a sandbox/preloadScripts, antes das interações.

## Verificações e limites

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram. Resultado final: 458 testes aprovados e 10 ignorados, em 69 arquivos aprovados e dois ignorados. Três testes de componente cobrem seleção mensal, centavos, metas históricas, fechamento do mês atual, meses vazios e recuperação de erro. Os testes de integração existentes verificam leitura limitada e alocações congeladas.

`pnpm bench` passou com dados sintéticos. Histórico de 12 meses: 28 consultas, 3.449 bytes, cerca de 29 ms; histórico de três meses: as mesmas 28 consultas. A leitura mensal adicional não exige um snapshot completo por mês.

Os 10 testes ignorados dependem de extratos/fixtures privados ou IA real. Não foram refeitos fluxos de importação. O fluxo existente de edição de categoria foi usado para verificar a atualização do onboarding. Estados de déficit e sucesso têm cobertura de testes de domínio; o navegador exercitou o estado de dados incompletos. A execução sintética foi encerrada e limpa após a verificação.

## Ajustes de consistência e onboarding

Removidos todos os elementos `details` e `summary` das telas. A visão geral apresenta o resumo diretamente. Análises abre um painel separado; composição e consumo ficam em seções de Planejamento. Premissas, tabelas, parcelamentos, edição de renda e histórico ficam visíveis na respectiva seção. Não há botões de expansão.

Ver categorias e Ver recorrências agora são links com a mesma variante, tamanho e alinhamento de rodapé. Medições no navegador: ambos com 32 px de altura no desktop, 44 px no celular, mesma tipografia de 14 px e mesmo padding. No desktop, os dois rodapés também têm a mesma posição vertical.

O botão Guia de configuração foi removido. O card Onboarding da sidebar mostra quatro etapas, ícones de conclusão e barra de progresso. O novo GET retorna somente presença de contas/cartões ativos, lançamentos confirmados, quantidade sem categoria e presença de recorrências ativas. Não carrega linhas do histórico. A chave `finance/read/onboarding` participa das invalidações existentes de leituras financeiras; o teste de invalidação cobre esta chave.

Verificação adicional na mesma execução sintética:

- Card mostrou 3/4 etapas: conta, lançamento e categoria presentes; nenhuma recorrência cadastrada.
- Alterar Mercado QA mensal para Sem categoria reduziu o progresso a 2/4; restaurar Mercado voltou a 3/4, sem recarga manual.
- Menu mobile em 390 × 844 mostrou o card completo com links de 44 px. Contas e cartões abriu `/configuracoes?tab=contas` e fechou o menu.
- Na rodada anterior, as abas abriram seus conteúdos. Essas abas foram removidas na revisão abaixo. Premissas permanecem disponíveis na análise do caixa.
- Em 320 px, documento sem overflow horizontal; ambas as listas de abas couberam na largura disponível. Nenhum `details` ou `summary` no DOM.
- Rotas `/`, `/transacoes`, `/configuracoes`, `/categorias`, `/planejamento` e `/importar` renderizaram. `/qa-missing` mostrou a página não encontrada e seu retorno abriu a visão geral.
- Dois testes de integração adicionais verificam etapas com banco vazio, categorização, exclusão de lançamentos e itens de configuração inativos.

Durante a remoção do módulo antigo do guia, o HMR tentou recarregar o arquivo já removido e o devtools repetiu o erro nos logs. A navegação completa encerrou o problema; build e checagens posteriores passaram.

## Posição do assistente

O botão Assistente passou para a última posição à direita no cabeçalho da visão geral, ao lado de Análises no desktop. Usa a variante com borda. O painel e seu conteúdo foram preservados.

QA isolada em `http://127.0.0.1:3100`, `.qa/run-bOWeNZ`, no mesmo checkout. Inspeção em 1280 × 800 e 320 × 740; abertura e fechamento do assistente nos dois tamanhos. Em 320 px, botão de 44 px de altura, alinhado ao topo e à borda direita do cabeçalho; documento com 320 px, sem overflow. Nenhuma mutação financeira ou chamada real de IA. Execução encerrada e limpa após a verificação.


## Revisão de densidade e navegação

Removidas as abas Resumo/Análises e Plano/Detalhes/Consumo. A home não tem tablists; Planejamento mantém apenas a navegação principal, com composição e compras em seções visíveis. Análises abre um Sheet próprio pelo cabeçalho. Importar extrato foi retirado da home; importações pendentes continuam com um link específico para revisão. O onboarding fica em SidebarFooter, antes de Importar extrato e Configurações.

Despesas previstas e Metas de aporte substituem os títulos acompanhados de frases explicativas. Aportes apresentam valor pago, meta e progresso sem repetir percentual e saldo faltante. Textos redundantes foram removidos ou encurtados em Contas, Cartões, Categorias, Planejamento, Importação, base de conhecimento, histórico mensal e projeção de caixa. Rótulos de estimativas, cobertura e consequências de confirmação foram preservados.

QA: `http://127.0.0.1:3100`, `.qa/run-CW0X7J`, checkout sobre `7ee8e81`. Home inspecionada em 1280 × 800 e 320 × 740. Zero tablists na home; zero tablists aninhadas e largura do documento de 320 px nas rotas Transações, Configurações, Categorias, Planejamento e Importação. Footer mobile termina em 740 px e mostra onboarding seguido dos dois botões. Painel Análises aberto no desktop; Assistente aberto no celular. Página não encontrada e retorno à home exercitados. Sem mutações financeiras nesta rodada; importação e IA real não exercitadas.

Validação final: `pnpm setup:check` e `pnpm verify` passaram (typecheck, lint, 458 testes e build). Dez testes de fixtures privadas/integrações externas permaneceram ignorados. Sem alterações de cálculos ou escritas financeiras nesta revisão.

## Ajustes finais de estratégia, status e mobile

O nome da estratégia foi retirado dos resumos e históricos; permanece no seletor de estratégia. O título da home agora é Orçamento de [mês]. Removido o bloco Para revisar. Status comuns são texto simples, com destaque de badge reservado a avisos e erros.

Análises substitui o conteúdo principal da home e tem botão Voltar, sem painel lateral ou abas. No desktop, o gráfico usa a largura disponível; gastos e destinos ficam lado a lado. No mobile, Análises, Assistente e Ajustar orçamento usam ícones com nomes acessíveis. Saudação e data foram encurtadas. A navegação móvel usa ícones com Início, Transações e Categorias em uma linha.

A inspeção de redimensionamento revelou que o ResizeObserver do gráfico observava o placeholder removido após a hidratação. O contêiner agora permanece montado. Após recarga completa, o SVG acompanhou o contêiner na sequência 1440 → 320 → 1440: 1006 → 239 → 1006 px.

QA isolada: `.qa/run-40txxe`, `http://127.0.0.1:3100`, mesmo checkout. Inspeção em 390 × 844, 320 × 740 e 1440 × 900. Em 320 px, Análises e Assistente medem 44 × 44 px no mesmo alinhamento vertical; os três links de navegação medem 44 px de altura, sem quebra. Documento mede 320 px, sem overflow. Análises abriu no conteúdo principal com zero diálogos visíveis; Voltar restaurou a home. Rotas principais e página não encontrada com retorno verificadas. Nenhuma escrita financeira realizada.

`pnpm setup:check` e `pnpm verify` passaram; 69 arquivos de teste, 458 testes aprovados, 10 testes ignorados de fixtures privadas/integrações externas. Importação e IA real não exercitadas nesta rodada.

## Compositor do assistente fixo

O painel do Assistente tem altura limitada à viewport dinâmica e overflow externo bloqueado. Cabeçalho e compositor não encolhem; o feed ocupa o espaço restante e rola em todos os breakpoints. Rodapé inclui margem para safe area.

QA `.qa/run-bczCy2`: compositor alinhado ao fundo em 1280 × 800 e 320 × 480. Em 320 × 360, verificado feed com overflow e posição do compositor antes/depois de rolar. IA desativada no ambiente sintético; nenhum envio real. Capturas do preview falharam nesta rodada; medições realizadas pelo DOM no navegador integrado. Teclado nativo não exercitado. `pnpm setup:check` e `pnpm verify` passaram: 458 testes, 10 ignorados.

## Orçamento volta à configuração

Removidos o resumo do orçamento, composição, consumo e histórico da aba Orçamento. Ela apresenta Base do orçamento, Estratégia do mês e Fechamento. Visão geral e Análises permanecem como acompanhamento.

QA `.qa/run-rm8PPB`, `http://127.0.0.1:3100/planejamento?section=budget`: títulos e campos conferidos pelo DOM no navegador integrado em 1280 × 800 e 320 × 740. Renda sintética de R$ 60.000,00 e alocações 40/20/30/10 preservadas; seletor mobile visível, sem overflow horizontal. Captura do preview indisponível. Sem mutações financeiras. `pnpm setup:check` e `pnpm verify` passaram (458 testes, 10 ignorados).

## Mês abaixo da saudação

Removida a faixa Orçamento de [mês] e o botão Ajustar da home. O mês do dashboard aparece abaixo da saudação, substituindo a data do dia. QA `.qa/run-5V4GIN`: DOM confirmou Setembro sob a saudação, ausência da faixa e do botão, sem overflow em 320 × 740 e 1280 × 800. Captura indisponível no preview. `pnpm setup:check` e `pnpm verify` passaram.

## Texto da saudação e limpeza do resumo

Subtítulo alterado para Como estamos em [mês]. Removidos Renda de referência do resumo, a legenda de data da compra e o intervalo de meses do histórico. QA `.qa/run-Qb7p39`: DOM verificou texto e remoções em 320 × 740 e 1280 × 800, sem overflow. Captura do preview indisponível. `pnpm setup:check` e `pnpm verify` passaram.

Removido também o rodapé sobre metas editáveis/congeladas e cobertura parcial. QA `.qa/run-iE1DUK` confirmou no DOM a ausência da frase e a presença do histórico mensal. Sem alterações financeiras.

## Cards de categorias e próximos pagamentos

Gastos por categoria recebeu total em destaque, barra de distribuição com as cores existentes e cinco linhas com marcador colorido, percentual e valor. Próximos 30 dias recebeu total a pagar, datas em calendário compacto e ícones/rótulos de recebimento, pagamento ou fatura. Ambos compartilham espaçamento, ícone no cabeçalho e rodapés alinhados; estados vazios têm ícone e texto curto.

QA `.qa/run-O88GUX`, `http://127.0.0.1:3100`, com 12 gastos sintéticos: total Mercado R$ 12,00, 100%, cor #0d9488. Criada pelo formulário do navegador a recorrência Internet da família QA, R$ 129,90, 15/09/2026; a home mostrou total e linha correspondentes. Estado sem vencimentos também conferido antes da criação. Em 1280 × 800, ambos os cards mediram 456,5 × 286 px e os links de rodapé tiveram mesma posição vertical e altura de 32 px. Em 320 × 740, cards de 273 px sem overflow, títulos de uma linha e links de 44 px. Verificação por DOM do navegador integrado; captura do preview continua indisponível. Sem chamada real de IA ou importação nesta rodada.

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram: 458 testes, 10 ignorados.

## Planejamento em Configurações e métricas em col-4

Orçamento, Metas e Recorrências agora são seções de Configurações. O componente PlanningSettings preserva o controller e os diálogos existentes sem criar abas aninhadas. Sidebar mantém Recorrências e Orçamento e metas como atalhos diretos. A rota antiga /planejamento redireciona cada section para a tab correspondente. No mobile, um seletor único substitui a longa barra de abas de Configurações.

Removidos os três cards de totais de Recorrências e a linha Outros / sem categoria do card principal. Métricas mensais usam 12 colunas, cada bloco ocupa 4 no desktop; texto alinhado à esquerda. No mobile, uma coluna.

QA `.qa/run-LI7HmY`, `http://127.0.0.1:3100`, seed de 12 despesas sintéticas. Verificados os três redirecionamentos antigos, atalhos e indicação ativa da sidebar, uma única tablist no desktop e seletor mobile navegando para Metas. Salvar base pelo formulário alterou a renda sintética para R$ 61.000,00; navegação para Metas/Recorrências e retorno completo a Orçamento preservou o valor. Cards removidos ausentes. Rotas de Transações, Categorias, Contas, Cartões, Importação e página não encontrada com retorno exercitadas.

Em 1280 × 800, os três indicadores têm 285 px de largura, mesma coordenada vertical e alinhamento à esquerda. Em 320 × 740, estão empilhados com a mesma margem esquerda e sem overflow. Sem chamadas reais de IA. As validações de precisão financeira permanecem nas suítes existentes; nenhuma regra de cálculo ou mutation foi alterada.

Validação final: `pnpm setup:check`, `pnpm verify` e `git diff --check` passaram. 458 testes aprovados, 10 ignorados de fixtures privadas/integrações externas.

A pedido do usuário, restaurada a grade de duas colunas: Aportes registrados volta à linha seguinte, alinhado à primeira coluna. QA `.qa/run-DsNESP` com dados sintéticos conferiu as posições no navegador; uma coluna no mobile. `pnpm setup:check`, `pnpm verify` e `git diff --check` passaram.

## Consistência mensal e restauração visual — 8 de setembro de 2026

O redesenho feito durante a investigação foi retirado. Mantidos o layout anterior da home, os dois painéis, as barras de despesas, os anéis das metas e a seleção por meses. Os ajustes se limitam aos valores e textos desses componentes.

Resumo e histórico agora recebem a mesma leitura mensal: faturas no vencimento, contas/compras documentadas separadas das estimativas do mês aberto, todas as despesas incluídas na soma. Renda prevista aparece separada da recebida. Compras de cartão classificadas como investimento continuam sendo despesas da fatura, sem reduzir a meta de dinheiro a guardar. Nenhuma categoria é alterada por essa leitura. Meses passados ou fechados não transformam previsões não pagas em despesas realizadas; as alocações congeladas continuam preservadas. CSV aberto com período confiável desde o início do ciclo substitui a previsão anterior na leitura, sem criar fechamento ou alterar fatos importados. Controles fechados continuam prioritários.

QA no checkout `7ee8e81` com alterações locais, execução `.qa/run-X6WKx5`, URL `http://127.0.0.1:3117`. Pelo navegador, criada despesa Mercado QA consistência de R$ 10,00 em 08/09/2026 na conta sintética, inicialmente Mercado e depois Lazer. O resumo e setembro mostraram Essenciais R$ 0,00 e Estilo de vida R$ 10,00, renda prevista R$ 60.000,00 e recebida R$ 0,00. Agosto permaneceu vazio. Configuração do orçamento abriu normalmente. Navegação e recarga preservaram os valores. `qa:inspect` confirmou um único lançamento de -1000 centavos em leisure, sem violações de chaves estrangeiras. Inspeção visual em 1280 × 800 e 320 × 740; documento de 320 px sem overflow horizontal. Durante a retirada do redesenho, o HMR registrou um 404 do componente removido; após recarga, sem novos erros da aplicação. Erros de sandbox/preload do Electron também apareceram ao abrir novas abas.

Na porta 3000, leitura pelo navegador confirmou o mesmo total de despesas previstas de setembro no resumo e no histórico: R$ 57.037,74, dos quais R$ 35.886,96 em contas/compras e R$ 21.150,78 em estimativas. Comparação somente leitura com a cópia de auditoria confirmou intactas as tabelas de transações, splits, importações, arquivos, conhecimento, orçamentos, recorrências e ciclos de cartão. A simulação da porta 3109 continua usando seu próprio banco e recebeu os mesmos componentes restaurados.

`pnpm setup:check`, `pnpm verify`, formatação dos arquivos alterados e `git diff --check` passaram. A execução padrão encontrou também os testes da aplicação copiada dentro de `data/`; a execução restrita com `pnpm exec vitest run --exclude 'data/**'` confirmou 464 testes aprovados e 10 ignorados em 71 arquivos aprovados e dois ignorados. Os ignorados dependem de fixtures privadas ou serviços externos. Testes novos cobrem igualdade dos painéis, centavos, estornos, aportes, renda não recebida, histórico, CSV aberto no vencimento e imutabilidade dos registros. Importação por navegador não refeita; cobertura separada por integração sintética. `pnpm bench`: histórico de 12 meses com 28 consultas, 13.356 bytes e cerca de 25 ms; histórico de três meses também com 28 consultas.

## Renda base e renda confirmada — 8 de setembro de 2026

A pedido do usuário, renda confirmada soma recebimentos externos confirmados nas contas no mês, incluindo rendimentos e entradas ainda sem categoria. Transferências próprias, câmbio interno, distribuições conciliadas entre contas próprias e resgates não entram. Créditos de cartão também não são receitas de conta. A conversão usa os valores-base registrados; conversões ausentes geram aviso de soma incompleta. A regra de elegibilidade para a renda base e os orçamentos fechados permanecem independentes. Os rótulos passaram a Renda base e Renda confirmada, mantendo o layout.

QA isolada `.qa/run-IFJXRf`, porta 3117. Criada pelo navegador entrada externa de R$ 123,45 sem categoria. Resumo e mês a mês mostraram renda confirmada de R$ 123,45 e base de R$ 60.000,00. Alterada a categoria pela interface para Transferência interna: renda confirmada caiu para zero e o saldo permaneceu em R$ 123,45. Navegação para configuração do orçamento e recarga confirmaram a base preservada; retorno à home e viewport de 320 px verificados. `qa:inspect` confirmou apenas um lançamento de 12345 centavos em transfer, sem violações de chaves estrangeiras. O reinício do Vite ao alterar o tsconfig fechou o primeiro formulário antes de salvar; o fluxo foi refeito e não criou duplicidade.

Leitura pelo navegador na porta 3000 confirmou Renda base R$ 60.000,00, Renda confirmada R$ 3,99 e saldo das contas R$ 48.455,70. Os R$ 62.089,37 classificados como transferências foram excluídos da renda confirmada. Nenhum lançamento principal foi editado. A simulação recebeu os mesmos arquivos de código.

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram: 468 testes aprovados e 10 ignorados por dependerem de fixtures privadas ou serviços externos. Testes novos cobrem recebimentos externos, rendimentos, conversão exata, conversão ausente, exclusões, separação da renda base, histórico e imutabilidade. `pnpm bench` manteve 28 consultas no histórico de três e 12 meses; 12 meses retornaram 13.356 bytes em cerca de 29 ms. TypeScript e o comando padrão de testes agora excluem as cópias locais em `data/`, evitando compilar backups incompletos ou executar duas vezes a suíte. Importação no navegador e IA real não exercitadas nesta rodada.
