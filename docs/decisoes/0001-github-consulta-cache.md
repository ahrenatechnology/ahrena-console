# 0001 · Consulta ao GitHub: enxuta, com cache e busca sob demanda

- **Status:** aceita
- **Data:** 18/10/2026
- **Spike:** #40 (backlog 5.1), parte do épico #6
- **Afeta:** 5.2, 5.3, 4.3, 7.9 e a porta de armazenamento (#11)

## Contexto

O núcleo de teste (`spikes/nucleo-teste/server.mjs`) monta a árvore iniciativa → épico → item com uma consulta GraphQL aninhada: cada issue da busca traz os pais, as filhas e, de cada uma, PRs e CI. Essa consulta, somada a um laço de aquecimento que repetia as leituras, bateu no limite secundário do GitHub. O paliativo de hoje é uma pausa de 2 minutos, cache em disco em `~/Library/Caches/ahrena-console`, leitura velha com `stale: true` e uma consulta menor (30 issues, pai em 2 níveis, 15 filhas).

A pergunta do spike: quanto custa cada formato, se vale buscar as filhas só ao expandir, se ETag ou webhooks reduzem chamadas, qual TTL usar e como isso entra na porta de armazenamento e no hub.

## Limites do GitHub que importam

- **Primário (GraphQL):** 5.000 pontos por hora por pessoa. O custo de uma consulta vem do número de nós que ela pode devolver (`first` × `first` …), dividido por 100, com mínimo de 1.
- **Secundário:** até 100 requisições simultâneas, 2.000 pontos por minuto no GraphQL e 900 no REST (cada leitura conta 1), e no máximo 90 s de CPU do servidor a cada 60 s. Consultas aninhadas pesadas estouram pelo tempo de CPU antes de estourar os pontos.
- **Por consulta:** no máximo 500.000 nós.

## Medições

Feitas em 18/10/2026 com `spikes/github-consulta/medir.mjs`, contra este repositório (65 issues abertas) e o Project 3 (65 itens). Foram 23 chamadas em série, com 3 s de pausa. A estimativa usa `rateLimit(dryRun: true)`, que calcula o custo sem executar a consulta. Resultado bruto em [`medicoes.json`](../../spikes/github-consulta/medicoes.json).

### GraphQL

| Formato | O que traz | Nós possíveis | Custo (pontos) | Tempo | Resposta |
| --- | --- | ---: | ---: | ---: | ---: |
| Antiga | 30 issues + 3 níveis de pai + 25 filhas + 15 netas, cada uma com PR e CI | 133.230 | **614** (só estimada) | — | — |
| Atual (paliativo) | 30 issues + 2 níveis de pai + 15 filhas, com PR e CI | 5.880 | **27** | 1,7 s | 40 KB |
| Enxuta com PR | 30 issues com PR e CI, e a chave do pai | 330 | **2** | 0,8 s | 17 KB |
| Enxuta | 30 issues, chave do pai e resumo das filhas (`subIssuesSummary`) | 30 | **1** | 0,8 s | 14 KB |
| Filhas de um card (ao expandir) | até 50 filhas, com PR e CI | 550 | **3** | 0,5 s | 2 KB |
| Delta | issues mudadas desde a última leitura (`updated:>=`) | 30 | **1** | 0,5 s | 0,1 KB |
| Project, completo | 100 itens, todos os campos de seleção, PR e CI | 2.500 | **4** | 1,3 s | 25 KB |
| Project, só Status | 100 itens, `fieldValueByName(name: "Status")`, tipo e pai | 100 | **1** | 1,1 s | 22 KB |

A estimativa e o custo real bateram em todos os formatos executados.

### REST com ETag

| Recurso | 1ª leitura | Leitura condicional (`If-None-Match`) |
| --- | --- | --- |
| `GET /repos/{o}/{r}/issues` (65 itens) | 200 | 304, sem corpo |
| `GET /repos/{o}/{r}/issues/6/sub_issues` | 200 | 304, sem corpo, 0 do limite |
| `GET /repos/{o}/{r}/events` | 200 | 304, sem corpo |

O GitHub documenta que um 304 com autenticação não consome o limite primário. A medição confirmou isso no caso das sub-issues; nos outros dois o contador andou 1, mas o mesmo token estava em uso por outras sessões ao mesmo tempo, então a diferença não é atribuível. O 304 continua contando no limite secundário: é uma requisição como outra qualquer.

## Opções

1. **Manter a consulta aninhada, com cache maior.** 27 pontos por leitura e 1,7 s de servidor; a cada 3 minutos dá 540 pontos por hora por pessoa só na árvore. Continua frágil: basta crescer o número de issues para voltar ao formato antigo.
2. **Consulta enxuta + filhas ao expandir + delta.** A lista e o kanban vêm de consultas de custo 1; a árvore é montada no cliente a partir da chave do pai; as filhas, PRs e CI de um card vêm quando ele é aberto; a atualização é por delta.
3. **REST com ETag para tudo.** O 304 poupa o limite primário e a banda, mas o REST não traz tipo de issue, pai e Status do Project numa chamada só; seriam várias chamadas por tela, e cada uma conta no secundário.
4. **Webhooks.** Eliminam a releitura periódica, mas exigem uma URL pública que recebe eventos. O núcleo local não tem; o hub na AWS tem.

## Decisão

**Opção 2 no núcleo local, e a opção 4 no hub (7.9).** ETag só onde já se usa REST.

1. **Leitura inicial em consultas rasas, de custo 1.** O kanban (5.3) lê o Project com `fieldValueByName(name: "Status")`, 100 itens por página. A hierarquia (5.2) lê as issues com a chave do pai e o `subIssuesSummary`, sem aninhar pais nem filhas. Pais citados que não vieram na busca entram numa única consulta por lote (`nodes(ids:)` ou apelidos), não um nível por vez.
2. **Filhas, PRs e CI ao expandir.** Abrir um card faz uma consulta de custo 1 a 3 e guarda o resultado por card. O card fechado mostra só o resumo (`3/5 concluídas`) que já veio na leitura rasa. PR e CI na lista ficam para os itens em andamento, com a consulta "enxuta com PR" (custo 2).
3. **Atualização por delta.** Com a tela aberta, a cada 60 s uma busca `updated:>=<última leitura>` (custo 1) e a mescla pelo `updatedAt` mais novo. O delta não vê mudanças só de campo do Project (mover o Status não muda o `updatedAt` da issue), então o Project é relido pelo TTL.
4. **Cache com TTL e leitura velha.** Cada chave guarda valor, `fetchedAt` e `etag`. Dentro do TTL não há chamada; fora dele, uma só por chave, mesmo com várias telas pedindo; se o GitHub falhar, serve o último valor com `stale: true` e o motivo.

   | Chave | TTL | Por quê |
   | --- | --- | --- |
   | Project (Status dos cards) | 2 min | é o que muda pela mão do time; o delta não vê |
   | Issues abertas (rasa) | 5 min, com delta a cada 60 s | o delta cobre o intervalo |
   | Filhas de um card | 10 min | estrutura muda pouco; o delta do filho invalida |
   | PR e CI de um card aberto | 60 s | CI muda rápido, mas só para o card que se está olhando |
   | Lista de projetos e campos | 1 h | quase não muda |

   O cache em disco vale entre reinícios e é servido como velho por até 24 h; depois disso a tela mostra "sem dados" em vez de dado antigo demais.
5. **Invalidação.**
   - **Escrita do próprio console** (mover card em 5.3): a mutação devolve o item, e o cache é atualizado na hora (`patch`), sem reler.
   - **Delta:** issue mais nova substitui a do cache; se mudou de pai, a árvore se refaz.
   - **Botão de atualizar:** força a releitura, com intervalo mínimo de 30 s.
   - **Limite atingido** (403/429): pausa pelo `retry-after`, senão até o `x-ratelimit-reset`, senão 2 min, e serve o cache.
6. **Proibido:** laço de aquecimento, leitura de todas as organizações na partida e consultas em paralelo ao GitHub. A primeira tela lê só o que vai mostrar.

**Orçamento resultante, por pessoa, com a tela aberta:** Project a cada 2 min (30/h) + delta a cada 60 s (60/h) + algumas expansões (cerca de 30/h) ≈ 120 pontos por hora, contra 540 do paliativo e milhares do formato antigo. É menos de 3% do limite primário, e nenhuma consulta passa de 1 s de servidor.

**Webhooks e ETag.** O núcleo local não recebe webhooks: não tem URL pública, e abrir uma por túnel não é algo para o time instalar. ETag não existe no GraphQL; fica para as poucas leituras REST (por exemplo, `sub_issues`), pelo adaptador, sem mudar a interface.

## Como se encaixa nas portas

- **Porta de armazenamento (#11).** O cache é mais um uso dela: `get(chave)` e `set(chave, { valor, fetchedAt, etag })`. No SQLite, uma tabela `github_cache(chave, valor_json, buscado_em, etag)`; o JSON em `~/Library/Caches` deixa de existir. O módulo `cache.mjs` do spike usa exatamente essa interface, com um adaptador em memória e outro em disco.
- **Porta de fonte do trabalho.** O GitHub fica atrás de uma porta com três operações: `listarRaso(filtro, desde?)`, `filhas(chave)` e `detalhe(chave)` (PR, CI, review). O adaptador local chama o GitHub com o token do `gh`; o adaptador remoto lê do hub.
- **Hub na AWS (7.9).** Um GitHub App instalado na organização recebe os eventos `issues`, `sub_issues`, `pull_request`, `pull_request_review`, `check_suite` e `projects_v2_item` (este só existe em nível de organização) num endpoint Lambda, que valida a assinatura e atualiza as mesmas chaves no DynamoDB, com TTL nativo. Uma varredura por delta a cada 15 min (custo 1) cobre eventos perdidos. O GitHub é lido uma vez para o time, e os núcleos locais leem o hub: com o hub configurado, o núcleo local não chama o GitHub.

## O que muda no backlog

- **5.2 · Hierarquia.** Deixa de ser "uma consulta que traz a árvore" e passa a ser: leitura rasa com chave do pai e resumo das filhas, montagem da árvore no núcleo, filhas e PR/CI ao expandir, delta a cada 60 s, tudo pelo cache sobre a porta de armazenamento (#11). Critério novo: a leitura inicial custa no máximo 2 pontos e nenhuma consulta passa de 10 pontos.
- **5.3 · Kanban do próprio projeto.** Lê o Project com `fieldValueByName(name: "Status")` (custo 1 por 100 itens), relê a cada 2 min, e mover um card faz a mutação e atualiza o cache na hora, sem releitura. Critério novo: mover um card não dispara leitura.
- **4.3 · Aba Trabalho.** O card fechado mostra o resumo das filhas; o aberto mostra as filhas, PRs e CI, com indicação de carregando e de dado velho.
- **7.9 · GitHub pelo hub.** Ganha o desenho acima: GitHub App, webhooks, mesmas chaves no DynamoDB e varredura de reconciliação.

## Consequências

- O custo deixa de crescer com a profundidade da árvore; cresce com o número de cards abertos.
- Expandir um card pela primeira vez tem uma espera de cerca de 0,5 s. Depois, sai do cache.
- Mudanças só de Status no Project aparecem em até 2 min para quem não fez a mudança. Quem mudou vê na hora.
- O núcleo de teste não muda: é descartável. A decisão vale para o código de 5.2 e 5.3.
