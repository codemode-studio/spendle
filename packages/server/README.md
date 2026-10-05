# @spendle/server

Backend V2 ([ADR 003](../../plans/adrs/003-backend-v2-effect.md)). Roda separado do app V1, com banco próprio.

```bash
pnpm --filter @spendle/server dev     # http://localhost:4100
pnpm --filter @spendle/server verify  # typecheck, diagnósticos Effect e testes
pnpm --filter @spendle/server qa      # API em memória com dados sintéticos e Pluggy falsa
```

`pnpm qa:start <porta>` na raiz sobe essa API de QA na porta `<porta> + 1200` junto com o app web.

| Variável                                      | Uso                                                          |
| --------------------------------------------- | ------------------------------------------------------------ |
| `SPENDLE_DATABASE_PATH`                       | Banco SQLite; padrão `data/v2/spendle.sqlite`                |
| `SPENDLE_SERVER_PORT`                         | Porta HTTP; padrão `4100`                                    |
| `SPENDLE_SERVER_HOST`                         | Interface; padrão `127.0.0.1` (só esta máquina)              |
| `SPENDLE_API_TOKEN`                           | Token Bearer exigido em `/api/v2`; 32+ caracteres; opcional  |
| `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`    | Credenciais da Pluggy; sem elas, o Open Finance fica inativo |
| `PLUGGY_WEBHOOK_URL`, `PLUGGY_WEBHOOK_SECRET` | Webhook; os dois juntos ou nenhum                            |
| `TYPESAFE_API_KEY`                            | Classificador por modelo; sem ela, o modelo nunca é chamado  |
| `TYPESAFE_MODEL`, `TYPESAFE_API_URL`          | Modelo e endereço; padrão `jev-latest` em `api.typesafe.ai`  |

## Webhook da Pluggy

Sem webhook, a sincronização só acontece quando pedida. Com ele, a Pluggy avisa sobre novas transações, exclusões e mudanças de conexão, e o servidor sincroniza sozinho.

