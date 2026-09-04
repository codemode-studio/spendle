# Arquitetura do domínio de importação

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

## Lançamento (read model)

`src/domain/ledger.ts` transforma o snapshot financeiro em
`FamilyTransaction`, a linha plana consumida pela Home e por Categorias. O
módulo decide o escopo familiar, a conversão para o valor-base e as exclusões de
transferências internas. Também calcula os mapas de gasto atual e anterior por
categoria. As features podem acrescentar séries mensais ou agrupar "Outras",
mas não repetem esses predicados.

## Período de análise

`src/domain/period.ts` concentra intervalos inclusivos em datas ISO, janelas
móveis, período anterior, meses abrangidos e rótulos em pt-BR. Os cálculos usam
UTC para não variar com o fuso do processo. Funções que consultam a data atual
aceitam uma data opcional, o que mantém testes e análises reproduzíveis.

## Banco de dados e testes

`src/db/connection.server.ts` abre uma conexão Drizzle/SQLite a partir de uma
URL. Em produção, `src/db/index.server.ts` só cria essa conexão no primeiro uso
de `db` ou `ensureDatabase()`. O caminho continua vindo de `DATABASE_URL`, com
`./data/financas.db` como padrão. O `db` exportado é um proxy tipado, portanto os
módulos de servidor mantêm o mesmo import e resolvem a conexão ativa ao executar
cada operação.

`ensureDatabase()` inicializa cada conexão uma vez. A sequência continua sendo
migração dos arquivos em `drizzle/`, seed, reparo de proveniência e verificação
de chaves estrangeiras. O seed de produção fica em `src/db/seed.server.ts`.

Testes usam `openTestDatabase({ seed })` de `src/test/database.ts`. A função cria
um diretório temporário exclusivo, instala a conexão antes de qualquer consulta,
roda as mesmas migrações e retorna `{ db, schema, close, ids }`. O seed `minimal`
é o padrão e fornece IDs estáveis para três escopos, uma conta BRL, um cartão e
as categorias usadas pelos testes. Casos que verificam os dados iniciais reais
pedem `seed: 'production'`. `resetTestDatabase()` fecha e remove o arquivo atual,
abre outro com o mesmo tipo de seed e devolve o novo objeto de acesso. Cada
arquivo de teste usa seu próprio banco, então o paralelismo padrão do Vitest não
compartilha arquivos SQLite.

## Regras de dependência

- Adaptadores de arquivo dependem do formato, não do fluxo de commit.
- Funções puras de domínio não dependem do banco ou da interface.
- Módulos de persistência recebem a transação ativa quando a atomicidade faz
  parte da regra.
- Rotas chamam server functions e read models; não montam regras financeiras.
- Evidência importada nunca substitui silenciosamente um lançamento canônico.

As garantias financeiras e decisões de continuidade permanecem normativas no
[ADR 001](./adrs/001-import-continuity-and-reconciliation.md).
