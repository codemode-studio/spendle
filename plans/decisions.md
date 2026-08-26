# Decisões

## Produto

- Interface em português; identificadores do código em inglês.
- Um workspace familiar local, sem login no MVP.
- PF e PJ Brasil entram no MVP; empresa dos EUA e tributação ficam no backlog.
- Contas e cartões são conceitos e áreas de navegação separados.

## Financeiro

- Dinheiro é inteiro em centavos; percentuais são basis points e sempre somam 10.000.
- Importação idempotente, cobertura temporal e reconciliação de saldo são
  garantias independentes. A política completa está na
  [`ADR 001`](./adrs/001-import-continuity-and-reconciliation.md).
- A renda-base é o menor valor entre a meta configurada e a média dos três meses fechados anteriores; antes disso usa a meta.
- Faturamento PJ, transferências internas e pagamento de fatura não são renda/despesa familiar.
- Transferências de PJ para PF no escopo atual são distribuições de lucro. As duas pontas são preservadas e a confirmação é manual.
- Cada conta e cartão é um ledger separado. Cartões físicos e virtuais são instrumentos do mesmo ledger de fatura.
- O saldo exibido como verificado precisa fechar exatamente contra um ponto de controle datado; a tolerância é zero.
- Investimentos e cripto são contas normais com finalidade de investimento.
  Transferências internas registram aportes e retiradas; saldos informados
  manualmente são pontos de controle datados da própria conta.
- Meses fechados preservam template, percentuais originais e efetivos.
- Reserva completa redireciona o envelope futuro para investimentos, com reativação manual.
- Objetivos registram alvo, prazo, prioridade e aportes; o app não recomenda ativos nem projeta retorno.

## Tecnologia e segurança

- TanStack Start/Router/Query, TypeScript, pnpm, Drizzle e SQLite.
- shadcn preset `base-nova` sobre Base UI; componentes locais podem ser adaptados sem trocar os primitives.
- Todo banco, arquivo, segredo e chamada a provedor fica em código de servidor.
- Originais ficam em `data/imports/<sha256>`, fora de `public/` e do Git.
- OFX e CSV são fontes estruturadas. PDF usa `@firecrawl/pdf-inspector` para classificação, Markdown e coordenadas; o parser antigo existe somente como comparação diagnóstica.
- Um CSV pode usar o PDF equivalente como controle quando todas as datas, valores, moedas e multiplicidades conferem. Só uma fonte gera transações.
- Originais e extrações são imutáveis. Falhas, divergências e PDFs usados apenas como evidência permanecem auditáveis.
- O provedor de IA só recebe o arquivo após consentimento explícito e nunca torna o lote automaticamente confiável.
- Modelos de IA são acessados pelo OpenRouter usando identificadores `provider/model`; o saldo, roteamento e consumo ficam centralizados nesse serviço.
- Saídas de IA passam por Zod e sempre ficam sujeitas à revisão humana.
