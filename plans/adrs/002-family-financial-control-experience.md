# ADR 002: controle financeiro familiar

Direção de produto registrada em 27/08/2026. Parcialmente implementada; não é uma especificação da interface atual.

## Decisões confirmadas

- A visão principal mostra situação do mês, desvios e ações. Razão, patrimônio detalhado e configurações ficam acessíveis em suas áreas.
- Família é o recorte padrão. A direção prevê recortes por participante sem perder a atribuição de contas, cartões e compromissos.
- Quatro envelopes definem a estratégia. Limites por categoria são opcionais.
- Sinais de gasto precisam indicar período, base de comparação e evidência. Não tornam a categoria moralmente boa ou ruim.
- Compras em quatro ou mais parcelas são despesas fixas temporárias. Cada parcela entra no realizado do mês; as futuras comprometem a projeção.
- Mês-calendário é a referência principal. Comparações do mês aberto usam dias equivalentes; compromissos têm projeção separada.

## IA

A proposta inicial era investigação sob demanda com cálculos determinísticos e consultas somente de leitura. Perguntas sobre a primeira tarefa de IA ficaram superadas pela implementação de perguntas livres, análise quinzenal e comentário mensal.

A implementação está em `src/features/home/analysis.server.ts`. Configuração de provedor e consentimento são exigidos antes do envio. O comentário mensal usa agregados; outros briefings têm conteúdo próprio. Não se deve assumir a mesma granularidade para todos os recursos.

## Questões restantes

- Como atribuir gastos de instrumentos compartilhados a participante ou família?
- Quais recortes por participante devem aparecer na interface?

A navegação já passou por revisões posteriores. O [escopo](../01-mvp.md) e os [relatos de QA](../../docs/README.md) registram essas entregas; os layouts de agosto não são requisitos atuais.
