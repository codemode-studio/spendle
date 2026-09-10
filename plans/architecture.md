# Arquitetura

O fluxo de importação é organizado por responsabilidade, com decisões de
domínio separadas de leitura de arquivos, persistência e apresentação.

## Fluxo principal

1. `statement-reader.server.ts` valida a extensão, escolhe o adaptador OFX,
   CSV ou PDF e devolve um resultado normalizado, incluindo identidade,
   cobertura, controles e diagnósticos. `import-stage.server.ts` persiste o
   arquivo e suas observações imutáveis para revisão.
2. `canonicalization.ts` contém as decisões puras que classificam cada
   observação como nova, conhecida, evidência, correção ou exclusão. Cada
   candidato é consumido no máximo uma vez, preservando multiplicidade.
3. `canonical-outcome.server.ts` carrega o estado persistido e produz um
   `ImportOutcome`: decisões por observação, checkpoint, ciclo, promoções,
   cobertura e vínculos de evidência do lote. `applyImportOutcome` é o único
   escritor desse resultado e aplica tudo na transação ativa.
4. `import-commit.server.ts` orquestra carregar, resolver o resultado e chamar
   o escritor uma vez. `import-control-reconciliation.server.ts` usa a mesma
   fronteira para controles CSV/PDF; cada operação lógica abre uma única
   transação. `import.server.ts` permanece apenas como fachada de exportação.
5. `coverage-lifecycle.server.ts` mantém o período declarado, a confiança da
   cobertura e o aprendizado de nomes de arquivo.
6. `checkpoint-chain.server.ts` aplica checkpoints, ciclos e promoções de
   pendente para confirmado, além de invalidar a cadeia a partir de uma
   correção e recalcular a âncora de saldo do instrumento.
7. `reconciliation-refresh.server.ts` recompõe sugestões derivadas. Depois de
   um commit durável, falhas na evidência do lote, cobertura ou reconciliação
   retornam estado `deferred`, não transformam a importação concluída em erro e
   podem ser repetidas explicitamente pela interface.

## Fronteiras de leitura e manutenção

- `import-review-read.server.ts` entrega somente os dados usados pela tela de
  importação. O cache de revisão é invalidado imediatamente; snapshots
  financeiros inativos são apenas marcados como obsoletos.
- `import-provenance-repair.server.ts` concentra reparos idempotentes de dados
  antigos. `index.server.ts` permanece responsável apenas por abrir, migrar,
  semear e verificar o banco.

`finance-snapshot.server.ts` monta o snapshot financeiro e seu histórico,
`import-resolution.server.ts` reúne as mutações de resolução da revisão de
importações, e `planning.server.ts` mantém configurações, estratégia, metas e
fechamento do orçamento.

## Recorrências

`src/features/finance/recurrence.server.ts` é a interface de servidor da
Recorrência. O módulo concentra cadastro, atualização do calendário, detecção,
sugestões, vínculos e transições de ocorrências. `recurrence-book.ts` é o modelo
de leitura puro usado para escolher a ocorrência atual e descrever seu estado.

`recurrence-matching.ts`, `recurrence-detection.ts` e
`recurrence-schedule.ts` são detalhes internos do módulo. Rotas e outros
módulos de produto não importam esses arquivos; chamam server functions ou o
modelo de leitura.

`src/features/planning` reúne as derivações puras e as seções de apresentação
do planejamento, enquanto a rota carrega o read model e compõe essas seções.

## Base de conhecimento

`knowledge-base.server.ts` guarda na tabela `knowledge_base` as decisões
humanas por assinatura de estabelecimento (`merchantSignature`) e direção do
valor: a categoria escolhida na lista de transações ou na revisão de um lote, e
o estabelecimento vinculado a uma recorrência ao confirmar ou aprovar um
pagamento. Heurística, histórico implícito, vínculos automáticos e IA não
escrevem nela. Reafirmar a mesma decisão soma `confirmations`; trocar a decisão
conta uma `corrections`. As entradas não dependem do ledger, então sobrevivem a
`clearTransactionData` e a reimportações.

Entradas de categoria casam pelo padrão (`src/domain/knowledge-pattern.ts`):
a assinatura sem sufixo de parcela e sem prefixo de processador de pagamento
(lista fechada). Um padrão pode ser `exact` ou `prefix`; o prefixo casa no
limite de token e só nasce por decisão explícita, na aba Conhecimento ou na
lista aprovada das migrações `0036` e `0037` (`ifd`, `mercadolivre`, `shopee`,
`mp`, `nuv`). O padrão exato vence o prefixo; uma entrada exata da mesma
categoria coberta por um prefixo é redundante e é absorvida por ele. Recorrências continuam casando pela assinatura completa.

