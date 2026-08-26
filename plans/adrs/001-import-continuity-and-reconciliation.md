# ADR 001: continuidade de importações e reconciliação

- Status: implementada — validação automatizada e revisão independente aprovadas
- Data: 2026-08-25

## Decisões confirmadas

Em 2026-08-25 foram confirmadas as seguintes direções:

- priorizar um saldo atual confiável, com histórico anterior configurável;
- aceitar checkpoint manual datado quando o documento não informar saldo;
- importar a fatura aberta como provisória;
- nunca alterar silenciosamente uma transação já reconciliada quando a fonte
  reapresentar dados diferentes.
- usar uma data inicial comum de 90 dias para o onboarding, preservando
  observações anteriores sem exigir sua reconciliação inicial;
- incluir compras provisórias nos relatórios pela data da compra, com estado
  visual explícito;
- considerar a conta atualizada por até 15 dias, recomendar importação entre 16
  e 30 dias e marcá-la desatualizada depois disso;
- permitir concluir a importação sem checkpoint, mantendo a conta como não
  verificada e a ação de confirmar saldo disponível.
- tratar CSV sem saldo como importação concluída e manter a falta de checkpoint
  somente no estado de reconciliação da conta;
- nunca excluir silenciosamente uma observação por similaridade aproximada;
- inferir automaticamente períodos em nomes de arquivo reconhecidos, exibindo
  a inferência para correção, e aprender formatos desconhecidos após confirmação;
- reabrir a reconciliação a partir da data de qualquer correção bancária em fato
  já reconciliado;
- usar saldo lançado/contábil como checkpoint de reconciliação e registrar saldo
  disponível apenas como observação quando não houver equivalência comprovada;
- permitir checkpoint manual de fatura fechada com total e data de fechamento,
  mantendo a possibilidade de anexar evidência documental posteriormente.
- mostrar lançamentos pendentes como provisórios no saldo projetado e nos
  relatórios, excluindo-os da reconciliação até serem postados;
- nunca interpretar a ausência de uma linha numa exportação posterior como
  remoção sem evento explícito da fonte ou confirmação do usuário;
- permitir importações posteriores a uma lacuna comprovada, mantendo a
  cobertura incompleta e sem afirmar verificação integral do trecho;
- nunca criar ajuste de saldo automaticamente; ajustes são último recurso,
  explícitos, motivados e auditáveis;
- preservar em cada ponta de uma transferência a data postada pelo respectivo
  banco e reconciliar as contas de forma independente.
- permitir transferências internas de e para contas de investimento; um aporte
  é transferência patrimonial, não receita, despesa ou rendimento do ativo.

## Contexto

O app precisa aceitar importações semanais, quinzenais ou mensais de contas e
cartões sem duplicar lançamentos e sem afirmar uma precisão que o documento não
consegue provar.

Um CSV do Nubank pode conter somente `Data`, `Valor`, `Identificador` e
`Descrição`. Ele é suficiente para sincronizar lançamentos, mas não informa
saldo inicial, saldo final nem, dentro do conteúdo, a janela solicitada ao
banco.

O lote analisado contém quatro arquivos cujos nomes declaram janelas contínuas
de maio a agosto de 2026. Como o importador usa a primeira e a última transação
de cada arquivo como se fossem os limites do extrato, dias sem movimentação
foram registrados como três lacunas. As lacunas são falsas.

Os quatro arquivos já consolidados contêm identificadores externos distintos em
todas as linhas. Portanto, reimportar uma janela maior não deveria causar
divergência: lançamentos conhecidos devem ser reconhecidos e apenas os novos
devem entrar.

## Limite de prova

Um arquivo que contém apenas lançamentos não consegue, sozinho, provar que:

- nenhuma linha foi omitida pela instituição;
- todas as datas solicitadas estão representadas;
- o saldo absoluto calculado corresponde ao saldo bancário.

Isso é uma limitação da evidência, não um problema que IA consiga resolver. A IA
pode extrair ou classificar informação existente; não pode criar um saldo ou
provar a ausência de lançamentos.

## Garantias separadas

