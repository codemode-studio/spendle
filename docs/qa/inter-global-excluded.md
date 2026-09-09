# Inter Global fora do caixa acompanhado

08/09/2026. Autorização explícita do usuário para retirar Inter Global e categorizar seus recebimentos na Inter PJ como distribuição de lucros.

Conta desativada, sem apagar importações ou lançamentos. Seis créditos na PJ com reconciliação FX confirmada contra a Global foram classificados como `profit_distribution_income`. Uma sugestão rejeitada não foi incluída. Decisões explícitas registradas via `learnCategory` em `knowledge-base.server.ts`; nenhuma regra por prefixo foi criada. A lista de contas exibe somente contas ativas.

Backup anterior: `data/backups/antes-remover-global-20260908-191023.db`. Aplicação validada primeiro em cópia temporária e depois no principal. Asserções preservaram IDs, origens, datas, descrições, valores, moedas e status dos lançamentos. Comparação posterior confirmou importações, arquivos, reconciliações, ambos os lados dos vínculos, checkpoints e orçamentos inalterados.

Setembro após a alteração, em centavos:

- Inicial: 878857.
- Entradas: 6109336.
- Saídas: 2142623.
- Caixa atual: 4845570.
- Diferença entre saldo e movimentações: 0.

Browser principal 3000 conferido somente em leitura: caixa R$ 48.455,70 e entradas R$ 61.093,36. QA isolado em 3117, `.qa/run-Mwi0z9`, com conta arquivada sintética criada na preparação do fixture. Conta ativa visível e arquivada ausente em 1280×800 e 390×844, sem overflow móvel. Esta preparação via SQL não foi contada como mutation pelo navegador.

`pnpm setup:check` e `pnpm verify` passaram; 480 testes aprovados, 10 pulados. Nenhuma fórmula financeira foi alterada. Servidor QA encerrado após conferência.
