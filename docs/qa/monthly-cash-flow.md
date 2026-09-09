# Fluxo de caixa mensal

Verificado em 8 de setembro de 2026 no checkout `7ee8e81` com alterações locais.

A visão geral passou a partir da soma dos saldos das contas de movimentação. A projeção soma entradas futuras registradas ou previstas em recorrências e desconta apenas compromissos ainda não pagos. A renda base do orçamento não é uma entrada prevista. Metas de aporte aparecem separadas. O layout dos painéis, barras de categorias e anéis foi mantido.

O resumo e o mês atual usam o mesmo fluxo: Caixa, Entradas previstas, Ainda a pagar e Caixa previsto no fim do mês. O gráfico mensal representa caixa de fechamento, com projeção para o mês atual e valores negativos abaixo da linha de zero. Meses anteriores mostram saldo inicial, entradas, saídas e saldo final registrados. Saldos históricos são reconstruídos a partir de saldos datados e movimentos confirmados; ausência de referência suficiente aparece como indisponível. Diferenças entre os saldos e os movimentos são explicitadas, sem criar lançamentos de ajuste. Câmbio histórico usa taxas registradas até a data consultada.

## Navegador

Execução sintética `.qa/run-F66NYt`, `http://127.0.0.1:3117`. Criadas pela interface uma entrada de R$ 1.000,00 e uma despesa Mercado de R$ 10,00, ambas em 08/09/2026. Caixa e caixa previsto mostraram R$ 990,00, com zero ainda a pagar. A despesa já paga permaneceu no total de despesas do mês e não foi descontada novamente da projeção.

A categoria da despesa foi alterada para Lazer pelo navegador. Resumo e mês a mês passaram a mostrar R$ 10,00 em Estilo de vida, preservando o caixa de R$ 990,00. Configuração do orçamento abriu e manteve a base de R$ 60 mil. Navegação, recarga e seleção de agosto/setembro preservaram os valores. Agosto vazio permaneceu sem valores para comparar. `qa:inspect` confirmou exatamente duas transações, de 100000 e -1000 centavos, sem violações de chaves estrangeiras.

Inspeção visual em 1280 × 800 e verificação de layout em 320 × 740. Documento com 320 px, sem overflow horizontal. Sem erros da aplicação na captura verificada. O cenário negativo do gráfico não foi exercitado pelo navegador nesta rodada.

Leitura no principal, porta 3000, confirmou Caixa R$ 48.455,70, entradas previstas R$ 0,00, ainda a pagar R$ 34.702,96 e caixa previsto R$ 13.752,74. Após as metas ainda não realizadas, a projeção fica em R$ 1.752,74. Esses valores dependem das estimativas e registros disponíveis. A simulação da porta 3109 recebeu os mesmos arquivos de código; nenhum CSV foi reimportado.

## Verificações

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram. Resultado: 475 testes aprovados e 10 ignorados, em 74 arquivos aprovados e dois ignorados. Os ignorados dependem de fixtures privadas ou serviços externos. Testes novos verificam caixa inicial, receitas esperadas, despesas já pagas, centavos, reconstrução por saldo datado, ausência de saldo histórico, imutabilidade e igualdade entre resumo e detalhe mensal. As suítes existentes de conciliação, parcelas e alocações congeladas também passaram.

`pnpm bench` passou: histórico de 12 meses com 28 consultas, 16.343 bytes e cerca de 41 ms; três meses mantiveram 28 consultas. Não houve importação por navegador, IA real ou escrita no banco principal por esta tarefa. A comparação somente leitura com a cópia de auditoria encontrou oito categorias de transações diferentes; essas classificações atuais foram preservadas. Importações, arquivos, conhecimento, orçamentos, recorrências e ciclos continuaram iguais à cópia. A execução de QA foi encerrada e limpa após o registro da evidência.
