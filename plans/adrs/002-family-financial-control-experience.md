# ADR 002: experiência de controle financeiro familiar

- Status: em elaboração
- Data: 2026-08-27

## Contexto

O produto acumulou páginas separadas para visão geral, contas, cartões,
transações, importação e planejamento. Os dados financeiros estão ficando mais
confiáveis, mas a interface ainda privilegia a estrutura do sistema. A família
precisa entender desvios, compromissos e decisões sem percorrer cada ledger.

Gráficos e IA não resolvem esse problema sozinhos. Primeiro precisamos definir
as perguntas que o produto responde e separar cálculo financeiro, investigação
e ação.

## Decisões confirmadas

### A visão principal orienta uma decisão

Ao abrir o app, a família deve conseguir responder:

1. estamos dentro do plano;
2. onde houve um desvio relevante;
3. qual ação merece atenção agora.

Patrimônio detalhado, configuração de instrumentos e o razão permanecem
disponíveis como aprofundamentos.

### A família é o recorte padrão

A visão padrão agrega a família e permite recortes por Donald e Dayane. A
agregação não apaga a autoria: contas, cartões, instrumentos, transações e
compromissos continuam vinculados ao participante correto.

### Estratégia e controle por categoria têm papéis diferentes

Os quatro envelopes continuam representando a estratégia familiar. Limites por
categoria são opcionais e controlam somente gastos que a família escolheu
acompanhar mais de perto.

### Vazamento é um conjunto de sinais

O produto não atribui um rótulo moral a uma categoria. Ele mostra evidências
como variação contra o histórico, estouro de limite, recorrência esquecida e
acúmulo de parcelas. Cada sinal deve declarar período, base de comparação e
lançamentos envolvidos.

### Parcelas afetam realização e projeção

Uma compra em quatro ou mais vezes é uma despesa fixa temporária. Cada parcela
entra no realizado do mês correspondente. As parcelas futuras reduzem a margem
livre projetada dos próximos 90 dias.

### O mês-calendário continua como período principal

Durante um mês aberto, o app compara somente dias equivalentes dos três meses
anteriores. Uma projeção separada cobre os 90 dias seguintes.

## Direção proposta para IA

A IA deve funcionar como investigadora sob demanda, não como calculadora nem
como autora obrigatória de relatórios periódicos. O sistema calcula totais,
variações, projeções e candidatos de forma determinística. A IA recebe consultas
somente de leitura, conecta sinais e explica hipóteses com referências aos dados
que sustentam cada afirmação.

Essa direção ainda depende de confirmação nas próximas rodadas.

## Questões abertas

- Qual será a primeira tarefa de IA que justifica sua presença no produto?
- A IA começa por perguntas livres, por sinais automáticos ou pelos dois?
- Quais dados podem sair do computador e em qual granularidade?
- Como instrumentos compartilhados atribuem gastos a Donald, Dayane ou família?
- Quais áreas permanecem na navegação principal depois da simplificação?

## Consequências esperadas

- a home deixa de ser um resumo de todas as tabelas;
- análises precisam expor evidência e período de comparação;
- projeções de compromissos deixam de se misturar com gastos realizados;
- a IA precisa de uma camada de consultas financeiras somente de leitura;
- protótipos podem comparar modelos de interação, não apenas estilos visuais.
