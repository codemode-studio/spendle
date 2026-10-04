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
