# Filtro de categoria ao vincular recorrência

08/09/2026. QA sintética `.qa/run-I0rsRO`, porta 3117, em Configurações → Recorrências.

O filtro combina categoria e descrição antes do limite de candidatos. Receitas oferecem categorias de receita; despesas, as categorias usadas no cadastro. Trocar categoria limpa a seleção.

Fixture preparado por SQL com recorrências, ocorrências e dois lançamentos. Pelo navegador:

- Receita: selecionada Distribuição de lucros e vinculado Teste lucro. Resultado: R$ 1.000,00 de R$ 1.000,00, um lançamento.
- Despesa: categorias de receita ausentes; Mercado exibiu Teste mercado de R$ 100,00. Vínculo de despesa não registrado nesta rodada.
- Desktop 1280 × 800 e celular 390 × 844: sem rolagem horizontal, botões de rodapé dentro da janela.

Testes cobriram ambos os tipos, busca combinada, candidato além do limite e limpeza da seleção. `pnpm setup:check`, testes focados e `pnpm verify` passaram. A preparação SQL não contou como mutação pela interface.
