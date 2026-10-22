# @spendle/server

Backend ([ADR 003](../../plans/adrs/003-backend-v2-effect.md)), o único backend do Spendle: o app web em `src/` o chama pelas server functions. Cada espaço familiar tem o próprio banco SQLite em `data/v2/spaces/`; `data/v2/control.sqlite` guarda os espaços e seus membros.

Na produção ([ADR 004](../../plans/adrs/004-cloudflare-workers.md)) os mesmos serviços rodam em Durable Objects da Cloudflare (`src/durable`): um objeto por espaço, com o próprio SQLite, e o objeto `Control` no lugar de `control.sqlite`. O que segue descreve o servidor Node, usado no desenvolvimento e no QA.

```bash
vp run --filter @spendle/server dev     # http://localhost:4100
vp run --filter @spendle/server verify  # typecheck, diagnósticos Effect e testes
vp run --filter @spendle/server qa      # API em memória com dados sintéticos e Pluggy falsa
```

`vp run qa:start [porta]` na raiz sobe essa API de QA na porta `<porta> + 1200` junto com o app web.

| Variável                                      | Uso                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SPENDLE_DATA_DIR`                            | Pasta do banco de controle e dos bancos dos espaços; padrão `data/v2`                                |
| `SPENDLE_DATABASE_PATH`                       | Banco de antes dos espaços, usado por `claim-space`; padrão `data/v2/spendle.sqlite`                 |
| `SPENDLE_SERVER_PORT`                         | Porta HTTP; padrão `4100`                                                                            |
| `SPENDLE_SERVER_HOST`                         | Interface; padrão `127.0.0.1` (só esta máquina)                                                      |
| `SPENDLE_API_TOKEN`                           | Token Bearer exigido em `/api`; 32+ caracteres; opcional                                             |
| `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`    | Credenciais da Pluggy; sem elas, o Open Finance fica inativo                                         |
| `PLUGGY_WEBHOOK_URL`, `PLUGGY_WEBHOOK_SECRET` | Webhook; os dois juntos ou nenhum                                                                    |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`      | Assistente (análise mensal e perguntas); sem os dois, desligado. Modelo no formato `provedor/modelo` |
| `CLASSIFIER_MODEL`                            | Classificador de categorias pelo OpenRouter; só precisa da chave. Padrão `openai/gpt-6-luna`         |
| `CLASSIFIER_APPLY_THRESHOLD`                  | Probabilidade (0,5 a 1) a partir da qual a resposta do modelo é aplicada; vazio, tudo vai à revisão  |
| `OPENROUTER_API_URL`                          | Endereço do OpenRouter, para o assistente e o classificador; padrão `openrouter.ai/api/v1`           |

## Espaços familiares

Todos os dados pertencem a um espaço: contas, lançamentos, categorias, planejamento e conexões. Cada espaço tem o próprio banco e os próprios serviços e reatores; nenhuma consulta cruza espaços.

- O app web envia o e-mail de quem entrou no cabeçalho `x-spendle-member`. Com `SPENDLE_API_TOKEN`, o token é verificado antes, e só ele torna o cabeçalho confiável.
- O primeiro pedido de um e-mail sem espaço cria um espaço vazio para ele.
- `/api/space` (contrato `SpaceApi`, respondido pelo servidor, não por um espaço) mostra quem faz parte do espaço; quem o criou adiciona e remove pessoas. Uma pessoa que já entrou, mas nunca gravou nada no próprio espaço, muda para o novo espaço; o antigo fica sem membros, com o arquivo intacto. Se ela gravou qualquer coisa lá, o pedido é recusado (`member_elsewhere`). As mudanças de membros conferem, na mesma transação, que quem pede é quem criou o espaço.
- O webhook da Pluggy é guardado primeiro no banco de controle e respondido na hora; depois vai ao espaço cuja conexão tem o item ou, para um item novo, ao espaço da conexão que o pediu. Exclusões de item vão a todos os espaços. O que não dá para entregar ainda (Pluggy ou um espaço indisponível, dados não reivindicados) fica guardado e é tentado de novo, na ordem de cada item.
- Saúde (`/api/health`) e o documento OpenAPI respondem sem token nem membro.

Os dados de antes dos espaços continuam em `SPENDLE_DATABASE_PATH`. Enquanto ninguém os reivindica, a API não cria espaços e responde `unclaimed_database`. Rode uma vez, antes de entrar no app:

