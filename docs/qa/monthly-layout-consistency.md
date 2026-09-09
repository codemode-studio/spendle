# Estrutura estável ao trocar de mês

08/09/2026. O resumo realizado agora sempre apresenta, na mesma ordem, Caixa inicial, Entradas recebidas, Saídas pagas e Caixa. O mês atual acrescenta Previsão do mês abaixo, sem substituir os indicadores realizados.

Teste de componente alterna setembro → agosto → setembro, verifica a mesma ordem de rótulos e mantém A receber/A pagar na seção de previsão. Preserva cálculo de caixa, centavos e metas.

QA em http://127.0.0.1:3117, `.qa/run-Rso1V8`, dados sintéticos preparados via SQL: recebimento em agosto R$ 700,00 e setembro R$ 1.000,00. Navegação real por botões anterior/próximo confirmou o mesmo resumo com os respectivos recebimentos, previsão somente em setembro, e ausência de overflow em 390×844. Desktop conferido em 1280×800. A preparação SQL não foi contada como mutation do navegador. O saldo inicial de agosto está indisponível no fixture, e o texto Sem saldo registrado foi preservado.

`pnpm setup:check`, teste focado e `pnpm verify` passaram. 480 testes aprovados e 10 pulados. Nenhum dado financeiro principal ou fórmula de cálculo foi alterado.