Na preparação de um lote, a base substitui apenas sugestões sem origem ou
heurísticas (`suggestionSource = 'knowledge'`, confiança 98 para padrão exato e
92 para prefixo); regras explícitas, transferências aprendidas e políticas de
destino continuam prevalecendo.
`loadCategoryKnowledge` devolve um resolvedor com índices e precedência privados.
O lote limita a leitura exata aos padrões de suas observações; a sincronização
consulta a base completa. Ambos usam o mesmo matching de direção, alternativas
exatas e prefixo mais longo. A política de substituição continua no fluxo:
`applyCategoryKnowledge` preserva sugestões fortes, enquanto a sincronização
protege transferências, pagamentos de fatura e contrapartes.

Categorias de sistema (`uncategorized`, `transfer`, `card_payment`) nunca são
aprendidas. Os aliases de recorrência entram nas assinaturas conhecidas da
detecção e no matching; desvincular um pagamento remove o alias, e excluir a
recorrência ou a categoria apaga as entradas por cascata.

A aba Conhecimento permite corrigir, editar padrões e esquecer entradas.
`knowledge-sync.server.ts` sincroniza apenas a entrada editada; a sincronização
completa parte de Transações, com prévia. Transferências, pagamentos de fatura
e contrapartes são protegidos.

As migrações da base usam funções SQL registradas em `connection.server.ts`,
indisponíveis no CLI do Drizzle. A migração `0034` reconstruiu decisões humanas
registradas; `0035` a `0037` estão resumidas no [registro de categorias e padrões](reclassificacao-comida-e-kb.md).

## Lançamento (read model)

`src/domain/ledger.ts` transforma o snapshot financeiro em
`FamilyTransaction`, a linha plana consumida pela Home e por Categorias. O
módulo decide o escopo familiar, a conversão para o valor-base e as exclusões de
transferências internas. Também calcula os mapas de gasto atual e anterior por
categoria. As features podem acrescentar séries mensais ou agrupar "Outras",
mas não repetem esses predicados.

A leitura de Categorias vem de `category-ledger.server.ts`. Ela carrega escopos,
lançamentos com conta/cartão/categoria e vínculos de reconciliação em três
consultas. `familyTransactions` continua decidindo inclusão, conversão e exclusão
de transferências; essa leitura não monta o dashboard nem calcula projeções.
`getCategoryTransactions` permanece reexportado por `finance-snapshot.server.ts`.
O benchmark compara essa leitura com o caminho anterior pelo snapshot completo.

## Previsão de caixa

`src/domain/monthly-cash-flow.ts` recebe fatos financeiros, mês, data de referência
e compromissos do mês. O módulo seleciona contas operacionais ativas, reconstrói
saldos, converte moedas, exclui transferências próprias dos recebimentos e
pagamentos, e combina recorrências e pendências sem contar duas vezes uma
ocorrência persistida. Cotações dos saldos respeitam a data; projeções mantêm a
cotação mais recente, e movimentos realizados mantêm o valor-base persistido.

`pendingRecurrencePayments` fornece o mesmo matching de pendências ao orçamento
e ao caixa. Não grava vínculos. O snapshot permanece responsável pela montagem
do orçamento e seus compromissos; entrega esses dados a `buildMonthlyCashFlow`.
Reconstrução histórica e aritmética dos totais são detalhes internos testados
pela leitura do caixa a partir dos fatos.

## Período de análise

`src/domain/period.ts` concentra intervalos inclusivos em datas ISO, janelas
móveis, período anterior, meses abrangidos e rótulos em pt-BR. Os cálculos usam
UTC para não variar com o fuso do processo. Funções que consultam a data atual
aceitam uma data opcional, o que mantém testes e análises reproduzíveis.

## Banco de dados e testes

`connection.server.ts` abre Drizzle/SQLite. O proxy `db` de `index.server.ts`
resolve a conexão no primeiro uso. `ensureDatabase()` executa migrações, seed,
reparo de proveniência e verificação de chaves estrangeiras uma vez por conexão.
O caminho padrão é `data/financas.db`.

`openTestDatabase({ seed })`, em `src/test/database.ts`, instala uma conexão
isolada e retorna `{ db, schema, close, ids }`. O diretório temporário também
recebe uploads. O seed padrão `minimal` fornece IDs estáveis; `production`
verifica os dados iniciais reais. `resetTestDatabase()` recria o banco com o
mesmo seed. Cada arquivo de teste tem seu próprio SQLite.

## Regras de dependência

- Adaptadores de arquivo dependem do formato, não do fluxo de commit.
- Funções puras de domínio não dependem do banco ou da interface.
- Módulos de persistência recebem a transação ativa quando a atomicidade faz
  parte da regra.
- Rotas chamam server functions e read models; não montam regras financeiras.
- Evidência importada nunca substitui silenciosamente um lançamento canônico.

As garantias financeiras e decisões de continuidade permanecem normativas no
[ADR 001](./adrs/001-import-continuity-and-reconciliation.md).