```bash
vp run --filter @spendle/server claim-space --email voce@gmail.com
```

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

A API fica em `/api`, definida uma vez em `src/api/definition/` com `HttpApi` do Effect. O app web importa o contrato de `@spendle/server/api` (só depende de `effect`) e deriva um cliente tipado; o documento OpenAPI fica em `GET /api/openapi.json`.

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

**Acesso.** Ainda não há contas de usuário ([ADR 003](../../plans/adrs/003-backend-v2-effect.md)). O servidor escuta só em `127.0.0.1`; para servir outra máquina da rede, defina `SPENDLE_SERVER_HOST` e um `SPENDLE_API_TOKEN` longo (`openssl rand -hex 32`), que passa a ser exigido como `Authorization: Bearer` em toda rota `/api`. `GET /health` responde sem token. Nunca publique a API na internet; o webhook da Pluggy continua sendo a única rota pública.

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
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Digitados     | `POST /manual/transactions`, `PUT/DELETE /manual/transactions/:externalId`, `POST /accounts/:id/checkpoints`, `DELETE /checkpoints/:id`, `PUT /entries/:id/note`                                                                                                                                                                                                   |
| Investimentos | `GET /investments` (`on`), `POST /investments/positions`, `POST /investments/movements`, `DELETE /investments/movements/:entryId`, `POST /investments/positions/:id/valuations`                                                                                                                                                                                    |
| Planejamento  | `GET /planning`, `PUT /planning/settings`, `PUT /planning/strategy`, `POST /planning/goals`, `POST /planning/goals/:id/contributions`, `POST /planning/close`                                                                                                                                                                                                      |
| Painel        | `GET /dashboard` (`month`), `GET /dashboard/history` (`months`), `GET /dashboard/forecast` (`days`)                                                                                                                                                                                                                                                                |
| Recorrências  | `GET/POST /recurrences`, `PUT/DELETE /recurrences/:id`, `PUT /recurrences/:id/active`, `GET /recurrences/detected`, `POST /recurrences/detected/approve`, `POST /recurrences/detected/ignore`, `GET /recurrences/candidates`, `POST /recurrences/links`, `POST /recurrences/matches/{confirm,reject,unlink}`, `POST /recurrences/occurrences/{skip,complete}`      |
| Assistente    | `GET /assistant/status`, `POST /assistant/analysis/latest`, `POST /assistant/analysis/:month`, `POST /assistant/questions`                                                                                                                                                                                                                                         |
| Categorias    | `GET/POST /categories`, `PATCH /categories/:id`, `POST /categories/:id/archive`, `GET /category-store/patterns`, `POST /category-store/preview`, `POST /category-store/edits`, `GET /category-store/provider-mappings`, `GET /category-review`, `GET/PUT/DELETE /entries/:id/category`, `POST /entries/:id/category/confirm`, `POST /entries/:id/category/correct` |

Valores são centavos inteiros e datas `YYYY-MM-DD`. `GET /entries` devolve `nextCursor` e `total`: passe o cursor recebido para a próxima página.

**O que a pessoa digita.** Uma transação digitada é um fato da fonte `manual`, como o de um banco: vira lançamento, concilia e recebe categoria do mesmo jeito, e se funde com a linha do banco quando ele informar o mesmo movimento. Editar grava a próxima versão; excluir grava uma versão `removed`, e o histórico fica. A resposta já traz o lançamento (`entryId`); o `manualId` de um lançamento é o id para editar ou excluir. Um saldo informado é um saldo `booked` da mesma fonte e entra na prova de saldo como o de um extrato (`checkpoints` na prova diz a origem de cada um); só o saldo informado pela pessoa pode ser retirado. Notas ficam presas às observações do lançamento, como as decisões de categoria, e o acompanham em fusões.

**Investimentos.** Posições, a classificação de um movimento da corretora numa posição e os valores informados são da pessoa; o valor atual é uma projeção. Ele soma a abertura e os movimentos postados até a data de referência (pendentes e datados depois dela ficam de fora até postarem); com um valor informado, parte dele e soma os movimentos postados depois. A classificação fica presa às observações do lançamento, como uma decisão de categoria, e segue o movimento quando o banco o informa. Posições em outra moeda aparecem em reais pela cotação pública do dia, só para exibição; sem cotação, ficam fora do total em reais. O planejamento e o painel medem a reserva de emergência pelas posições marcadas como reserva; enquanto nenhuma está marcada, vale o valor atual da meta.

