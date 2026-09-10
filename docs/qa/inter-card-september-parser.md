# Fatura Inter com separador de fonte e antecipações

Verificação em 10/09/2026, checkout `/Users/donaldsilveira/Git/financas-familia`, base `fef0d59`, com alterações locais preexistentes preservadas.

## Reprodução e correção

A leitura isolada do PDF informado pelo usuário reproduziu a mensagem de compras extraídas iguais a zero. O arquivo usa U+E054 como separador antes do valor. O parser aceitava apenas hífen.

Após reconhecer o separador, a reconciliação revelou que o resumo informa despesas brutas, enquanto o detalhamento também contém um crédito. A nova alternativa exige igualdade exata das compras brutas com as despesas do mês, igualdade entre fatura atual mais antecipação e despesas do mês, e antecipação suficiente para cobrir os créditos. Os créditos continuam sendo lançamentos positivos. Nenhum pagamento é criado para completar a diferença.

A leitura completa também bloqueava o PDF porque a conversão Markdown perdia conteúdo. O parser institucional usa texto posicionado. Para layouts reconhecidos, a comparação de integridade agora considera essa extração; layouts desconhecidos continuam sujeitos à comparação Markdown. OCR e os demais bloqueios permanecem.

## Evidência automatizada

- `pnpm setup:check`: passou com banco e PDF sintéticos.
- `pnpm verify`: passou em TypeScript, ESLint, testes e build. Foram 492 testes aprovados e 10 ignorados, em 80 arquivos aprovados e 2 ignorados. Os testes privados condicionais não habilitados não contam como cobertura do PDF indicado, cuja leitura foi executada separadamente acima.
- Teste parametrizado de compras, parcelas e pagamento com hífen e U+E054: falhou com zero extraído antes da correção e passou depois.
- Teste de despesas brutas com crédito e antecipação: falhou antes da correção e passou depois. Alterações de um centavo em compras ou controles e remoção de compra continuam rejeitadas.
- Integração com PDF sintético e Markdown vazio: falhou antes da correção e passou depois. Perda do texto posicionado continua rejeitada; layout desconhecido mantém o diagnóstico de perda de Markdown.
- PDF privado indicado pelo usuário, leitura local por `readStatement`, sem IA e sem escrita no banco: 116 lançamentos, nenhum bloqueio, auditoria `reconciled`, diferença zero. O documento privado não foi adicionado ao repositório nem ao ambiente QA.

## Navegador

Ambiente sintético iniciado em `http://127.0.0.1:3117`, diretório `.qa/run-pTONqG`. A ferramenta integrada retornou `No browser is available`. Upload, revisão, confirmação e reimportação pela interface não foram verificados, nem desktop ou celular. Os testes de servidor acima são evidência separada.

Servidor encerrado e diretório removido por `pnpm qa:clean`. O lote real que já estava com erro não foi reprocessado; requer reenvio do PDF.
