# Spendle

Aplicativo local para consolidar contas PF/PJ brasileiras, investimentos e cartões, provar saldos contra extratos bancários e reconciliar transferências.

## Executar

Use Node.js 22.22.0 (`.node-version`) e pnpm 9.15.9 (`packageManager`). `pnpm dev` escuta somente no endereço Tailscale da máquina (`tailscale ip -4`), acessível pelos dispositivos da tailnet e não pela rede local. O comando falha se o Tailscale não estiver ativo.

```bash
cp .env.example .env.local
pnpm install --frozen-lockfile
pnpm setup:check
pnpm dev
```

Acesse `http://<nome-da-máquina>.<tailnet>.ts.net:3000` ou o IP Tailscale na porta 3000. O SQLite e os arquivos importados são criados em `data/`, fora da pasta pública e do Git. A chave de IA é opcional, usada no diagnóstico de PDFs e no assistente com consentimento. Ela nunca libera automaticamente uma importação.

## Primeira importação

1. Exporte os dois meses mais recentes de cada banco, preferindo OFX. Use CSV quando OFX não existir e envie também o PDF correspondente quando ele trouxer o saldo ou total da fatura.
2. Em **Importar**, selecione manualmente a conta ou cartão e envie todos os arquivos desse destino em um único lote.
3. O app detecta períodos, lacunas, sobreposições e identidade visível no documento. Instituição, final do identificador ou tipo de documento incompatíveis bloqueiam o lote.
4. Revise os bloqueios antes de consolidar. Divergência de saldo não pode ser ignorada. Arquivos sem saldo podem exigir confirmação do período e revisão manual; sua importação não torna o saldo verificado.
5. Repita por destino e confira a tabela de cobertura. “Verificado até” é a data do último ponto de controle que fechou com diferença zero.

Quando CSV e PDF do mesmo período possuem exatamente as mesmas datas, valores, moedas e multiplicidades, o CSV vira a fonte canônica dos lançamentos e o PDF fica preservado como evidência de controle. Arquivos digitalizados que exigem OCR ficam em quarentena para revisão; OCR automático está no backlog.

## Comandos

```bash
pnpm db:generate   # gerar migração após alterar o schema
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify        # executar toda a verificação
```

## Arquitetura

- TanStack Start, Router e Query
- TypeScript, Tailwind CSS e shadcn `base-nova` com Base UI
- Drizzle ORM e SQLite com migrações versionadas
- Zod nos contratos e server functions em toda operação de dados/arquivos
- Valores em centavos, percentuais em basis points e BRL como moeda-base
- `@firecrawl/pdf-inspector` para classificação, Markdown nativo e texto com página/coordenadas
- OFX e CSV determinísticos; pares CSV/PDF são conferidos por valor antes do commit
- Vercel AI SDK para diagnóstico de PDFs e assistente, com consentimento
- Ledger imutável de fatos importados, pontos de controle de saldo e commit com tolerância zero
- Duas pontas preservadas em transferências, pagamentos de cartão e distribuições de lucro
- Base de conhecimento com as decisões humanas de categoria e recorrência por estabelecimento, reaproveitada nas próximas importações
- Módulos independentes para leitura de extratos, canonicalização, cobertura, checkpoints e reconciliação
- Read model dedicado para a revisão de importações, sem carregar o snapshot financeiro completo

O escopo, as decisões e o mapa de arquitetura estão em [`plans/`](./plans/README.md). Verificações e limitações conhecidas estão em [`docs/`](./docs/README.md).

## Verificação com agentes

`pnpm verify` executa tipos, lint, testes e build, também no CI. `pnpm test:pdf` usa um PDF sintético versionado e o extrator nativo, sem chave de IA. Os testes com extratos privados continuam opcionais, configurados pelas variáveis indicadas em `pdf-real-fixtures.integration.test.ts`.

Para verificar a interface com o navegador integrado, siga a [skill browser-qa](.agents/skills/browser-qa/SKILL.md):

```bash
pnpm qa:start 3100       # banco e uploads sintéticos em uma nova pasta .qa/
pnpm qa:start 3101 121   # outro servidor, com 121 despesas para paginação
pnpm qa:inspect <pasta>  # leitura do estado do run
pnpm qa:clean <pasta>    # remover um run depois de parar seu servidor
pnpm bench              # tempos, contagens de SELECT e tamanho das respostas
```

Cada worktree usa seu próprio run e uma porta explícita. Não é preciso copiar `.env.local` ou dados reais. O servidor QA desativa IA e grava `server.log`, com duração e identificadores das operações de importação/reconciliação. `FINANCAS_DEBUG=1` ativa esses diagnósticos também no desenvolvimento normal.

Os uploads ficam em `imports/` ao lado do arquivo SQLite configurado por `DATABASE_URL`; o padrão continua `data/imports`. Bancos já existentes mantêm os caminhos absolutos dos arquivos importados anteriormente.
