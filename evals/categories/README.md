# Avaliação das sugestões de categoria

`pnpm eval:categories` reproduz decisões humanas congeladas por cada provedor e
compara o que muda o comportamento do app. Faz chamadas pagas e fica fora de
`pnpm verify`. Use `--only jev` para rodar só as configurações do Jev.

## Arquivos

- `dataset.json`: conjunto congelado. Nomes de pessoas, documentos, contas e
  valores são falsos; nomes de empresas são reais. Não regenere: acrescente
  itens com novos `id` para que execuções de datas diferentes sejam comparáveis.
- `categories.json`: categorias e a frase descritiva usada nas configurações
  com descrições.
- `results/`: saídas locais, fora do Git.

## Como ler o conjunto

- `split: context` são decisões que podem ser mostradas ao modelo como
  convenções da família. `split: exam` são as perguntas; o modelo nunca vê a
  resposta delas. A divisão é por estabelecimento, para o mesmo nome não cair
  dos dois lados.
- `guessable: false` marca convenções pessoais ou descrições opacas, como um Pix
  para uma pessoa classificado em Saúde. Nenhum modelo acerta isso pela
  descrição; o placar é separado para não punir nem premiar ninguém.
- `origin: synthetic` cobre categorias sem decisão real. `synthetic_movement`
  são transferências e pagamentos de fatura que não devem receber categoria.

## Como ler o placar

- `correctAndConfident` é o número principal: lançamentos resolvidos certo sem
  revisão. `accuracyWhenConfident` sozinho favorece quem quase não responde.
- Compare provedores pelo mesmo conjunto. Com cerca de 80 itens adivinháveis, um
  item vale 1,2 ponto; diferenças abaixo de 10 pontos são empate. Leia os erros.
- Não ajuste prompts olhando os erros do `exam`. Itere com o `context` e use o
  `exam` só para confirmar.
