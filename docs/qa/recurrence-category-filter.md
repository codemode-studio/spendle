# Filtro de categoria ao vincular recorrência

08/09/2026. Filtro local na lista de candidatos, combinado com descrição antes do limite de resultados. Receitas oferecem categorias de receita; despesas seguem as categorias de essenciais e estilo de vida usadas no cadastro da recorrência. Todas as categorias e Sem categoria disponíveis. Trocar categoria limpa a seleção de lançamentos.

Testes de componente verificam ambos os tipos, busca combinada, candidato além do limite inicial e limpeza da seleção. Nenhuma regra de conciliação do servidor foi alterada.

Browser QA: http://127.0.0.1:3117/configuracoes?tab=recorrencias, `.qa/run-I0rsRO`. Recorrências, ocorrências e dois lançamentos sintéticos preparados via SQL. Pela UI, aberto vínculo da receita, selecionada Distribuição de lucros, selecionado Teste lucro e acionado Vincular e conciliar. Observado R$ 1.000,00 de R$ 1.000,00 e 1 lançamento. Aberto vínculo da despesa, conferida ausência de categorias de receita e filtrado Mercado, exibindo Teste mercado de R$ 100,00. Desktop 1280×800 e celular 390×844; sem overflow e botões de rodapé dentro da janela. Preparação SQL não foi contada como mutation UI; vinculação foi feita no navegador.

`pnpm setup:check`, testes focados e `pnpm verify` passaram. Nenhum dado principal modificado.
