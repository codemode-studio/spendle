# ADR 003: backend V2 em Effect

Decisão de 04/10/2026, implementada por PRs empilhados. O V1 foi aposentado em 05/10/2026 (fase 10).

## Problema

Um assistente financeiro só é útil se os dados forem exatos. O backend V1 cresceu em módulos que recalculam tudo de forma síncrona: cerca de 20 pontos reexecutam reconciliação e recorrências sobre todas as transações dentro da requisição. Importação, sincronização com a Pluggy e fechamento de mês encadeiam etapas sem registro durável do que falta. Transações vindas da Pluggy não usam a base de conhecimento. A separação entre decisão humana e inferência depende só de convenção.

## Decisão

Um backend novo em `packages/server`, escrito em Effect 4 com `effect/sql` sobre `node:sqlite` (`@effect/sql-sqlite-node`), com banco próprio em `data/v2/`. O V1 funcionou até a troca e foi aposentado na fase 10. Não há migração de esquema do V1; dados do V1 entram depois por importação explícita de decisões humanas e reprocessamento das fontes.

O foco inicial é Open Finance e importação manual, com reconciliação como diferencial do produto.

## Modelo

| Camada    | Conteúdo                                                                                   | Regra                                       |
| --------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Fatos     | Observações de banco e arquivo: transações, saldos, faturas, com payload e proveniência    | Imutáveis; uma alteração é nova versão      |
| Decisões  | Escolhas da pessoa: categoria, vínculo confirmado ou rejeitado, correção, exclusão         | Duráveis; só a pessoa cria ou desfaz        |
| Projeções | Lançamentos canônicos, vínculos sugeridos, categorias inferidas, cobertura, prova de saldo | Reconstruíveis a partir de fatos e decisões |

Um registro de eventos de domínio dispara reatores (resolução, conciliação, categorização, verificação de saldo) em filas drenáveis. Melhorar um algoritmo significa reprocessar o histórico, não migrar dados à mão.

## Reconciliação

- **Resolução de entidades:** a mesma movimentação vista pela Pluggy e por um OFX vira um lançamento só, com as duas observações como evidência. Pendente que vira postada atualiza o mesmo lançamento.
- **Prova de saldo:** `saldo(t1) = saldo(t0) + movimentos postados em (t0, t1]` entre checkpoints compatíveis. Diferença diferente de zero é uma lacuna visível com ação sugerida, nunca liberada por confirmação.
- **Vínculos:** transferência entre contas da mesma pessoa, pagamento de fatura (débito na conta ↔ crédito no cartão e ciclo quitado), estorno, parcelamento e aplicação/resgate. Cada vínculo tem as duas pontas, pontuação e evidência; é sugerido, confirmado automaticamente quando inequívoco ou pela pessoa, e uma rejeição nunca é sugerida de novo.

## Aprendizado de categorias

Duas camadas, para que uma inferência errada nunca sobrescreva o que a pessoa disse:

1. **Decisões:** o equivalente à `knowledge_base`, escrita só por decisão explícita, por um único módulo.
2. **Inferências:** cada sugestão guarda origem (regra, memória de comerciante, modelo), versão e confiança. Acima do limiar avaliado, é aplicada e pode ser desfeita; abaixo, vai para revisão. Confirmar ou corrigir cria uma decisão.

O classificador por modelo usa escolha tipada com probabilidade (avaliar TypeSafe/Jev contra os dados reais antes de adotar).

## PRs empilhados

1. Fundação: pacote, runtime, configuração, SQLite e migrações, testes, documentação para agentes
2. Registro de eventos e reatores drenáveis
3. Núcleo do razão: titulares, instituições, contas e cartões, fontes, observações imutáveis de transações e saldos
4. Ingestão Pluggy: conexão, contas, sincronização com janela de 90 dias, saldos
5. Webhooks Pluggy: endpoint autenticado, caixa de entrada idempotente, reator de sincronização, registro na Pluggy e exposição pública só desse caminho
6. Importação manual: OFX e CSV, depois PDF
7. Lançamentos canônicos: resolução de entidades e prova de saldo entre checkpoints
8. Reconciliação: transferências, faturas, estornos, parcelamentos
9. Aprendizado de categorias
10. API para o app web e troca do V1 (concluída: todas as telas usam a API V2 e o código, o banco e as dependências do V1 foram removidos de `src/`. `migrate-v1` continua lendo um arquivo SQLite do V1, com o esquema congelado em `packages/server/src/v1import/fixtures/v1-schema.sql` para os testes)

## Em aberto

- Autenticação: o app não tem contas. A API V2 escuta só em `127.0.0.1` e aceita um token Bearer opcional (`SPENDLE_API_TOKEN`) para outra máquina da rede local; contas de usuário ficam para quando ela sair da rede local. O webhook da Pluggy é a única rota pública e se autentica pelo segredo próprio.
- Equivalência com o V1: `migrate-v1` ([README do servidor](../../packages/server/README.md#migração-do-v1)) traz configuração, base de conhecimento e decisões humanas, e as fontes são reprocessadas. Falta comparar, com os dados reais, as categorias e os vínculos do V2 com os do V1 depois da reimportação.