O produto deve separar cinco garantias hoje apresentadas de forma ambígua:

1. **Idempotência:** reimportar a mesma janela não duplica lançamentos.
2. **Cobertura:** o app sabe quais intervalos o arquivo declara cobrir.
3. **Reconciliação:** o saldo calculado fecha contra um saldo bancário datado.
4. **Temporalidade:** a data usada no razão é explícita e datas auxiliares são
   preservadas.
5. **Auditabilidade:** cada fato canônico mantém vínculo com sua evidência de
   origem.

Um CSV de movimentos pode satisfazer idempotência, temporalidade e
auditabilidade. Ele pode declarar cobertura, mas precisa de um checkpoint de
saldo independente para provar reconciliação.

## Decisão proposta

### 1. Importação sobreposta é o fluxo normal

Arquivos podem conter um mês, quatro meses ou qualquer outra janela suportada
pelo banco. O importador calcula a união idempotente das observações:

- identificadores já conhecidos são ignorados como repetição esperada;
- identificadores novos são adicionados;
- o mesmo identificador com conteúdo diferente vira revisão de correção
  bancária;
- candidatos sem identificador nunca são descartados silenciosamente por uma
  comparação aproximada.

O período do relatório — por exemplo, últimos 90 dias — é um filtro sobre a data
dos lançamentos canônicos. Ele não limita o período aceito no arquivo.

### 2. Janela declarada e janela de atividade são conceitos distintos

Cada documento deve armazenar:

- `declared_from` e `declared_to`: período que a fonte afirma cobrir;
- `declared_period_source`: metadado do arquivo, nome, confirmação do usuário ou
  desconhecido;
- `activity_from` e `activity_to`: primeira e última datas com lançamentos;
- `coverage_confidence`: força da evidência sobre o período declarado.

Dias sem transação pertencem à cobertura. Eles não são lacunas.

A ordem de confiança proposta para descobrir o período é:

1. metadado estruturado do documento;
2. adaptador determinístico para um nome de arquivo reconhecido;
3. confirmação explícita do usuário;
4. mínimo e máximo das transações, somente como janela de atividade e nunca
   como prova de cobertura completa.

### 3. Cobertura é uma união de intervalos com proveniência

Cobertura deve ser persistida por conta e documento. A união precisa considerar
arquivos novos e antigos, períodos sobrepostos e intervalos aninhados. Uma
lacuna só existe entre duas janelas declaradas confiáveis; não pode ser inferida
pela ausência de movimento.

### 4. Checkpoint de saldo é independente da importação

Um checkpoint registra:

- conta;
- saldo em centavos;
- data e, quando necessário, horário de referência;
- tipo do saldo: contábil/lançado, disponível ou saldo da fatura;
- fonte: OFX, PDF, entrada manual ou integração bancária;
- evidência e estado de revisão.

Com dois checkpoints compatíveis, a prova é determinística:

`saldo(t1) = saldo(t0) + soma dos lançamentos postados em (t0, t1]`

Sem checkpoint, o app pode mostrar movimentação líquida e saldo calculado desde
uma origem conhecida, mas não deve chamá-los de saldo verificado.

### 5. Observação importada e transação canônica são separadas

Uma linha bruta do arquivo é uma observação imutável. Uma transação canônica pode
ter várias observações provenientes de arquivos sobrepostos, de um CSV e de um
PDF, ou de versões corrigidas pela instituição.

Esse modelo permite:

- preservar a auditoria sem duplicar o razão;
- promover dados provisórios para postados/reconciliados;
- representar correções e remoções sem apagar a evidência anterior;
- usar um PDF como controle de um CSV sem gerar outra despesa.

### 6. Deduplicação em camadas

A ordem proposta é:

1. conta + identificador externo estável;
2. mesma observação do mesmo arquivo;
3. multiconjunto exato de data postada, valor, moeda, descrição normalizada e
   ocorrência;
4. similaridade de data/descrição apenas para sugerir um vínculo ou casar um
   lançamento manual.

Uma correspondência aproximada não pode excluir automaticamente uma linha
bancária ambígua. A multiplicidade precisa ser preservada: duas compras reais
iguais no mesmo dia continuam sendo duas compras.

