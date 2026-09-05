# Plano: categorias de comida e base de conhecimento por padrão

Status: Entrega 1 implementada e aplicada ao banco real em 2026-09-05 (migração `0035`, aplicada pelo servidor de desenvolvimento em execução; snapshot pós-migração em `data/financas-after-0035-2026-09-05.db`, último estado anterior em `data/financas-before-mercado-link-2026-09-03.db`). Entrega 2 implementada em 2026-09-05 (migração `0036`, backup anterior em `data/financas-before-0036-2026-09-05.db`).

## Situação atual (banco real, 2026-09-05)

| Categoria   | Lançamentos | Total       | Estabelecimentos | Observação                                                                                             |
| ----------- | ----------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| Alimentação | 87          | R$ 22,5 mil | 38               | 50 são mercado (Angeloni, Imperatriz, Festval, Assaí, Koch). 8 são Mercado Livre. 14 são restaurantes. |
| Delivery    | 27          | R$ 2,9 mil  | 21               | Tudo `ifd*`, Zé Delivery e P2 Delivery. Já consistente.                                                |
| Lazer       | 77          | R$ 12,2 mil | 53               | Cerca de 30 estabelecimentos são cafés, bares, restaurantes e padarias.                                |

Alimentação é referenciada por 1 recorrência (Mercado, envelope), 4 ocorrências, 12 planos de parcelas, 142 linhas de lote e 2 entradas da base de conhecimento. Nenhuma regra de categorização.

## Entrega 1: categorias e reclassificação

### 1.1 Categorias

- Criar `groceries` **Mercado** (bucket `essential`, cor de Alimentação) e `restaurants` **Restaurantes** (`lifestyle`).
- Manter `delivery` **Delivery** (`lifestyle`).
- **Alimentação fica inativa, não é apagada.** Só os estabelecimentos listados em 1.2 mudam. O que sobrar em Alimentação aparece na prévia para decisão manual; a exclusão da categoria vira uma migração futura, quando não houver referência (padrão da 0029).
- Seeds de produção e QA, ids de teste e heurística em `categories.server.ts`, nesta ordem:
  - Delivery: `^ifd\*|ifood|99food|rappi|ze delivery|delivery`
  - Mercado: `\bmercado\b|supermercado|atacad|acougue|hortifruti|emporio` (palavra isolada, para `mercadolivre` não cair aqui)
  - Restaurantes: `restaurante|\bbar\b|boteco|hamburg|pizzaria|sushi|\bcafe\b|cafeteria|coffee|bakery|padaria|grill|brasa|churrasc|doces|sorvete|crepe|bistro|lanch|confeitaria`

### 1.2 Reclassificação (migração de dados `0035`)

Listas explícitas por estabelecimento, derivadas da busca por descrição normalizada no banco real. Para cada lançamento afetado a migração atualiza, no mesmo statement lógico, `transactions`, `staged_transactions` ligadas por `transaction_evidence`, `installment_plans`, `transaction_splits` e os `previous_category_id` de `recurrence_matches` e `reconciliation_links`, para que desvincular ou reverter não restaure Alimentação.

- **Mercado**: Angeloni (duas grafias), Supermercados Imperatriz, Festval, Assaí, Koch, Açougue Gimenis. Recorrência Mercado e suas ocorrências passam para `groceries`.
- **Compras**: as 8 compras Mercado Livre em Alimentação, alinhadas ao que a base já aprendeu.
- **Delivery**: sem mudança.
- **Restaurantes**, saindo de Alimentação: Batel Grill, Restaurante Kharina, Braz Sushi, Nyx Bar, Ponto Restaurante, Casagrande, Bier Hoff, Nice Restaurante, Pauli Doces, La Crepioca, Cia do Sorvete, Famd Pizzaria, Mr Cheney.
- **Restaurantes**, saindo de Lazer: Cafe Cultura, Nkmb Coffee, O Original na Brasa, Kontainer Beer, Flor de Brasa, Oliva Cheese Bar, B2RM Bar, Jurerê On Cafeteria, Noma Jurerê, Carbone Pizzaria, Alimentare Baldovino, Saint Claire Bakery, Prestinaria, Ivasp, Breadbox, Grife de Boteco, Fronteira Hamburg, R2 Bar, Better Comércio de Alimentos, Benvenuta Bar, Santocrepe, Htm Besties em Flor, Brasil Berry.
- **Ficam em Lazer**: patinetes Whoosh, Aquamagic, Vale Aurora, Cosmo Beach Club, Scuna Lady Manoela, Ingresso.com, Cinemark, entretenimento infantil, eventos, academias.
- **Decididos em 2026-09-05**: Cacau Show, Lindt, Barra Beach, Bunker22, Green Island e Tio Zico vão para Restaurantes; Easy Food para Delivery; Rede Pratique é academia e fica em Lazer; Lovea Express vai para Cuidados pessoais. Padaria e cafeteria contam como Restaurantes. "V A C U N O Sapiens" vai para Restaurantes.

