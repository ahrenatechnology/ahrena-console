# 0015 · GitHub em background: o núcleo sincroniza, as telas leem só o banco local

- **Status:** aceita (pedido do Fernando em 29/10)
- **Data:** 2026-10-29
- **Issue:** [#356](https://github.com/ahrenatechnology/ahrena-console/issues/356)
- **Substitui:** o item 6 da [0001](0001-github-consulta-cache.md) ("proibido laço de aquecimento e leitura de todas as organizações na partida"). O resto da 0001 vale: consultas rasas, TTLs, leitura velha por até 24 h, a fila única e a pausa por limite.

## Contexto

Abrir as telas de Decisões (ADRs e PDRs) e do Projeto pesa o núcleo e o limite do GitHub a cada visita:

- **Decisões:** o índice montado fica só em memória, com validade de 60 s. A cada reinício do núcleo a tela abre em "carregando" e o índice é remontado varrendo até 500 repositórios da conta.
- **Projeto:** o `GET /api/project` espera o GitHub sempre que o quadro guardado passou de 2 min.
- Nenhum timer do núcleo atualiza dado do GitHub: quem dispara a leitura é a tela.

O custo, então, cresce com quantas vezes as telas são abertas, e a espera cai em quem abre.

## Decisão

**Um job do núcleo sincroniza o GitHub em background e grava no SQLite. As telas leem só o que está gravado; nenhuma rota espera o GitHub quando já há algo no banco.**

1. **O job** (`src/github/background-sync.ts`) roda na partida e em intervalos, um passo de cada vez, pela fila única do GitHub:

   | Passo | Intervalo | O que lê |
   | --- | --- | --- |
   | `project` | 2 min | o quadro do Project escolhido (a chave e a consulta da 0001) |
   | `decisions` | 15 min | a lista de repositórios e o índice de ADRs e PDRs; só relê o conteúdo de quem teve push |

   Sem GitHub conectado ou sem Project escolhido, o passo é pulado. Com o GitHub pausado por limite (403/429), o passo espera a pausa acabar.
2. **Snapshots no SQLite.** O índice de decisões (`adrs:index`) e a leitura de cada repositório (`adrs:repo:<owner>/<repo>`) passam a ser gravados no `github_cache`, como o quadro do Project já era. Depois de reiniciar, a tela serve o último snapshot na hora.
3. **As rotas não esperam.** `/api/adrs` e `/api/pdrs` servem o snapshot e não disparam montagem para os repositórios que o job cobre; `/api/project` serve o quadro guardado, de qualquer idade até 24 h, com `stale` quando passou do TTL. Só a primeira leitura de todas, com o banco vazio, espera o GitHub.
4. **Atualizar** (`?refresh=1`) continua forçando a releitura daquela fonte, com o mínimo de 30 s da 0001.
5. **Status** em `GET /api/github/sync`: cada passo com a última rodada, a próxima, a duração e o último erro.

## Orçamento

Por pessoa, com o núcleo ligado, com ou sem tela aberta: o Project a cada 2 min (cerca de 3 pontos por página, 30 a 90 por hora) e uma varredura de decisões a cada 15 min (1 ponto por lote de 20 repositórios, até 25 por varredura, mais o conteúdo dos repositórios com push). Fica abaixo de 3% do limite primário de 5.000 por hora, e passa a ser fixo: abrir a tela dez vezes não custa nada a mais.

## Por que não webhooks

O núcleo local não tem URL pública (0001, opção 4). No hub da AWS (7.9) os webhooks continuam sendo o caminho, e o núcleo local passa a ler do hub em vez de rodar este job.

## Consequências

- O núcleo lê o GitHub mesmo sem tela aberta: o custo deixa de ser zero quando ninguém olha.
- A primeira partida, com o banco vazio, ainda espera o GitHub na primeira tela.
- Um repositório aberto fora da lista da conta (pela URL) continua sendo lido sob demanda, como hoje.
