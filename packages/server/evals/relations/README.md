# Avaliação das relações

`vp run --filter @spendle/server eval:relations` roda o pareador de relações (`matchRelations` em `src/reconciliation/Matching.ts`) sobre casos congelados e mostra quantas transferências entre contas, pagamentos de fatura e estornos reais ele confirma, sugere ou perde, e quais pares ele inventa. O pareador é puro: a avaliação é gratuita, não precisa de chave e dá o mesmo placar para o mesmo commit.

## Arquivos

- `dataset.json`: contas e casos. Cada caso tem lançamentos e a lista completa dos pares que aconteceram de fato entre eles; um caso sem pares é uma coincidência que não deve ser pareada. Pessoas, documentos e contas são fictícios; bancos e lojas são reais.
- `results/`: saídas completas de cada execução, fora do Git.

## Como o placar é calculado

Cada caso roda sozinho e sem decisões, como na primeira vez que o Spendle vê esses lançamentos. Cada par proposto ou esperado recebe um veredito:

| Veredito          | Significado                            | Custo para a pessoa                         |
| ----------------- | -------------------------------------- | ------------------------------------------- |
| `auto right`      | Par real confirmado sem revisão        | Nenhum                                      |
| `auto WRONG`      | Par inexistente confirmado sem revisão | Some um gasto ou uma renda, sem aviso       |
| `suggested right` | Par real sugerido                      | Um clique para confirmar                    |
| `suggested wrong` | Par inexistente sugerido               | Um clique para recusar                      |
| `missed`          | Par real que o pareador não propôs     | O movimento aparece como gasto e como renda |

Um par do tipo errado (um estorno onde houve uma transferência) conta como errado, e o par real conta como perdido.

- `autoPrecision`: dos pares confirmados sem revisão, quantos são reais. É a métrica que manda: deve ser 100%. `autoPrecision ≥` é o limite inferior do intervalo de Wilson a 95%; com poucos pares confirmados, 100% ainda pode esconder um erro em cada quatro.
- `automation`: pares reais confirmados sem revisão, o trabalho poupado. Só vale a pena subir sem baixar `autoPrecision`.
- `recall`: pares reais confirmados ou sugeridos, o que a pessoa chega a ver.
- `suggestionPrecision`: das sugestões, quantas são reais.

Com cerca de 30 pares reais, um par vale mais de 3 pontos. Leia a lista de erros antes de comparar porcentagens.

## Como ler e aumentar o conjunto

- Os rótulos dizem o que aconteceu, nunca o que o pareador responde. Não mude um rótulo para o placar melhorar; mude o pareador ou explique na `note` por que o caso estava errado.
- A tag `indistinguishable` marca casos com os mesmos fatos observáveis e rótulos opostos (`generic-pix-own-accounts` e `generic-pix-two-strangers`). Nenhum pareador acerta os dois sem ver mais dados; o comportamento certo é sugerir, nunca confirmar.
- As descrições imitam o formato de cada banco, mas foram escritas à mão. Um placar baixo num formato pode refletir um texto que nenhum banco envia. Casos vindos de decisões reais, anonimizados, devem substituir esses formatos aos poucos.
- Acrescente casos com novos `id` e tags que digam o que o caso testa; não reescreva os existentes, para que execuções de datas diferentes continuem comparáveis.