Prévia: script imprime cada lançamento com categoria antiga, nova, referências dependentes e impacto por mês e bucket. A migração só roda depois da aprovação e com backup consistente (`VACUUM INTO`, que respeita WAL).

### 1.3 Base de conhecimento após a reclassificação

A `0035` reescreve `category_id` das entradas exatas cujos estabelecimentos foram reclassificados, preservando origem, contadores e datas. Não cria padrões (a coluna só existe na Entrega 2). Remove a entrada genérica `em conta` (Débito em conta), decisão explícita desta migração.

## Entrega 2: base de conhecimento por padrão

- **Schema**: colunas `pattern` e `match_mode` (`exact` ou `prefix`). Chave única `(kind, pattern, match_mode, direction)`. **Prefixo só para `kind = 'category'`**; recorrências continuam exatas, sem mudança em `learnRecurrence`, `forgetRecurrence` e `loadRecurrenceKnowledge`.
- **Derivação** em função pura `knowledgePattern(description)`, separada de `merchantSignature`. Só três transformações, todas com regex explícita e testes positivos e negativos:
  1. Remove sufixo de parcela: `parcela \d+ de \d+` e `parcela \d+/\d+`.
  2. Remove prefixo de processador de pagamento da lista fechada `pg`, `mp`, `stb`, `nuv`, `payu`, `vindi`, `zp`, `htm`, `pag`, quando seguido de outro token.
  3. Agregador de lista fechada vira prefixo: `ifd`, `mercadolivre`, `shopee`, `mp` (Mercado Pago) e `nuv` (Nuvemshop). Amazon, Uber e 99 ficam de fora por cobrirem serviços distintos.
  4. Entradas exatas da mesma categoria já cobertas por um prefixo são redundantes: somam confirmações ao prefixo e deixam de existir (migração `0037`, e daí em diante ao aprender ou ao editar um prefixo). Uma categoria diferente continua como exceção exata.
     Nada de remoção genérica de números, códigos de loja ou fragmentos truncados.
- **Sem fusão automática.** Entradas de prefixo nascem apenas de decisão explícita: a lista aprovada no backfill ou edição na aba Conhecimento. Entradas exatas convivem com o prefixo e vencem.
- **Aplicação na importação**: regras, transferências e políticas de sistema continuam na frente. Depois: exata (confiança 98), prefixo mais longo (92), heurística. Leitura em lote: `IN` para exatas e as entradas de prefixo carregadas inteiras em memória (poucas dezenas).
- **Aba Conhecimento**: coluna com padrão e modo, edição do texto do padrão com validação (normalizado, mínimo 3 caracteres, uma letra) e tratamento de colisão com mensagem clara. Invalidação continua no grupo `knowledgeBase`.
- **Backfill `0036`**: recalcula `pattern` de cada entrada como `exact`. Onde entradas exatas de mesma categoria colapsam no mesmo padrão pela regra 1 (parcelas), funde: confirmações somadas, correções máximas, data e origem da mais recente. Onde categorias divergem, mantém as exatas. Cria os prefixos aprovados: `ifd` para Delivery, `mercadolivre` e `shopee` para Compras.

## Verificação

Cada entrega: teste de migração em fixture (colisões, exceções exatas, receita separada de despesa, recorrências intactas, restauração de categoria ao desvincular, parcelas, reimportação do mesmo arquivo), `pnpm verify`, e QA no navegador com dados sintéticos em Categorias, Transações, Importar e Configurações. Invariantes de centavos, diferença zero, duas pontas de transferência e orçamentos fechados cobertos pelos testes existentes.

## Decisões em aberto

1. Respondido: sim.
2. Respondido: ver 1.2.
3. Respondido: sim, buckets como proposto.
4. Respondido: Alimentação fica inativa.