**O que é assíncrono.** Decisões (vínculos, categoria de um lançamento) respondem já com o resultado recalculado. Importar um arquivo, vincular uma conta, pedir sincronização e editar contas, categorias ou a base de padrões gravam o fato ou a decisão e respondem; lançamentos, vínculos sugeridos e categorias inferidas são reconstruídos em segundo plano pelos reatores. O app deve invalidar e reler essas leituras depois da resposta (e, numa sincronização, depois de alguns segundos), sem supor que já mudaram. Antes de gravar uma edição da base, mostre `POST /category-store/preview`.

## Categorias

Cada lançamento recebe uma inferência (`category_inferences`) recalculada a partir de fatos, decisões e da base de padrões; nada é editado à mão nessa tabela. A primeira regra que se aplica vence:

1. Transferência ou pagamento de fatura confirmado pela conciliação: categoria de sistema, fora dos gastos.
2. Decisão da pessoa (`Categorizer.decide`, `confirm`, `correct`). `uncategorized` deixa sem categoria e encerra a revisão.
3. Parte de um lançamento decidido que se dividiu: revisão.
4. Estorno confirmado: herda a categoria da compra.
5. Transferência ou pagamento de fatura sugerido: revisão.
6. Padrão exato do estabelecimento (98), prefixo (92), categoria da Pluggy mapeada pela pessoa (90) ou mapa embutido (60, revisão).
7. Resposta do modelo (GPT-6 Luna pelo OpenRouter), em revisão; aplicada a partir de `CLASSIFIER_APPLY_THRESHOLD`, escolhido com `vp run --filter @spendle/server eval:categories` (veja [`evals/categories`](evals/categories/README.md)).

Só decisões da pessoa e edições da base escrevem em `category_patterns`, sempre por `KnowledgeStore`. Respostas do modelo ficam em `model_classifications` e nunca viram padrão. Antes de gravar uma edição da base, `Categorizer.previewStoreEdit` mostra os lançamentos que mudariam. Ao mudar o resultado da política, incremente `POLICY_VERSION` em `src/categories/Policy.ts`: o servidor recalcula todo o histórico ao iniciar.

## Planejamento

Renda de referência, regra da reserva, estratégia, metas e meses fechados são decisões da pessoa (`src/planning/Planning.ts`). Um mês fechado guarda a estratégia, a divisão e a renda com que foi fechado; gatilhos impedem alterá-lo, e mudar a estratégia é recusado enquanto o mês corrente estiver fechado. O mês só fecha sem pendências: lançamentos sem categoria ou em revisão, pendentes, conciliações sugeridas, ocorrências vencidas e categorias divergentes em recorrências.

Recorrências guardam o calendário (início, âncora, frequência) e os vereditos da pessoa: pagamento vinculado ou rejeitado (seguindo as observações do lançamento, como as decisões de categoria), ocorrência ignorada ou período de envelope concluído, candidato ignorado na detecção. Ocorrências, correspondências e detecção são recalculadas a cada leitura (`RecurrencePolicy.ts`). O que o conciliador aprende de uma recorrência (estabelecimentos, contas, atraso típico, faixa de valor) vem só dos vínculos confirmados pela pessoa e dos estabelecimentos trazidos do V1; vínculo automático só com três confirmações, estabelecimento e conta já confirmados e sem ambiguidade, e nunca ensina. Confirmar um pagamento de lançamento ainda sem categoria aplicada decide a categoria da recorrência por `Categorizer.decide`.

O mês (`Month.ts`) e a previsão de caixa são política pura: faturas pertencem ao mês de vencimento (compras do ciclo, parcelas ainda não lançadas e o que a fatura mostra além delas), gastos em conta ao mês do lançamento, recorrências ainda esperadas viram estimativas, aportes são lançamentos de investimento ou reserva e transferências confirmadas para contas dessas finalidades. Caixa é a soma das contas operacionais em BRL a partir do checkpoint de saldo mais próximo; contas em outra moeda ficam de fora e são contadas (o backend ainda não tem cotações).

O assistente usa o OpenRouter, atrás de `AssistantModel`; sem `OPENROUTER_API_KEY` e `OPENROUTER_MODEL` nunca chama o modelo. Não há consentimento separado. Relatórios ficam em `assistant_reports` como saída de modelo, nunca como decisão; as economias propostas são calculadas no servidor a partir dos gastos observados.
