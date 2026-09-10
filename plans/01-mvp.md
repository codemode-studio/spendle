# Escopo local

## Entregue

- Visão geral de caixa mensal, categorias e previsão com simulação de 30, 60 e 90 dias.
- Contas PF/PJ, cartões, transações e importação. Orçamento, metas e recorrências em Configurações; a rota antiga de Planejamento redireciona para essas seções.
- SQLite/Drizzle, migrações e contas por finalidade. Investimentos e cripto podem ser acompanhados por contas e saldos manuais.
- OFX/CSV determinísticos e extração local de PDF. Revisão por lote, originais por SHA-256, evidência por página e reconciliação de saldo/fatura.
- Sugestões reversíveis de transferência, distribuição de lucro, câmbio, pagamento de cartão e estorno.
- Estratégias Equilibrada, Patrimonial, Agressiva e Independência, renda-base conservadora, reserva e objetivos com aportes.
- Ciclos de cartão, limites, faturas e parcelas futuras. Detecção de parcelas em descrições como `02/10`.
- Recorrências com ocorrências, vínculos e envelopes. Base de conhecimento de decisões humanas, com prévia de sincronização.
- Assistente opcional, condicionado à configuração e ao consentimento.

## Critérios de aceite

- Funciona localmente sem chave de IA.
- Divergência de saldo bloqueia a consolidação. Importação sem checkpoint pode exigir revisão manual e confirmação do período; não passa a ter saldo verificado. Ver [ADR 001](adrs/001-import-continuity-and-reconciliation.md).
- Transferências e pagamentos de cartão preservam as duas pontas e não duplicam despesas. Aportes são movimentos patrimoniais.
- Faturamento PJ não entra na renda-base familiar. A classificação e o escopo determinam a elegibilidade de distribuições.
- Meses fechados preservam estratégia e percentuais efetivos.
- `pnpm verify` executa tipos, lint, testes e build. Cobertura de navegador e testes privados constam nos [relatos de QA](../docs/README.md).
