# QA das três refatorações de arquitetura

09/09/2026. Base `fef0d59` com alterações locais. Refatorações da leitura de Categorias, resolução de conhecimento e caixa mensal, preservando resultados financeiros.

## Validação automatizada

- `pnpm setup:check` passou com banco, migrações e PDF sintéticos.
- `pnpm verify` passou: tipos, lint, 78 arquivos de teste e build.
  Foram 491 testes aprovados.
- Dez testes em dois arquivos ficaram ignorados por dependerem de fixtures
  privadas ou IA ao vivo: `pdf-real-fixtures.integration.test.ts` e
  `audit-private-statements.test.ts`. Não foram usados dados financeiros locais.
- Testes do caixa exercitam fatos financeiros, transferências próprias nas duas
  pontas, pendência vinculada à ocorrência, reconstrução histórica, câmbio direto
  e inverso, conversão ausente, meses futuros e imutabilidade dos argumentos.
- Testes de conhecimento comparam preparação do lote e prévia de sincronização,
  incluindo exato/prefixo, prefixos concorrentes, direção, Pix e parcelas.
  As regras explícitas do lote e as proteções da sincronização permanecem distintas.
  Aplicar a sincronização não altera observações do lote nem aprende novas decisões.
- Teste da leitura de Categorias compara os resultados e sua ordem com
  `familyTransactions(await getFinanceSnapshot())`, preservando valores em
  centavos, estornos, câmbio, lançamentos excluídos e as duas pontas de transferências.
  Afirma três consultas e ausência de leituras de orçamento, importações e projeções.
- As verificações existentes de importação e alocações fechadas continuam passando.

## Benchmark

Execução única com 4.000 lançamentos sintéticos. Tempos são observações locais,
não uma estimativa estável de ganho de latência.

| Leitura de categorias  | Consultas |    Tempo |        Resposta |
| ---------------------- | --------: | -------: | --------------: |
| Pelo snapshot completo |        28 | 18,05 ms | 1.018.891 bytes |
| Leitura dedicada       |         3 | 16,73 ms | 1.018.891 bytes |

Histórico de 3 e 12 meses manteve 28 consultas em ambos os casos.
O benchmark agora inclui as duas leituras de categorias para comparação.

## Navegador integrado

O navegador de CUA estava indisponível. Foi usado o navegador integrado de preview,
com desktop de 1280 × 800 e celular de 390 × 844. Uploads passaram pelo input de
arquivos da página, com o conteúdo exato dos OFX sintéticos de cada execução.
Nenhuma mutação de QA foi substituída por uma escrita direta no banco.

Execução principal:
`http://127.0.0.1:3100`, diretório `.qa/run-yGBQqM`.

| Fluxo                                                   | Esperado e observado                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Preparar balanced.ofx                                   | Dois movimentos, +R$ 1.000,00 e -R$ 100,00, líquido R$ 900,00 e diferença zero                |
| Escolher Moradia na revisão e consolidar                | Dois lançamentos persistidos, Mercado QA em Moradia                                           |
| Reenviar o arquivo idêntico                             | Continuam dois lançamentos, sem novo lote consolidado                                         |
| Criar manualmente Mercado QA de R$ 10,00, sem categoria | Terceiro lançamento confirmado de -R$ 10,00                                                   |
| Sincronizar com a base                                  | Prévia de uma alteração, Sem categoria → Moradia; aplicação confirma uma alteração            |
| Reabrir Transações                                      | Três lançamentos; as duas despesas continuam em Moradia                                       |
| Categorias                                              | Duas despesas, R$ 110,00 e 100% em Moradia                                                    |
| Home e Contas                                           | Caixa/saldo R$ 890,00; entradas R$ 1.000,00, saídas R$ 110,00                                 |
| Planejamento                                            | Redireciona para Orçamento; base R$ 60.000,00, alocação 40/20/30/10 e pendência de fechamento |

Execução divergente:
`http://127.0.0.1:3101`, diretório `.qa/run-Rb8LaY`.

`unbalanced.ofx` mostrou diferença de R$ 99,00, explicação da divergência e
Consolidar desabilitado em desktop e celular. `qa:inspect` confirmou zero
transações, lote em revisão com validação divergente e nenhuma violação de FK.

## Observações visuais fora do escopo

A validação funcional passou. A apresentação móvel não recebeu aprovação integral:

- Em Transações, os cabeçalhos Descrição e Origem se sobrepõem a 390 px;
  descrição e valor dos lançamentos não ficam visíveis no recorte inicial.
- Em Categorias, o seletor de período ultrapassa a largura disponível e há
  rolagem horizontal.

Esses pontos foram registrados sem alterar apresentação ou comportamento.
Os arquivos de tela e CSS correspondentes não foram modificados nesta refatoração.
Não foi feita uma reprodução em checkout anterior para atribuir a origem.

O preview registrou erros de inicialização do sandbox do Electron e alguns comandos
de clique não acionaram a página. Os passos foram repetidos por eventos DOM no
navegador e confirmados pela prévia, notificações e persistência; não por chamadas
diretas às funções financeiras.

Capturas inspecionadas no ambiente local. Servidores encerrados e dados sintéticos removidos após o registro.
