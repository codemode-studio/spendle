# Arquitetura do domínio de importação

O fluxo de importação é organizado por responsabilidade, com decisões de
domínio separadas de leitura de arquivos, persistência e apresentação.

## Fluxo principal

1. `statement-reader.server.ts` escolhe o adaptador OFX, CSV ou PDF e devolve
   um resultado normalizado, incluindo identidade, cobertura, controles e
   diagnósticos.
2. `canonicalization.ts` decide se cada observação representa um lançamento
   novo, um lançamento conhecido ou evidência de controle. A decisão consome
   cada candidato no máximo uma vez.
3. `canonicalization.server.ts` grava o vínculo auditável entre observação e
   lançamento canônico.
4. `coverage-lifecycle.server.ts` mantém o período declarado, a confiança da
   cobertura e o aprendizado de nomes de arquivo.
5. `checkpoint-chain.server.ts` mantém checkpoints, invalida toda a cadeia a
   partir de uma correção e recalcula a âncora de saldo do instrumento.
6. `reconciliation-refresh.server.ts` recompõe sugestões derivadas. Depois de
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

## Recorrências

`src/features/finance/recurrence.server.ts` é a interface de servidor da
Recorrência. O módulo concentra cadastro, atualização do calendário, detecção,
sugestões, vínculos e transições de ocorrências. `recurrence-book.ts` é o modelo
de leitura puro usado para escolher a ocorrência atual e descrever seu estado.

`recurrence-matching.ts`, `recurrence-detection.ts` e
`recurrence-schedule.ts` são detalhes internos do módulo. Rotas e outros
módulos de produto não importam esses arquivos; chamam server functions ou o
modelo de leitura.

## Regras de dependência

- Adaptadores de arquivo dependem do formato, não do fluxo de commit.
- Funções puras de domínio não dependem do banco ou da interface.
- Módulos de persistência recebem a transação ativa quando a atomicidade faz
  parte da regra.
- Rotas chamam server functions e read models; não montam regras financeiras.
- Evidência importada nunca substitui silenciosamente um lançamento canônico.

As garantias financeiras e decisões de continuidade permanecem normativas no
[ADR 001](./adrs/001-import-continuity-and-reconciliation.md).