1. Gere um segredo longo: `openssl rand -hex 32`.
2. Exponha publicamente **só** `POST /api/pluggy/webhook`. O resto da API fica na rede local (veja [API](#api-para-o-app-web)). Com Tailscale Funnel, use uma porta própria para não publicar o que já é servido na 443 da tailnet:

   ```bash
   tailscale funnel --bg --https=8443 --set-path /api/pluggy/webhook \
     http://127.0.0.1:4100/api/pluggy/webhook
   ```

3. Defina `PLUGGY_WEBHOOK_URL=https://<máquina>.<tailnet>.ts.net:8443/api/pluggy/webhook` e `PLUGGY_WEBHOOK_SECRET`.
4. Reinicie o servidor. Ele registra o webhook na Pluggy ao iniciar (`Pluggy webhook registered` no log) e passa a URL em cada novo connect token.

Cada entrega exige `Authorization: Bearer <segredo>`, vira um evento com o `eventId` da Pluggy (reentregas não duplicam) e é processada em segundo plano. Para conferir a exposição, uma chamada sem o segredo deve responder `401`:

```bash
curl -i -X POST "$PLUGGY_WEBHOOK_URL" -d '{}'
```

## API para o app web

A API V2 fica em `/api/v2`, definida uma vez em `src/api/definition/` com `HttpApi` do Effect. O app web importa o contrato de `@spendle/server/api` (só depende de `effect`) e deriva um cliente tipado; o documento OpenAPI fica em `GET /api/v2/openapi.json`.

```ts
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { SpendleApi } from '@spendle/server/api'

const client = HttpApiClient.make(SpendleApi, {
  transformClient: HttpClient.mapRequest((request) =>
    request.pipe(
      HttpClientRequest.prependUrl('http://127.0.0.1:4100'),
      HttpClientRequest.bearerToken(token), // só com SPENDLE_API_TOKEN
    ),
  ),
})
// client.entries.list({ query: { accountId, limit: 50 } })
```

**Acesso.** Ainda não há contas de usuário ([ADR 003](../../plans/adrs/003-backend-v2-effect.md)). O servidor escuta só em `127.0.0.1`; para servir outra máquina da rede, defina `SPENDLE_SERVER_HOST` e um `SPENDLE_API_TOKEN` longo (`openssl rand -hex 32`), que passa a ser exigido como `Authorization: Bearer` em toda rota `/api/v2`. `GET /health` responde sem token. Nunca publique a API na internet; o webhook da Pluggy continua sendo a única rota pública.

**Erros.** Toda falha tem o corpo `{ _tag, reason, detail }`. `_tag` define o status; `reason` é um código estável para o app decidir o que mostrar; `detail` diz a qual registro ou valor se refere, ou é `null`.

| `_tag`           | Status | Exemplos de `reason`                                                        |
| ---------------- | ------ | --------------------------------------------------------------------------- |
| `InvalidRequest` | 400    | `invalid_payload`, `invalid_query`, `invalid_cursor`, `card_terms_required` |
| `Unauthorized`   | 401    | `invalid_token`                                                             |
| `NotFound`       | 404    | `account_not_found`, `entry_not_found`, `connection_not_found`              |
| `Conflict`       | 409    | `already_linked`, `connection_disconnected`, `linked_to_provider`           |
| `Rejected`       | 422    | `running_balance_mismatch`, `not_a_pair`, `category_not_assignable`         |
| `InternalError`  | 500    | `internal` (a causa fica no log do servidor)                                |
| `ProviderFailed` | 502    | `pluggy_unavailable`, `pluggy_unauthorized`                                 |
| `Unavailable`    | 503    | `pluggy_not_configured`, `database_unavailable`                             |

**Rotas.**

| Área          | Rotas                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Titulares     | `GET/POST /owners`                                                                                                                                                                                                                                                                                                                                                 |
| Contas        | `GET /accounts` (`includeArchived`), `GET/PATCH /accounts/:id`, `POST /accounts`, `PUT /accounts/:id/card-terms`, `POST /accounts/:id/archive`, `POST /accounts/:id/restore`                                                                                                                                                                                       |
| Open Finance  | `POST /open-finance/connect-token`, `GET /open-finance/connections[/:id]`, `POST …/:id/reconnect-token`, `POST …/:id/item`, `POST …/:id/refresh`, `GET …/:id/accounts`, `POST …/:id/sync`, `DELETE …/:id`, `PUT/DELETE /open-finance/provider-accounts/:id/link`                                                                                                   |
| Importação    | `POST /imports/preview` e `POST /imports` (`multipart/form-data` com `accountId` e `file`), `GET /imports` (`accountId`)                                                                                                                                                                                                                                           |
| Lançamentos   | `GET /entries` (`accountId`, `from`, `to`, `status`, `categoryId`, `categoryStatus`, `text` (descrição ou nota), `direction`, `minAmountCents`, `maxAmountCents`, `limit`, `cursor`), `GET /entries/:id`, `GET /accounts/:id/balance-proof`                                                                                                                        |
| Conciliação   | `GET /reconciliation/relations` (`status`, `kind`, `accountId`), `POST /reconciliation/decisions`, `POST /reconciliation/links`, `GET /reconciliation/orphaned-decisions`                                                                                                                                                                                          |
| Cartões       | `GET /cards/:id/cycles`, `GET /cards/:id/installments`                                                                                                                                                                                                                                                                                                             |
| Digitados     | `POST /manual/transactions`, `PUT/DELETE /manual/transactions/:externalId`, `POST /accounts/:id/checkpoints`, `DELETE /checkpoints/:id`, `PUT /entries/:id/note`                                                                                                                                                                                                   |
| Investimentos | `GET /investments` (`on`), `POST /investments/positions`, `POST /investments/movements`, `DELETE /investments/movements/:entryId`, `POST /investments/positions/:id/valuations`                                                                                                                                                                                    |
| Categorias    | `GET/POST /categories`, `PATCH /categories/:id`, `POST /categories/:id/archive`, `GET /category-store/patterns`, `POST /category-store/preview`, `POST /category-store/edits`, `GET /category-store/provider-mappings`, `GET /category-review`, `GET/PUT/DELETE /entries/:id/category`, `POST /entries/:id/category/confirm`, `POST /entries/:id/category/correct` |

Valores são centavos inteiros e datas `YYYY-MM-DD`. `GET /entries` devolve `nextCursor` e `total`: passe o cursor recebido para a próxima página.

**O que a pessoa digita.** Uma transação digitada é um fato da fonte `manual`, como o de um banco: vira lançamento, concilia e recebe categoria do mesmo jeito, e se funde com a linha do banco quando ele informar o mesmo movimento. Editar grava a próxima versão; excluir grava uma versão `removed`, e o histórico fica. A resposta já traz o lançamento (`entryId`); o `manualId` de um lançamento é o id para editar ou excluir. Um saldo informado é um saldo `booked` da mesma fonte e entra na prova de saldo como o de um extrato (`checkpoints` na prova diz a origem de cada um); só o saldo informado pela pessoa pode ser retirado. Notas ficam presas às observações do lançamento, como as decisões de categoria, e o acompanham em fusões.

**Investimentos.** Posições, a classificação de um movimento da corretora numa posição e os valores informados são da pessoa; o valor atual é uma projeção. Ele soma a abertura e os movimentos postados até a data de referência (pendentes e datados depois dela ficam de fora até postarem); com um valor informado, parte dele e soma os movimentos postados depois. A classificação fica presa às observações do lançamento, como uma decisão de categoria, e segue o movimento quando o banco o informa. Posições em outra moeda aparecem em reais pela cotação pública do dia, só para exibição; sem cotação, ficam fora do total em reais.

**O que é assíncrono.** Decisões (vínculos, categoria de um lançamento) respondem já com o resultado recalculado. Importar um arquivo, vincular uma conta, pedir sincronização e editar contas, categorias ou a base de padrões gravam o fato ou a decisão e respondem; lançamentos, vínculos sugeridos e categorias inferidas são reconstruídos em segundo plano pelos reatores. O app deve invalidar e reler essas leituras depois da resposta (e, numa sincronização, depois de alguns segundos), sem supor que já mudaram. Antes de gravar uma edição da base, mostre `POST /category-store/preview`.

## Categorias

Cada lançamento recebe uma inferência (`category_inferences`) recalculada a partir de fatos, decisões e da base de padrões; nada é editado à mão nessa tabela. A primeira regra que se aplica vence:

1. Transferência ou pagamento de fatura confirmado pela conciliação: categoria de sistema, fora dos gastos.
2. Decisão da pessoa (`Categorizer.decide`, `confirm`, `correct`). `uncategorized` deixa sem categoria e encerra a revisão.
3. Parte de um lançamento decidido que se dividiu: revisão.
4. Estorno confirmado: herda a categoria da compra.
5. Transferência ou pagamento de fatura sugerido: revisão.
6. Padrão exato do estabelecimento (98), prefixo (92), categoria da Pluggy mapeada pela pessoa (90) ou mapa embutido (60, revisão).
7. Resposta do modelo, sempre em revisão até ser avaliado.

Só decisões da pessoa e edições da base escrevem em `category_patterns`, sempre por `KnowledgeStore`. Respostas do modelo ficam em `model_classifications` e nunca viram padrão. Antes de gravar uma edição da base, `Categorizer.previewStoreEdit` mostra os lançamentos que mudariam. Ao mudar o resultado da política, incremente `POLICY_VERSION` em `src/categories/Policy.ts`: o servidor recalcula todo o histórico ao iniciar.

## Migração do V1

`migrate-v1` traz do banco do V1 o que a pessoa configurou e decidiu, sem copiar fatos importados: o V2 volta a observá-los nas fontes ([ADR 003](../../plans/adrs/003-backend-v2-effect.md)).

```bash
# Da raiz do repositório; o banco do V1 fica em DATABASE_URL, por padrão data/financas.db
pnpm --filter @spendle/server migrate-v1 --from "$PWD/data/financas.db" --dry-run  # mostra o que mudaria
pnpm --filter @spendle/server migrate-v1 --from "$PWD/data/financas.db"            # grava no banco do V2
```

O caminho é relativo a `packages/server`, por isso o `$PWD`. O banco do V1 é aberto só para leitura. O do V2 é o de `SPENDLE_DATABASE_PATH`. `--dry-run` executa a migração numa cópia do banco do V2 (feita com o backup do SQLite) e imprime o resumo: contagens por tipo, o que fica para trás e por quê, e as decisões que ainda esperam lançamentos. Rodar de novo não muda nada: cada registro trazido fica em `v1_import_map` e só é criado uma vez; depois disso, editá-lo é com a pessoa, no V2.

| V1                                                                                 | V2                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Escopos de titularidade                                                            | Titulares (`company_br` e `company_us` viram `company`)                                                                                                     |
| Contas e cartões, instituição, limite, fechamento e vencimento                     | Contas por `Accounts.open`; inativas ficam arquivadas. Sem instituição, `Sem instituição`. Cartão sem vencimento fica para trás                             |
| Categorias                                                                         | Mesmos ids, nomes, cores, ícones, buckets, pai e estado. `transfer` e `card_payment` continuam do V2                                                        |
| `knowledge_base` de categoria                                                      | `category_patterns` por `KnowledgeStore.importV1`, origem `v1_import`, com modo, direção, confirmações e correções. Padrão que o V2 já tem prevalece        |
| Categoria escolhida na revisão de um lote                                          | Decisão (`v1_import`) quando o lançamento chega ao V2                                                                                                       |
| Categoria trocada depois na lista de transações                                    | Idem. Reconhecida como na migração 0034 do V1: difere da sugestão concreta da importação. Se os padrões trazidos já dão a mesma categoria, não vira decisão |
| Transferência, pagamento de fatura e estorno confirmados ou rejeitados pela pessoa | Decisão de vínculo quando as duas pontas chegam. Os que o V1 confirmou ou invalidou sozinho ficam para o conciliador do V2                                  |

**Decisões esperando lançamentos.** O V1 não guarda uma identidade que o V2 reproduza (o V1 nunca usou a Pluggy, e os ids de linha dos arquivos dependem do leitor), então cada decisão guarda a conta, o dia, o valor e a descrição normalizada do movimento (`v1_import_movements`). Quando os lançamentos de uma conta mudam, o reator `v1-import` procura o único lançamento com o mesmo dia, valor e descrição, ou, se a descrição vier escrita de outro jeito, o único com o mesmo dia e valor. Só aplica quando o movimento também era único assim no V1; com dois candidatos, a decisão espera e aparece no resumo. A categoria entra por `Categorizer.decide` sem ensinar a base (o padrão já veio); o vínculo, por `Reconciliation.decide` ou `link`. Se a pessoa já decidiu aquele lançamento no V2, a decisão do V1 fica `superseded`. Uma rejeição espera até o conciliador sugerir o par.

**O que não vem.** Lançamentos e saldos importados (o V2 os observa de novo), lançamentos digitados à mão, recorrências e seus padrões, divisões de lançamento, instrumentos de cartão, regras de categorização, orçamentos, metas, posições de investimento, vínculos manuais de débito com fatura (o V2 liga o pagamento ao crédito no cartão; confirme o vínculo quando os dois lados chegarem) e grupos de câmbio ou distribuição de lucros. O resumo lista cada item com o motivo.

**Depois da migração.**

1. Inicie o servidor (`pnpm --filter @spendle/server dev`).
2. Pluggy: conecte cada banco no V2 (`POST /api/v2/open-finance/connect-token` e `POST /api/v2/open-finance/connections/:id/item`), ligue cada conta da Pluggy à conta migrada em vez de abrir outra (`PUT /api/v2/open-finance/provider-accounts/:id/link`) e sincronize (`POST /api/v2/open-finance/connections/:id/sync`).
3. Arquivos: importe os mesmos OFX, CSV e PDF nas contas migradas (`POST /api/v2/imports`).
4. As decisões se aplicam conforme os lançamentos chegam. `migrate-v1 --dry-run` de novo mostra o que ainda espera.
