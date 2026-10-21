# Glossário

## Atividade observada

Intervalo entre a primeira e a última transação do arquivo. Não prova cobertura nem lacunas.

## Aporte em conta de investimento

Transferência para conta própria de investimento. Movimenta patrimônio, sem criar receita, despesa ou rendimento.

## Caixa operacional

Soma dos saldos das contas ativas de finalidade operacional, reconstruída por checkpoints e movimentos postados e convertida para a moeda-base. É o "Caixa atual" da Home e o ponto de partida da previsão. O saldo que o Open Finance informa para a conta conta como saldo real, mas um saldo contábil do mesmo dia prevalece. Sem cotação para uma conta em moeda estrangeira, o caixa é desconhecido.

## Checkpoint de saldo

Saldo datado de conta ou cartão, com tipo e evidência. Serve de referência para reconciliação.

## Cobertura

União dos períodos declarados pelos documentos de uma conta. Não comprova saldo reconciliado.

## Data de autorização

Data em que a compra foi autorizada, que pode anteceder a postagem.

## Data postada

Data em que a instituição efetivou o lançamento. Referência principal da reconciliação.

## Despesa fixa temporária

Compra em quatro ou mais parcelas. Tem término contratado; não cria recorrência.

## Envelope de recorrência

Recorrência com `matchMode = aggregate`. Cada período reúne vários lançamentos e fecha com a soma realizada.

## Fatura aberta

Ciclo ainda sujeito a lançamentos e correções; dados provisórios.

## Fatura fechada

Ciclo definitivo com total, fechamento e vencimento. Pode fornecer checkpoint se o total conferir.

## Idempotência

Repetir a importação não muda o resultado. Arquivos sobrepostos adicionam apenas lançamentos novos.

## Identificador externo

Código de transação fornecido pela instituição, limitado à conta e à fonte.

## Janela declarada

Período exportado informado por metadados, nome reconhecido ou confirmação humana.

## Lacuna

Intervalo entre janelas declaradas confiáveis sem cobertura. Dias sem transações não bastam para indicar lacuna.

## Lançamento canônico

Registro único usado no razão e nos relatórios, apoiado por uma ou mais observações.

## Margem livre projetada

Renda futura menos compromissos e metas. É uma projeção, não saldo bancário.

## Multiplicidade

Quantidade legítima de registros iguais. Duas compras iguais no mesmo dia continuam sendo duas compras.

## Observação importada

Linha bruta imutável, vinculada ao arquivo, parser, versão e evidência.

## Ocorrência

Período de uma recorrência, com valor esperado, moeda, categoria, estado e lançamentos vinculados.

## Reconciliação

Conferência de saldo por checkpoints e movimentos postados, com diferença zero.

## Recorrência

Regra mensal ou anual de receita ou despesa, com calendário e tolerâncias para vincular lançamentos reais.

## Saldo disponível

Valor liberado pelo banco, que pode incluir limites e bloqueios. Não equivale necessariamente ao saldo contábil, então não prova saldos; o do Open Finance serve de saldo real para o caixa operacional.

## Saldo lançado ou contábil

Saldo de transações postadas; referência usual para reconciliar o razão.

## Transferência interna

Movimento entre instrumentos próprios, com ambas as pontas vinculadas e preservadas. Não cria receita ou despesa.

## Vazamento financeiro

Sinal de gasto a investigar, com evidência e comparação. Não é categoria contábil nem julgamento sobre a despesa.
