# ADR 004: produção na Cloudflare

Decisão de 18/10/2026.

## Problema

O Spendle rodava só numa máquina: arquivos SQLite em `data/`, um processo Node com reatores sempre ativos e o webhook da Pluggy exposto por túnel. Sem essa máquina ligada, a família fica sem acesso, e backup e recuperação dependem de cópias manuais.

## Decisão

A produção é um Worker da Cloudflare com o app web e a API no mesmo deploy:

| No Node (`vp run dev`)                     | Na Cloudflare                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Um arquivo SQLite por espaço em `data/v2/` | Um Durable Object `Space` por espaço, com o próprio SQLite (`@effect/sql-sqlite-do`) |
| `control.sqlite` e a caixa de webhooks     | O Durable Object `Control`, único                                                    |
| `data/auth/auth.sqlite` do Better Auth     | O D1 `spendle-auth`                                                                  |
| O app chama a API em `127.0.0.1:4100`      | O app chama o `Control` pelo stub, sem rede; nada de fora alcança a API              |
| Reatores em segundo plano com varredura    | Os mesmos reatores; o alarme do objeto termina o que sobrou e repete falhas          |

O domínio e as regras ficam iguais: os objetos montam `spaceServices` e as rotas do servidor sobre o armazenamento que recebem (`packages/server/src/durable`). `SpaceGateway` é a costura entre o roteamento e os espaços: no Node eles são montados no processo (`LocalSpaces`), na Cloudflare cada um responde no próprio objeto. As classes dos objetos e o Worker ficam em `packages/cloudflare`; `src/platform` troca o banco do Better Auth e o transporte da API no build.

O desenvolvimento e o QA continuam no Node, com dados sintéticos e Pluggy falsa. `vp build --mode qa` roda o Worker no workerd local para conferir o que só a Cloudflare executa.

## Consequências

- Cada espaço ganha recuperação a um ponto dos últimos 30 dias, do próprio Durable Object.
- Uploads são lidos em memória no objeto, e o arquivo fica inteiro numa linha do SQLite, que aceita até 2 MB: o limite por arquivo caiu de 20 MB para 1,5 MB.
- O SQLite de um Durable Object aceita até 100 parâmetros por consulta: buscas por listas de ids sem limite vão em lotes (`persistence/Chunks.ts`).
- Os objetos não varrem nem repetem em timers sem fim: o alarme termina e repete o trabalho.
- Um objeto ocioso sem timer hiberna em 10 segundos e, no próximo pedido, monta os serviços de novo. Por isso cada objeto fica acordado por 5 minutos depois do último pedido (`packages/cloudflare/src/awake.ts`), e o trabalho de partida que só depende do código e da configuração (recalcular categorias e conciliação, registrar o webhook da Pluggy) roda uma vez por versão do Worker (`events/Startup.ts`), não a cada despertar.
- O Worker roda no leste dos EUA (`placement`), ao lado do D1 e dos objetos: o D1 não tem região na América do Sul, e um pedido cruza o continente uma vez em vez de a cada leitura de sessão e chamada à API.
- O plano Free limita cada requisição a 10 ms de CPU, pouco para montar os serviços de um espaço, recalcular o histórico ou ler um PDF: a produção conta com o Workers Paid.
- O domínio próprio exige a zona `codemode.studio` na conta da Cloudflare.
- Os dados de `data/` não migram sozinhos para os objetos: trazê-los é um passo separado.
