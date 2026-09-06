# Simplificação da interface

Verificação em 6 de setembro de 2026, na branch `redesign/simple-family-finance`, a partir de `5d8e07e`. Checkout `/Users/donaldsilveira/Git/financas-familia`.

## Referência e escopo

Referência visual consultada pelo MCP do Mobbin: [dashboard do Copilot Money](https://mobbin.com/screens/0abca29e-c16e-45bb-9134-21dbc0c20c37). Aplicados resumos curtos, navegação direta e acesso progressivo aos detalhes.

A visão geral apresenta caixa, compromissos, ações de revisão, quatro categorias e quatro próximos vencimentos. Projeção, premissas, comparação de consumo e composição financeira permanecem acessíveis ao expandir os detalhes. Avisos de estimativas aparecem no resumo e por extenso nos detalhes. O assistente abre em um painel, preservando seu estado ao fechar e reabrir na mesma página.

O guia de configuração usa contas, lançamentos e recorrências do snapshot para orientar os passos. Leva aos fluxos existentes de contas, cartões, importação, revisão e orçamento opcional. Nenhum cálculo financeiro, registro do banco principal ou regra de importação foi alterado.

## QA no navegador integrado

URL: `http://127.0.0.1:3102`. Estado sintético independente em `.qa/run-zzrnBO`, já existente e confirmado vazio antes da importação. Banco principal não usado nas mutações.

- Inspeção visual em 1440 × 1000 e 390 × 844: resumos organizados em duas colunas no desktop e uma no celular. Guia usa toda a largura no celular.
- Navegação: visão geral, transações, categorias, contas, recorrências, orçamento e metas, importação e configurações renderizaram os destinos esperados.
- Guia: contas abriu a aba Contas; importar e revisar abriu o fluxo de importação. Depois da importação, o guia reconheceu que já havia lançamentos.
- Detalhes: abriu composição dos compromissos e alternou para consumo por data. Abriu evolução do caixa e encontrou gráfico, premissas e aviso de cenário estimado.
- Assistente: abriu e fechou; uma reação marcada como útil permaneceu marcada depois de reabrir. IA desabilitada na QA, sem chamadas externas.
- Importação de `balanced.ofx`: dois lançamentos, crédito de R$ 1.000,00, débito de R$ 100,00 e diferença de saldo R$ 0,00 antes da consolidação. Após consolidar, caixa R$ 900,00 e compromissos R$ 100,00 no resumo. Categoria Mercado com R$ 100,00.
- Revisão: o atalho de lançamentos sem categoria abriu o filtro correto e exibiu somente Receita QA, um de dois lançamentos.
- `/qa-missing`: exibiu página não encontrada e o botão de retorno abriu a visão geral.

## Verificações automatizadas e limites

`pnpm setup:check`, `pnpm verify`, formatação dos arquivos alterados e `git diff --check` passaram. Vitest: 449 testes passaram, 10 ignorados, em 66 arquivos aprovados e dois ignorados. `pnpm bench` passou com dados sintéticos; página de transações com 4.000 registros fez 10 consultas e retornou 58.720 bytes.

PDFs privados e chamadas reais de IA não foram executados nesta rodada. Não foi refeito no navegador o cenário de arquivo duplicado ou saldo divergente, pois as regras de importação não mudaram. A inspeção visual usou dados sintéticos, sem capturar dados financeiros pessoais. O estado inicial sem nenhuma conta não foi exercitado no navegador; a QA começou com uma conta sintética.

## Ajuste do cabeçalho mobile

Referência: [Copilot Money no iPhone](https://mobbin.com/screens/0e7388f4-b89e-4806-9a11-5627c7fcf3e1), consultada pelo MCP do Mobbin. Cabeçalho com marca central, menu, importação e navegação por abas. Saudação e ações secundárias menores. Menu com fechamento explícito e fechamento ao seguir um destino.

Corrigidas regras globais de borda e fonte que estavam fora de `@layer base` e anulavam as variantes dos componentes. Corrigido também o seletor de expansão dos resumos: avisos internos abertos não devem expandir um cartão cujo detalhe principal está fechado.

QA no mesmo estado sintético, em 390 × 844 e 1440 × 1000: inspeção visual, abrir/fechar menu, navegar para Contas com fechamento automático, abas Transações/Categorias/Visão geral, recorrências, configurações e importação. Desktop mantém os dois resumos lado a lado. Nenhuma mutação financeira nesta rodada. `pnpm verify`: 449 testes aprovados e 10 ignorados; tipos, lint e build aprovados.

## Estratégia como resumo financeiro

Substituído o resumo de compromissos escondido por uma estratégia sempre visível na página inicial. Margem após metas e caixa aparecem juntos; barras mostram despesas versus limites e aportes pagos versus metas. O mesmo componente abre a página de orçamento. Renda e seleção de estratégia continuam editáveis, em uma seção própria. Composição e consumo por data permanecem acessíveis para conferência.

O estado de apresentação distingue falta de renda para mês/metas, grupos excedidos, estimativas com ressalvas e ausência de renda de referência. Aportes previstos não completam as barras de metas. Os cálculos de compromissos existentes foram preservados.

QA isolada em `.qa/run-zzrnBO`, porta 3102, com layouts de 390 × 844 e 1440 × 1000. Criada pelo navegador uma despesa sintética de R$ 40.000,00 em Lazer: margem após metas de -R$ 4.100,00, Estilo de vida R$ 28.000,00 acima do limite, caixa de -R$ 39.100,00. A página inicial e o orçamento mostraram a mesma falta de R$ 4.100,00; edição de renda/estratégia e comparação de consumo abriram corretamente. Nenhuma escrita no banco principal. `pnpm verify` passou: 453 testes aprovados, 10 ignorados, tipos/lint/build aprovados. Quatro testes novos cobrem os estados da leitura financeira. PDFs privados e IA real não foram executados.
