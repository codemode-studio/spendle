# MVP local

## Entregue

- Dashboard familiar consolidado, Contas, Cartões, Transações, Importar, Planejamento e Configurações.
- Entidades PF/PJ brasileiras, contas por finalidade e cartões em navegação separada.
- SQLite/Drizzle com migrações, invariantes de destino único e seed das contas, cartões e instrumentos conhecidos.
- OFX e CSV determinísticos; PDF classificado e extraído localmente pelo `pdf-inspector` em Markdown e texto posicionado.
- Revisão por lote, originais por SHA-256, evidência por página/coordenadas, duplicidade por arquivo/FITID/fingerprint e commit revalidado.
- Auditoria de saldo inicial + movimentos = saldo final, total de fatura e pontos de controle datados, sempre com tolerância zero.
- Sugestões reversíveis de transferência, distribuição de lucro, câmbio, pagamento de cartão e estorno.
- Contêineres manuais separados para BTG compartilhada, investimentos no Inter e futura visibilidade de cripto.
- Estratégias Equilibrada, Patrimonial, Agressiva e Independência, personalizáveis em basis points, com reativação manual dos aportes à reserva.
- Base conservadora de renda, reserva em meses de essenciais, redirecionamento para investimentos e objetivos com aportes.
- Cartões com ciclo de fechamento/vencimento, fatura atual e próxima, limite comprometido e calendário de faturas.
- Parcelas cadastráveis e detectadas automaticamente em descrições como `02/10`, com projeção das cobranças futuras.
- Recorrências cadastráveis.

## Aceite

- Funciona sem chave de IA em `127.0.0.1`.
- Transferências e pagamentos de cartão confirmados usam categorias excluídas e não duplicam despesas.
- Faturamento PJ não entra no orçamento familiar; distribuição só vira renda quando classificada como renda familiar.
- Transferências para contas de reserva/investimento são aportes, não gastos.
- Meses fechados guardam um snapshot da estratégia e dos percentuais efetivos.
- `pnpm verify` conclui typecheck, lint, testes e build.
- Um lote divergente ou apenas parcialmente verificável não pode ser consolidado por confirmação manual.
