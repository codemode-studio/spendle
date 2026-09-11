# Assistente no fechamento mensal

Verificado em 2026-09-11, checkout principal sobre `cd29861`, com alterações locais.

- URL isolada: http://127.0.0.1:3100
- Diretório sintético: `.qa/run-34sjp7`.
- `pnpm setup:check`: aprovado.
- `pnpm verify`: aprovado, 81 arquivos e 502 testes. Dez testes em dois arquivos de fixtures privadas/IA externa foram ignorados.
- `pnpm bench`: aprovado. Snapshot com 4 mil linhas: 28 leituras; histórico de 3 e 12 meses: 28 leituras cada.

Os testes do assistente usam banco isolado e provedor simulado. Cobrem bloqueio por consentimento, ausência de geração para mês aberto, geração no fechamento, fechamento preservado quando o provedor falha, retry, persistência, deduplicação simultânea, conhecimento humano e buckets essenciais no briefing, base inalterada, histórico do chat e plano anterior, cálculo em centavos, rejeição de limites acima do gasto e de categorias duplicadas.

No navegador integrado, a página inicial e o assistente abriram em desktop 1280 × 800 e celular 390 × 844. Em celular, a versão final mostrou o cabeçalho, orientação para fechamento, campo de conversa e estado desabilitado sem botão de análise quinzenal ou avisos automáticos no histórico. Sem erros de console nessa captura. Imagem: `/Users/donaldsilveira/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mtxax70b-a7fd9b97.png`.

Verificação visual parcial: as últimas capturas de desktop falharam com `PreviewAutomationExecutionError`, inclusive em uma nova aba. O relatório preenchido, envio ao provedor e recuperação de erro não foram exercitados no navegador, porque o QA desabilita IA. Os testes de servidor/componentes constituem evidência separada, não validação visual desses estados. Não houve chamadas reais à IA nem uso de dados financeiros locais.

## Primeira análise

Ajuste posterior: sem mês fechado, o assistente gera e persiste uma primeira análise, identificada como tal. O briefing informa que o mês pode estar incompleto. O chat recebe essa análise como contexto até existir um relatório mensal. A limpeza dos dados financeiros remove também essa primeira análise.

`pnpm setup:check` e `pnpm verify` aprovados. Os testes adicionais verificam criação sem fechamento, persistência, deduplicação, prioridade do fechamento mensal, consentimento e recuperação após falha do provedor. Nova tentativa de navegador em `http://127.0.0.1:3100`, run `.qa/run-Cybhdg`, falhou com `PreviewAutomationTimeoutError`; verificação visual deste ajuste pendente. Nenhuma chamada real à IA.

## Recuperação da primeira análise

Após relato de falha na tela, a chamada real do assistente concluiu em 23,3 segundos e salvou a primeira análise. Uma segunda leitura retornou o resultado salvo em 24 ms. Não foi possível determinar a causa da falha anterior pelos logs disponíveis. A interface agora faz uma nova tentativa automática e não mistura o erro com mensagens de apresentação ou sugestões de conversa vazia.

`pnpm setup:check` e `pnpm verify` aprovados, 504 testes e 10 ignorados. QA isolado `.qa/run-6Oqlha`, URL http://127.0.0.1:3100: captura do navegador falhou novamente com `PreviewAutomationTimeoutError`. Verificação visual pendente; a confirmação do relatório salvo veio da chamada ao servidor.

## Plano visual

A apresentação agora prioriza economia mensal proposta, limites por ação, economia e barra comparativa. O total usa diferenças em centavos entre referência e limite. Justificativas ficam em detalhes nativos acessíveis por teclado; resumo e achados ficam em Pontos de atenção. A nota de saúde saiu da interface. Relatórios já salvos recebem a apresentação sem nova chamada à IA.

`pnpm verify` aprovado, 504 testes e 10 ignorados. QA isolado `.qa/run-4EVPSR`, http://127.0.0.1:3100: a captura inicial da página funcionou, mas clique e avaliação falharam no cliente do navegador. Não foi possível verificar o relatório preenchido em desktop/celular. Não considerar a captura da página inicial uma aprovação visual do componente.

## Densidade do plano

Reduzidos espaçamento entre ações, tipografia dos valores e altura das barras. Rótulos e valores ficam alinhados, com quebra quando necessário. O título da ação é o controle nativo de detalhes, eliminando a linha separada Como fazer. Alvo de toque preservado em 44 px para ponteiro coarse.

`pnpm verify` aprovado: 504 testes, 10 ignorados. QA `.qa/run-PfCKhb`, http://127.0.0.1:3100: página e abertura do assistente responderam; tentativa de renderizar o componente com fixture sintética falhou no navegador. Relatório preenchido ainda sem conferência visual desktop/mobile.
