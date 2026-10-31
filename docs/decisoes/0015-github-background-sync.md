# 0015 · GitHub em background: o núcleo sincroniza, as telas leem só o banco local

- **Status:** aceita (pedido do Fernando em 29/10)
- **Data:** 2026-10-29
- **Issue:** [#356](https://github.com/ahrenatechnology/ahrena-console/issues/356)
- **Substitui:** no item 6 da [0001](0001-github-consulta-cache.md), duas proibições: "laço de aquecimento" e "leitura de todas as organizações na partida", e a frase da emenda do #341 "nada de aquecimento nem de leitura na partida". O resto do item 6 vale: as chamadas passam todas pela fila única, até 4 ao mesmo tempo (`GITHUB_CALL_LIMIT`), e a tela lê só o que vai mostrar. O resto da 0001 também vale: consultas rasas, TTLs, leitura velha por até 24 h e a pausa por limite.

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
3. **As rotas não esperam.** `/api/adrs` e `/api/pdrs` servem o snapshot e não disparam montagem para os repositórios que o job cobre; `/api/project` serve o quadro guardado, de qualquer idade até 24 h, com `stale` quando o job perdeu uma rodada (duas vezes o TTL, 4 min). No próprio TTL ainda não: o job relê 2 min depois do fim da última rodada, e o quadro sadio apareceria velho por alguns segundos a cada ciclo. Só a primeira leitura de todas, com o banco vazio, espera o GitHub.
4. **Atualizar** (`?refresh=1`) continua forçando a releitura daquela fonte, com o mínimo de 30 s da 0001.
5. **Status** em `GET /api/github/sync`: cada passo com a última rodada, a próxima, a duração e o último erro.

## Orçamento

Por pessoa, com o núcleo ligado, com ou sem tela aberta. Os pontos são do limite primário do GraphQL (5.000 por hora); as leituras REST têm um limite próprio, também de 5.000 por hora, e um 304 não conta nele.

| Passo | Por rodada | Rodadas por hora | Conta de 206 repositórios, Project de até 100 itens | Conta grande: 500 repositórios, Project de 200 itens |
| --- | --- | ---: | ---: | ---: |
| `project` | cerca de 3 pontos por página de 100 itens | 30 | 90 | 180 |
| `decisions`: lista de repositórios da conta | a montagem da 0001 (Repositórios): 1 por página de 100, 1 por lote de 25 nas contagens, 1 do resumo | 4 | 4 × 13 = 52 | 4 × 26 = 104 |
| `decisions`: varredura de ADRs e PDRs | 1 por lote de 20 repositórios | 4 | 4 × 11 = 44 | 4 × 25 = 100 |
| `decisions`: conteúdo | só os arquivos novos dos repositórios com push (blob por `oid`, guardado) | 4 | poucos pontos | poucos pontos |
| **Total de GraphQL** | | | **cerca de 190 por hora (3,8%)** | **cerca de 390 por hora (7,8%)** |
| REST, da montagem da lista | até 60 leituras (estatísticas e runs dos 30 repositórios com push mais recente, com ETag) | 4 | até 240 (4,8%) | até 240 (4,8%) |

A lista de repositórios entra porque a varredura de decisões precisa dela, e a validade de 60 s da lista já passou a cada 15 min. Com a tela Repositórios aberta, essa montagem aconteceria de qualquer forma.

Comparação: a 0001 estimava cerca de 120 pontos por hora com a tela de trabalho aberta. Agora o custo é fixo: abrir a tela dez vezes não custa nada a mais, e ficar com o núcleo ligado sem tela aberta custa o mesmo que com ela aberta.

## Alternativas consideradas

- **Guardar o snapshot no SQLite e reler por trás quando uma tela lê, sem timer.** É o que a lista de repositórios já faz (0001, Repositórios, item 1). Resolve o reinício (a tela abre com o snapshot) e não chama o GitHub quando ninguém olha. Perdeu porque a primeira tela depois de um tempo parado mostra dado de horas atrás e troca na frente da pessoa: a remontagem das decisões leva de 20 a 30 s na conta de 206 repositórios. O pedido do Fernando (29/10) foi um sync em background, com as telas lendo só do banco local. A parte do snapshot desta alternativa foi adotada (item 2); o que perdeu foi disparar a leitura só quando alguém lê.
- **Webhooks.** O núcleo local não tem URL pública (0001, opção 4). No hub da AWS (7.9) os webhooks continuam sendo o caminho, e o núcleo local passa a ler do hub em vez de rodar este job.

## Consequências

- O núcleo lê o GitHub mesmo sem tela aberta: o custo deixa de ser zero quando ninguém olha. São cerca de 190 pontos por hora na conta de 206 repositórios e cerca de 390 numa conta grande. No teto do código (500 repositórios e Project de 500 itens, 5 páginas) chega a cerca de 650 (13%). Ver Orçamento.
- A primeira partida, com o banco vazio, ainda espera o GitHub na primeira tela.
- Um repositório aberto fora da lista da conta (pela URL) continua sendo lido sob demanda, como hoje.