### 7. IA é assistiva, não contábil

IA pode:

- reconhecer formato, cabeçalhos e locale;
- extrair período, saldo e totais de PDF;
- normalizar descrição;
- sugerir categoria, estabelecimento, parcela ou transferência;
- validar semanticamente um candidato determinístico.

IA não pode:

- somar ou arredondar valores no lugar da regra determinística;
- decidir que uma linha duplicada deve ser descartada;
- inventar período ou saldo ausente;
- aprovar uma reconciliação que não fecha.

Toda extração assistida termina em validações determinísticas de datas,
contagens, moeda, multiplicidade e saldos.

## UX proposta

O app deve exibir estados independentes por conta:

- `Atualizada até 23/08`: existe cobertura importada até essa data;
- `Saldo conferido em 31/07`: último checkpoint reconciliado;
- `23 dias ainda não conferidos`: cobertura posterior ao checkpoint;
- `Lacuna de 01/04 a 30/04`: somente quando comprovada por janelas declaradas.

Para CSV sem saldo:

> 3 lançamentos lidos. Nenhum duplicado. O arquivo cobre 01/05 a 31/05, mas não
> informa saldo. Para conferir o saldo, informe o valor exibido pelo banco em uma
> data ou importe o extrato mensal em PDF/OFX.

A ausência de saldo não deve bloquear a entrada de lançamentos válidos. Deve
impedir apenas que o app marque o saldo como reconciliado.

## Contas bancárias: rotina proposta

### Entrada inicial

1. Escolher uma data inicial por conta.
2. Importar toda janela disponível que cubra essa data até hoje, mesmo que haja
   sobreposição.
3. Criar um checkpoint com saldo bancário lançado/contábil em uma data conhecida,
   por PDF/OFX ou confirmação manual.
4. Mostrar separadamente o histórico importado e o trecho já reconciliado.

### Manutenção

- Importar semanal ou quinzenalmente com sobreposição generosa.
- Reconciliar ao menos mensalmente com PDF/OFX ou saldo bancário informado.
- Permitir reconciliação mais frequente sem torná-la obrigatória.

## Cartões e faturas

Cartão é um razão de passivo. A compra é a despesa; o pagamento da fatura é uma
transferência da conta bancária para o cartão e não outra despesa.

O ciclo deve guardar abertura, fechamento, emissão e vencimento separadamente.
“Fatura de maio” é um rótulo insuficiente porque o ciclo atravessa meses.

Estados propostos:

- `provisional`: ciclo aberto, ainda sujeito a alterações;
- `posted`: lançamento confirmado pelo emissor;
- `reconciled`: pertence a uma fatura fechada cujo total fecha.

Para iniciar com 90 dias:

1. importar a fatura fechada imediatamente anterior à janela como âncora;
2. importar todas as faturas fechadas cujos ciclos intersectem os 90 dias;
3. importar a atividade da fatura aberta como provisória, se disponível.

Na rotina, a atividade aberta pode ser reimportada semanal ou quinzenalmente. O
PDF definitivo do ciclo promove as mesmas transações para reconciliadas; não as
insere novamente.

Cada parcela lançada na fatura é realizada uma vez. Parcelas futuras são
projeções. Estornos são créditos quando postados e mantêm vínculo com a compra
original.

## Consequências

### Benefícios

- arquivos grandes e sobrepostos deixam de parecer erro;
- dias sem movimento não criam lacunas falsas;
- o usuário sabe exatamente o que está atualizado e o que está conferido;
- CSV, OFX e PDF podem cooperar sem dupla contagem;
- correções bancárias continuam auditáveis.

### Custos

- exige intervalos de cobertura com proveniência;
- exige checkpoint manual na UX;
- exige separar observações brutas de transações canônicas;
- exige estados provisório, postado e reconciliado;
- exige migração dos dados atuais e testes com formatos de bancos diferentes.

## Questões ainda abertas

Nenhuma decisão de produto permanece aberta para esta ADR. A implementação e a
migração dos dados existentes foram autorizadas em 2026-08-25.

## Referências

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
