# Migração de categorias e padrões de conhecimento

Entrega concluída em 05/09/2026. Registro histórico, não uma tarefa para reaplicar no banco.

## Categorias

A migração [0035](../drizzle/0035_reclassify_food_categories.sql) substituiu Alimentação por Mercado e Restaurantes nos estabelecimentos aprovados. Delivery permaneceu. Alimentação ficou inativa para preservar referências históricas.

A lista executada está no SQL. Ela distingue supermercados, restaurantes, delivery e Mercado Livre; estabelecimentos ambíguos receberam decisões explícitas. A atualização inclui lançamentos, lotes ligados à evidência, parcelas, splits, categorias anteriores de vínculos e conhecimento, para que desfazer um vínculo não restaure a categoria antiga. Recorrência Mercado e ocorrências passaram para `groceries`.

A base preservou origem, contadores e datas nas reclassificações e removeu a entrada genérica `em conta`, por decisão explícita.

Prévia disponível em [preview-food-reclassification.ts](../scripts/preview-food-reclassification.ts). Não demonstra o estado atual de uma migração já aplicada.

## Padrões de conhecimento

As migrações `0036` e `0037` adicionaram `pattern` e `match_mode`, com chave por tipo, padrão, modo e direção.

- Categorias aceitam `exact` e `prefix`; recorrências mantêm assinatura completa.
- `knowledgePattern` remove sufixo de parcela e processadores de uma lista fechada. Não remove números ou fragmentos genericamente.
- Prefixos aprovados: `ifd` para Delivery; `mercadolivre`, `shopee`, `mp` e `nuv` para Compras. Amazon, Uber e 99 ficaram fora.
- Exata vence prefixo. Exatas da mesma categoria cobertas por prefixo são absorvidas; categorias diferentes permanecem exceções.
- Prefixos novos exigem decisão humana. Derivar um padrão não cria um prefixo.
- Regras explícitas, transferências e políticas de destino prevalecem na importação. Conhecimento exato usa confiança 98; prefixo mais longo, 92.

As migrações dependem das funções SQL registradas em `connection.server.ts` e rodam pelo inicializador da aplicação. O CLI de migração do Drizzle não registra essas funções.

## Registro da execução

O relato original registrou aplicação da `0035` ao banco real e implementação da `0036` em 05/09/2026. Caminhos locais registrados:

- Estado anterior disponível: `data/financas-before-mercado-link-2026-09-03.db`.
- Snapshot após `0035`: `data/financas-after-0035-2026-09-05.db`.
- Backup anterior à `0036`: `data/financas-before-0036-2026-09-05.db`.

A existência e a integridade desses arquivos não foram verificadas nesta revisão documental. As regras vigentes de aprendizado e sincronização estão em [arquitetura](architecture.md#base-de-conhecimento).
