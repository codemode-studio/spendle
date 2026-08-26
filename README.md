# Finanças da Família

Aplicativo local para consolidar contas PF/PJ brasileiras, investimentos e cartões, provar saldos contra extratos bancários e reconciliar transferências.

## Executar

Requer Node.js e pnpm. O servidor escuta somente em `127.0.0.1`.

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

Acesse `http://127.0.0.1:3000`. O SQLite e os arquivos importados são criados em `data/`, fora da pasta pública e do Git. A chave de IA é opcional e serve apenas para diagnóstico; ela nunca libera automaticamente uma importação.

## Primeira importação

1. Exporte os dois meses mais recentes de cada banco, preferindo OFX. Use CSV quando OFX não existir e envie também o PDF correspondente quando ele trouxer o saldo ou total da fatura.
2. Em **Importar**, selecione manualmente a conta ou cartão e envie todos os arquivos desse destino em um único lote.
3. O app detecta períodos, lacunas, sobreposições e identidade visível no documento. Instituição, final do identificador ou tipo de documento incompatíveis bloqueiam o lote.
4. Consolide somente os lotes marcados como **Reconciliado**. Não existe confirmação que ignore diferença de saldo.
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
- Vercel AI SDK opcional apenas para diagnóstico de PDFs não reconhecidos, com consentimento
- Ledger imutável de fatos importados, pontos de controle de saldo e commit com tolerância zero
- Duas pontas preservadas em transferências, pagamentos de cartão e distribuições de lucro
- Módulos independentes para leitura de extratos, canonicalização, cobertura, checkpoints e reconciliação
- Read model dedicado para a revisão de importações, sem carregar o snapshot financeiro completo

O escopo, as decisões e o mapa de arquitetura estão em [`plans/`](./plans/README.md).
