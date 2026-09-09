# Visão mensal com gráficos e análise do assistente

Verificação em 08/09/2026 no checkout local, com alterações anteriores preservadas.

- URL sintética: http://127.0.0.1:3117.
- Banco e arquivos isolados: `.qa/run-XnY9nZ`.
- `pnpm setup:check`: passou.
- Pelo navegador integrado, criei a saída manual `Teste gráfico setembro`, R$ 10,00, categoria Mercado, na conta sintética. A lista mostrou -R$ 10,00 e a visão geral atualizou o caixa para -R$ 10,00, essenciais para R$ 10,00 e saídas realizadas para R$ 10,00. Não há pagamentos pendentes desse lançamento já pago.
- Setembro selecionado por padrão. Cabeçalho mostra Caixa atual; saudação e resumo com ícone removidos. Botão Previsão abre a tela com esse título.
- Verificação em 1280×800 e 390×844. Sem overflow horizontal em 390 px. Análise do assistente sem borda/fundo/card próprio. Textos Soma dos saldos e Detalhes dos cálculos ausentes.
- Click do conector retornou erro de automação. Interações seguiram pelo DOM da página com preview_evaluate, incluindo preenchimento do formulário, seleção da categoria e envio. Nenhuma mutation foi substituída por SQL.
- Console apresentou erros do preload do Electron ao abrir o navegador, antes das interações; não foram erros da aplicação.

Testes focados cobrem limites históricos, preservação dos centavos, excesso individual sem compensar com outro grupo, barras e anéis, previsão após metas, consentimento para IA, briefing agregado do mês solicitado, ausência de chamadas quando desativada e isolamento de respostas atrasadas entre meses. Chamadas reais ao provedor de IA não foram exercidas no QA, onde IA é desativada. Testes do assistente usam provedor simulado.

O gráfico usa escala monetária comum e linha zero; caixas negativos ficam abaixo dela. Os indicadores de excesso de despesas são independentes do saldo final. A IA recebe agregados em centavos lidos no servidor, sem descrições de lançamentos, e o cache distingue mês e números apresentados.

`pnpm bench`: histórico de 12 meses com 28 consultas e 16.343 bytes; nenhum novo cálculo de banco foi introduzido nos gráficos. Os lançamentos, importações e dados financeiros principais não foram alterados por este trabalho.

Atualização final: removido também o rótulo visível do assistente, mantendo o nome acessível da seção. Após reload no navegador, setembro voltou selecionado e os R$ 10,00 persistiram. A diretriz de UI autoexplicativa foi registrada no AGENTS.md.

Validação final: `pnpm verify` passou, com typecheck, lint, 480 testes aprovados e build. Dez testes de fixtures privadas/condicionais permaneceram pulados. Run sintético encerrado e removido com `pnpm qa:clean`.

Legenda simplificada para Caixa final. Verificada em 1280×800 e 390×844 no navegador integrado, URL 3117, run sintético `.qa/run-lraQx1`: novo texto presente, antigo ausente, sem overflow móvel. `pnpm setup:check` e `pnpm verify` passaram.
