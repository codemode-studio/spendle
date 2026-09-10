# ADR 001: continuidade de importações e reconciliação

Decisão de 25/08/2026, implementada. Os resultados de cada verificação ficam nos [relatos de QA](../../docs/README.md).

## Problema

O importador confundia a primeira e a última transação com o período exportado. Dias sem movimento viravam lacunas falsas. Arquivos sobrepostos também precisam reconhecer lançamentos conhecidos sem perder compras legítimas iguais.

Um CSV só com movimentos não prova saldo absoluto, ausência de linhas omitidas ou período completo. Extração por IA não supre essa evidência.

## Garantias independentes

| Garantia      | O que comprova                                       |
| ------------- | ---------------------------------------------------- |
| Idempotência  | Reimportar não duplica lançamentos                   |
| Cobertura     | Intervalos declarados pela fonte, com proveniência   |
| Reconciliação | Saldo calculado igual ao checkpoint bancário datado  |
| Temporalidade | Data postada explícita, datas auxiliares preservadas |
| Auditoria     | Vínculo entre fato canônico e observações originais  |

Importação concluída não significa saldo reconciliado. Sem checkpoint, movimentos válidos podem entrar após as revisões exigidas, mas a conta permanece não verificada. Divergência conhecida nunca é liberada por confirmação manual.

## Importação e cobertura

- Sobreposição é esperada. Identificador conhecido com os mesmos dados é repetição; conteúdo diferente exige revisão de correção.
- Cada documento guarda período declarado, origem dessa informação, intervalo de atividade e confiança de cobertura.
- A descoberta usa metadados estruturados, nome reconhecido ou confirmação humana. Mínimo e máximo das transações indicam somente atividade.
- Cobertura é a união dos intervalos confiáveis por conta e documento. Só há lacuna entre janelas declaradas, não entre dias com movimento.
- Períodos inferidos pelo nome ficam visíveis para correção. Formatos desconhecidos são aprendidos após confirmação.
- Uma lacuna não impede importar períodos posteriores; impede afirmar cobertura integral.
- O início comum do onboarding é de 90 dias, configurável. Observações anteriores ficam preservadas sem exigir reconciliação inicial.
- A conta fica atualizada até 15 dias, recebe recomendação de importação entre 16 e 30 e fica desatualizada depois disso. Cobertura e último saldo conferido aparecem separados.

## Checkpoints

Um checkpoint registra instrumento, saldo em centavos, data, tipo de saldo, fonte e evidência. Saldo contábil/lançado é a referência; saldo disponível só serve quando houver equivalência comprovada.

A prova entre checkpoints compatíveis é:

`saldo(t1) = saldo(t0) + movimentos postados em (t0, t1]`

A diferença aceita é zero. Sem referência suficiente, o app mostra movimentos ou saldo calculado, sem chamá-lo de verificado. Checkpoint manual datado é permitido quando o documento não traz saldo. Não há ajuste automático; qualquer ajuste exige decisão, motivo e auditoria.

Correção de fato reconciliado reabre a cadeia a partir da data afetada. Cada ponta de uma transferência mantém a data postada do seu banco e reconcilia separadamente.

## Observações e deduplicação

Observações importadas são imutáveis. Um lançamento canônico pode reunir evidências de arquivos sobrepostos, CSV/PDF ou versões corrigidas.

A deduplicação prioriza conta e identificador externo, depois a mesma observação do arquivo e o multiconjunto exato de data, valor, moeda, descrição normalizada e ocorrência. Duas compras iguais continuam sendo duas compras. Similaridade aproximada só sugere vínculo ou correspondência com lançamento manual.

Ausência de uma linha em exportação posterior não significa remoção. É necessário evento explícito da fonte ou confirmação humana. Um PDF de controle pode confirmar o CSV sem gerar outra despesa.

## Cartões e investimentos

- Compra é despesa; pagamento de fatura é transferência entre conta e cartão.
- Ciclos preservam abertura, fechamento, emissão e vencimento. Atividade aberta é provisória e fica fora da reconciliação até a postagem.
- A fatura fechada promove os mesmos lançamentos, sem reinseri-los. Pode receber checkpoint manual de total e fechamento, com evidência documental anexada depois.
- Para iniciar a janela de 90 dias, a fatura fechada anterior serve de âncora; entram as faturas que cruzam a janela e a atividade aberta disponível.
- Cada parcela é realizada uma vez; parcelas futuras são projeções. Estorno é crédito postado vinculado à compra.
- Transferências para investimentos são aportes patrimoniais, sem criar receita, despesa ou rendimento.

## IA e operação

IA pode auxiliar extração e sugestões, mas não inventa saldos, descarta duplicidades ou aprova divergências. Datas, contagens, moedas, multiplicidades e saldos passam por validação determinística.

A rotina aceita importações semanais ou quinzenais sobrepostas e conferência mensal por documento ou saldo informado. Histórico importado, cobertura e trecho reconciliado precisam continuar distinguíveis.

A implementação exige intervalos com proveniência, checkpoints manuais, separação entre observações e fatos canônicos e estados provisório/postado/reconciliado. O mapa dos módulos está em [arquitetura](../architecture.md).

## Referências da decisão original

- [Nubank: diferença entre histórico e extrato](https://blog.nubank.com.br/extrato-bancario/)
- [YNAB: importação por arquivo e duplicidades](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo)
- [YNAB: reconciliação de contas](https://support.ynab.com/en_us/reconciling-accounts-a-guide-BJFE3fHys)
- [Actual Budget: importação e deduplicação](https://actualbudget.org/docs/transactions/importing/)
- [Actual Budget: reconciliação](https://actualbudget.org/docs/accounts/reconciliation/)
- [Actual Budget: transferências](https://actualbudget.org/docs/transactions/transfers/)
- [Plaid: sincronização incremental](https://plaid.com/docs/transactions/sync-migration/)
- [Plaid: estados de transação](https://plaid.com/docs/transactions/transactions-data/)
- [GnuCash: reconciliação contra extrato](https://wiki.gnucash.org/docs/C/gnucash-manual/acct-reconcile.html)
- [OFX Banking Specification 2.3](https://financialdataexchange.org/common/Uploaded%20files/OFX%20files/OFX%20Banking%20Specification%20v2.3.pdf)
- [Nubank: funcionamento da fatura](https://blog.nubank.com.br/fatura-cartao-nubank/)
- [Banco Central: informações da fatura](https://www.bcb.gov.br/detalhenoticia/771/noticia)
