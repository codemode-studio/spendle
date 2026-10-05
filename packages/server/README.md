# @spendle/server

Backend V2 ([ADR 003](../../plans/adrs/003-backend-v2-effect.md)). Roda separado do app V1, com banco próprio.

```bash
pnpm --filter @spendle/server dev     # http://localhost:4100
pnpm --filter @spendle/server verify  # typecheck, diagnósticos Effect e testes
```

| Variável                                      | Uso                                                          |
| --------------------------------------------- | ------------------------------------------------------------ |
| `SPENDLE_DATABASE_PATH`                       | Banco SQLite; padrão `data/v2/spendle.sqlite`                |
| `SPENDLE_SERVER_PORT`                         | Porta HTTP; padrão `4100`                                    |
| `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`    | Credenciais da Pluggy; sem elas, o Open Finance fica inativo |
| `PLUGGY_WEBHOOK_URL`, `PLUGGY_WEBHOOK_SECRET` | Webhook; os dois juntos ou nenhum                            |
| `TYPESAFE_API_KEY`                            | Classificador por modelo; sem ela, o modelo nunca é chamado  |
| `TYPESAFE_MODEL`, `TYPESAFE_API_URL`          | Modelo e endereço; padrão `jev-latest` em `api.typesafe.ai`  |

## Webhook da Pluggy

Sem webhook, a sincronização só acontece quando pedida. Com ele, a Pluggy avisa sobre novas transações, exclusões e mudanças de conexão, e o servidor sincroniza sozinho.

1. Gere um segredo longo: `openssl rand -hex 32`.
2. Exponha publicamente **só** `POST /api/pluggy/webhook`. O resto da API não tem autenticação e deve ficar na rede local. Com Tailscale Funnel, use uma porta própria para não publicar o que já é servido na 443 da tailnet:

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
