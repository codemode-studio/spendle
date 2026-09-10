# Exclusão da Inter Global do caixa acompanhado

08/09/2026. Alteração de dados autorizada pelo usuário.

Inter Global desativada sem apagar importações ou lançamentos. Seis créditos na Inter PJ, com reconciliação FX confirmada contra a Global, receberam `profit_distribution_income`. Uma sugestão rejeitada ficou de fora. Decisões registradas por `learnCategory`; nenhum prefixo criado.

Backup anterior registrado em `data/backups/antes-remover-global-20260908-191023.db`. Operação validada primeiro em cópia temporária e depois no principal. Comparações confirmaram fatos importados, reconciliações nas duas pontas, checkpoints e orçamentos preservados.

Conferência de setembro, em centavos: inicial 878857; entradas 6109336; saídas 2142623; caixa 4845570. Diferença zero. Navegador principal usado somente para leitura após a alteração.

QA sintética `.qa/run-Mwi0z9`, porta 3117: conta ativa visível e arquivada ausente em 1280 × 800 e 390 × 844, sem rolagem horizontal. Conta arquivada preparada por SQL, sem mutação pelo navegador.

`pnpm setup:check` e `pnpm verify` passaram: 480 testes aprovados, 10 pulados. Servidor QA encerrado.
