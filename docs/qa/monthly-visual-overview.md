# Gráficos mensais e assistente

08/09/2026. QA sintética `.qa/run-XnY9nZ`, porta 3117; desktop 1280 × 800 e celular 390 × 844.

Pelo formulário, criada despesa Mercado de R$ 10,00. Lista mostrou -R$ 10,00; visão geral mostrou caixa de -R$ 10,00, essenciais e saídas de R$ 10,00, sem pagamento pendente. Recarga preservou o lançamento e selecionou setembro.

Navegador confirmou botão Previsão, gráfico com linha zero, análise do assistente sem card ou rótulo visível próprio e ausência de rolagem horizontal. Após falha do conector de clique, as interações usaram eventos DOM na página. Não houve escrita SQL substituindo o formulário.

Testes cobriram limites históricos, centavos, excesso por grupo, barras e anéis, previsão após metas, consentimento de IA, agregados do mês e isolamento de respostas atrasadas. Provedor de IA simulado; chamadas reais não exercitadas.

`pnpm verify` passou: tipos, lint, build, 480 testes aprovados e 10 privados/condicionais pulados. Benchmark do histórico de 12 meses: 28 consultas e 16.343 bytes. Ambiente encerrado e removido.

A legenda Caixa final foi conferida em outra rodada, `.qa/run-lraQx1`, nas mesmas dimensões, sem rolagem horizontal. `pnpm setup:check` e `pnpm verify` passaram.
