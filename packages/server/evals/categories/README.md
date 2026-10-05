# Avaliação das categorias

`pnpm --filter @spendle/server eval:categories` reproduz decisões humanas congeladas pelo classificador do V2 (`src/categories/Classifier.ts`, o Jev da TypeSafe) e imprime o placar usado para escolher `TYPESAFE_APPLY_THRESHOLD`. Faz chamadas pagas e fica fora de `pnpm verify`.

```bash
# Da raiz; a chave vem do ambiente ou de .env.local na raiz
pnpm --filter @spendle/server eval:categories                 # modelo (pago)
pnpm --filter @spendle/server eval:categories --mode policy   # só a política determinística, sem chave
pnpm --filter @spendle/server eval:categories --mode all      # os dois e a combinação, como o app roda
pnpm --filter @spendle/server eval:categories --target 0.98 --min-applied 40 --threshold 0.95
```

Sem `TYPESAFE_API_KEY`, o modo `model` sai com código 1 e explica o que fazer. O modelo avaliado é o de `TYPESAFE_MODEL` (padrão `jev-1.13.0`), com as mesmas descrições de categoria (`src/categories/Descriptions.ts`) e o mesmo pedido que o servidor envia.

## Arquivos

- `dataset.json`: conjunto congelado, trazido da PR #2. Nomes de pessoas, documentos, contas e valores são falsos; nomes de empresas são reais. Não regenere: acrescente itens com novos `id` para que execuções de datas diferentes sejam comparáveis.
- `categories.json`: categorias do conjunto (os mesmos ids das categorias embutidas do V2). O campo `description` é histórico; o que vai ao modelo é `Descriptions.ts`.
- `baselines/`: placares já registrados. `2026-09-19-pr2-v1.json` é a execução da PR #2 no V1 (Jev pelo Vercel AI Gateway, um pedido por lançamento; confiança 70 = probabilidade 0,7).
- `results/`: saídas locais completas, fora do Git.

## Como ler o conjunto

- `split: context` são decisões tratadas como já tomadas pela pessoa: no modo `policy` elas ensinam a base de padrões. `split: exam` são as perguntas. A divisão é por estabelecimento, então a política quase nunca resolve o `exam` sozinha (só por prefixo); isso é esperado e mostra o que sobra para o modelo. O conjunto não traz categoria da Pluggy, então o mapa de categorias do provedor não entra.
- `guessable: false` marca convenções pessoais ou descrições opacas, como um Pix para uma pessoa classificado em Saúde. Nenhum modelo acerta isso pela descrição; o placar é separado.
- `origin: synthetic_movement` são transferências e pagamentos de fatura que não devem receber categoria. No app a conciliação costuma resolvê-los antes; aqui, categoria aplicada num deles conta como erro.

## Como ler o placar

- `correctAndConfident`: lançamentos resolvidos certo sem revisão, o ganho real. `accuracyWhenConfident` sozinho favorece quem quase não aplica.
- A tabela de limiares mostra, para cada probabilidade, quantas respostas seriam aplicadas e quantas estariam certas (transferências incluídas). A calibração mostra o acerto por faixa de probabilidade.
- Com cerca de 80 itens adivinháveis, um item vale 1,2 ponto; diferenças abaixo de 10 pontos são empate. Leia os erros listados.
- Não ajuste prompts ou descrições olhando os erros do `exam`. Itere com o `context` e use o `exam` só para confirmar.

## Como escolher `TYPESAFE_APPLY_THRESHOLD`

Sem a variável, o limiar é infinito e toda resposta do modelo vai para revisão. Para aplicar respostas sem revisão:

1. Rode `eval:categories` com o modelo que vai usar em produção (`TYPESAFE_MODEL`).
2. O placar recomenda o **menor limiar a partir do qual todo limiar mais alto** com pelo menos `--min-applied` respostas aplicadas (padrão 30) acerta pelo menos `--target` (padrão 0,97) das respostas aplicadas, transferências contadas como erro. Uma faixa de sorte abaixo de uma que falha não é recomendada.
3. Se nada atinge a meta, deixe a variável vazia. Na dúvida, prefira o limiar mais alto: uma resposta aplicada errada some da revisão, uma em revisão só custa um clique.
4. Defina `TYPESAFE_APPLY_THRESHOLD=<valor>` (entre 0,5 e 1) junto com o `TYPESAFE_MODEL` avaliado e reinicie o servidor; com o modelo ligado ele recalcula as inferências ao iniciar. Ao trocar de versão do Jev, avalie de novo antes de manter o limiar.

Mesmo aplicada, uma resposta do modelo nunca ensina a base de padrões: só a confirmação ou correção da pessoa ensina.
