# Documentação

- [Execução e comandos](../README.md)
- [Escopo e arquitetura](../plans/README.md)
- [Procedimento de QA](../.agents/skills/browser-qa/SKILL.md)

## Registros de QA

Os relatos abaixo registram verificações feitas em setembro de 2026. Não descrevem necessariamente a interface atual nem substituem uma nova execução. Identificadores `.qa/run-*` servem para rastrear os relatos; os ambientes são temporários.

| Área                          | Registro                                                |
| ----------------------------- | ------------------------------------------------------- |
| Previsão e simulação          | [Previsão e recuperação](qa/forecast-recovery.md)       |
| Caixa mensal                  | [Fluxo de caixa](qa/monthly-cash-flow.md)               |
| Seleção de mês                | [Estrutura estável](qa/monthly-layout-consistency.md)   |
| Gráficos e assistente         | [Visão mensal](qa/monthly-visual-overview.md)           |
| Painel de atividade           | [Cabeçalho](qa/activity-header.md)                      |
| Recorrências                  | [Filtro de categoria](qa/recurrence-category-filter.md) |
| Paginação e filtros           | [Estado na URL](qa/transaction-url-state.md)            |
| Tema Cristal                  | [Exploração visual](qa/light-glass-exploration.md)      |
| Alteração de dados autorizada | [Inter Global](qa/inter-global-excluded.md)             |

Histórico de interfaces substituídas: [simplificação inicial](qa/simple-family-finance.md) e [revisões da visão mensal](qa/monthly-family-overview.md).

Refatorações de leitura e cálculo: [QA de arquitetura](qa/architecture-deepening.md).

## Cobertura pendente registrada

- Refatorações de arquitetura: relato registra sobreposição de cabeçalhos em Transações e rolagem horizontal em Categorias a 390 px. Origem não atribuída.
- Estado de Transações na URL: sem verificação no navegador; somente testes e HTTP/SSR.
- Tema Cristal fixo e ajustes posteriores de contraste: sem inspeção visual final. A inspeção anterior cobriu o seletor de temas, já removido.
- Simulação de caixa: teclado não confirmado no navegador.

As limitações específicas e os testes privados ou externos não executados constam em cada relato. Esta revisão documental não refez os fluxos de QA.
