# Glossário financeiro e de importação

## Atividade observada

Intervalo entre a primeira e a última transação presentes em um arquivo. Não
prova que o arquivo cobre somente esse intervalo nem que houve lacuna nos dias
sem movimento.

## Aporte em conta de investimento

Transferência interna cujo destino é uma conta com finalidade de investimento.
O aporte movimenta patrimônio entre contas próprias e, por isso, não é receita
nem despesa. A compra ou valorização posterior do ativo é registrada
separadamente.

## Checkpoint de saldo

Saldo de uma conta ou cartão em uma data de referência, acompanhado do tipo do
saldo e da fonte da evidência. É a âncora usada para reconciliar o razão.

## Cobertura

Conjunto de intervalos que documentos ou integrações declaram representar para
uma conta. Cobertura não significa saldo reconciliado.

## Data de autorização

Momento em que uma compra foi autorizada. Pode ser anterior à data em que o
lançamento se torna definitivo.

## Data postada

Data em que a instituição efetivou o lançamento no razão. É a data principal
para reconciliação, preservando a data de autorização como metadado.

## Despesa fixa temporária

Compra parcelada em quatro ou mais vezes. Ela compromete um valor mensal fixo,
mas termina na última parcela. Não é uma recorrência: o número de cobranças já
foi contratado e o app projeta somente as parcelas restantes.

## Fatura aberta

Ciclo de cartão ainda sujeito a novos lançamentos e correções. Seus dados são
provisórios.

## Fatura fechada

Documento definitivo de um ciclo de cartão, com total, fechamento e vencimento.
Pode funcionar como checkpoint quando o total fecha contra os lançamentos.

## Idempotência

Propriedade que permite repetir uma importação sem alterar o resultado depois da
primeira aplicação. Em termos práticos, arquivos sobrepostos adicionam somente
lançamentos realmente novos.

## Identificador externo

Código fornecido pela instituição para uma transação. Deve ser escopado pela
conta e pela fonte; não é necessariamente único globalmente.

## Janela declarada

Período que o documento ou o usuário afirma ter sido exportado. Pode vir de
metadados estruturados, do nome do arquivo ou de confirmação manual.

## Lacuna

Intervalo não coberto entre duas janelas declaradas confiáveis. Ausência de
transações em certos dias não constitui lacuna.

## Lançamento canônico

Representação única usada pelo razão e pelos relatórios. Pode estar apoiada por
várias observações importadas.

## Margem livre projetada

Parte da renda futura que ainda não está comprometida por despesas recorrentes,
parcelas contratadas, metas e outros compromissos conhecidos. É uma projeção e
não um saldo bancário.

## Multiplicidade

Quantidade de ocorrências legítimas com os mesmos atributos. Deduplicação deve
preservar, por exemplo, duas compras iguais realizadas no mesmo dia.

## Observação importada

Linha ou item bruto extraído de uma fonte. É imutável e mantém referência ao
arquivo, parser, versão e evidência original.

## Reconciliação

Prova de que o saldo calculado a partir de um checkpoint e dos lançamentos
postados coincide com outro saldo bancário datado. A diferença deve ser zero.

## Saldo disponível

Valor que o banco permite usar naquele momento. Pode considerar limites,
bloqueios e lançamentos pendentes; não deve ser misturado com saldo contábil sem
uma regra explícita.

## Saldo lançado ou contábil

Saldo composto por transações já postadas pela instituição. É normalmente a
referência adequada para reconciliar um razão de transações postadas.

## Transferência interna

Movimentação entre dois instrumentos pertencentes ao mesmo conjunto financeiro.
As duas pontas permanecem em seus respectivos ledgers, são vinculadas e não
viram receita nem despesa.

## Vazamento financeiro

Sinal explicável de que um gasto merece investigação, como aumento contra o
histórico, estouro de limite, cobrança esquecida ou acúmulo de compromissos. Não
é uma categoria contábil e não implica que a despesa seja inútil.
