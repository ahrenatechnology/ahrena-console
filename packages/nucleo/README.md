# Núcleo

Modelo de dados do Ahrena Console, a porta de armazenamento e o adaptador SQLite. Item 1.1 do [backlog](../../docs/backlog-0.0.1.md).

TypeScript rodado direto pelo Node 24 (type stripping), sem build e sem dependências. O SQLite é o `node:sqlite` embutido.

## Peças

| Arquivo | O quê |
| --- | --- |
| [src/model.ts](src/model.ts) | Sessão, conta do Claude, agente, evento, uso de tokens e preço, com os validadores |
| [src/storage-port.ts](src/storage-port.ts) | A porta: a única coisa de que o resto do núcleo depende |
| [src/pricing.ts](src/pricing.ts) | Preço pelo padrão mais longo e custo estimado, com modificadores e "sem preço" explícito |
| [src/custo/](src/custo/) | Tabela de preços editável, piso da compactação e agregações de custo (item 1.6, seção abaixo) |
| [src/adapters/sqlite/](src/adapters/sqlite/) | Adaptador SQLite e as migrações do esquema |
| [src/ingest/hooks/](src/ingest/hooks/) | Receptor dos hooks do Claude Code e a configuração de hooks do plugin (item 1.4) |
| [test/storage-contract.ts](test/storage-contract.ts) | Contrato da porta. Todo adaptador roda a mesma bateria |
| [src/ingest/historico/](src/ingest/historico/) | Importação do histórico de `~/.claude/projects` (item 1.2) e o seguidor em tempo real (item 1.3) |
| [src/github/](src/github/) | Trabalho do GitHub: hierarquia, PR, CI e review por item, e o kanban de um Project (seção abaixo) |
| [src/simulador/](src/simulador/) | Simulador de sessões, com modo caos (ver abaixo) |
| [src/estados/](src/estados/) | Máquina de estados: transições, vigia, sonda de processo e leitura do inbox (item 1.5) |
| [src/decisoes/](src/decisoes/README.md) | Decisões da sessão: modelo, porta, captura pelos hooks e pelo transcript, e a cadeia de substituição (#99) |
| [src/api/](src/api/) | API local mínima para o painel lateral (seção abaixo) |
| [src/mcp/](src/mcp/README.md) | Servidor MCP em `/mcp` e por stdio: `sessions_needing_attention` e `fleet_overview` (#21) |
| [src/mudancas/](src/mudancas/) | Cursor de mudanças e long polling: `aguardarMudancas`, `GET /api/mudancas` e a ferramenta MCP `wait_for_changes` (item 2.4, seção abaixo) |
| [src/plano/](src/plano/) | Plano da sessão: TodoWrite, TaskCreate, TaskUpdate e `update_plan`, com o dono de cada passo (item 1.9, seção abaixo) |
| [src/historico/](src/historico/) | Histórico das sessões encerradas: por dia no fuso da máquina, com busca, custo e a ligação depois do /clear (#33, C15) |
| [src/dono/](src/dono/README.md) | Núcleo com dono único: a trava `~/.ahrena-console/nucleo.json`, a adoção e a saída quando o pai some (#86) |

## API local

Um servidor HTTP em `127.0.0.1:4720` que roda o importador, o seguidor, o receptor de hooks e a máquina de estados, e responde só o que o painel lateral ([plugins/ahrena-console](../../plugins/ahrena-console/)) precisa.

```bash
npm run api                              # histórico real, banco em ~/.ahrena-console/nucleo.sqlite
npm run api -- --demo --cenario p4       # banco em memória com um cenário do painel (P1 a P7), dados sintéticos
                                         # o Detalhe da /ui: /ui/sessoes/sim-detalhe-pedidos (pede permissão) e /ui/sessoes/sim-painel-esta
npm run api -- --help
```

**Um núcleo por máquina** ([src/dono/](src/dono/README.md), #86). Se já há um de pé, `npm run api` o adota: imprime a porta e a versão e sai com 0. Para o app, a extensão e o terminal:

```bash
npm run nucleo -- status|subir|parar     # subir: adota ou sobe em segundo plano; --pai <pid>, --substituir, --json
```

| Rota | O quê |
| --- | --- |
| `GET /api/painel/<sessão>` | Tudo o que o painel desenha, num pedido: a sessão (status, motivo, faixa, turno, conta), contexto, custo, tokens, background, plano atual e os planos da sessão, subagentes, sessões filhas, trabalho pelo branch e "precisam de você" com a família, a máquina e a divisão por conta. Contrato em [src/api/tipos.ts](src/api/tipos.ts) |
| `GET /api/mural` | O "Mural ao vivo" (#34, wireframe C2): um card por sessão aberta nesta máquina, em todas as contas, e a contagem para o seletor Todas / Esperando / Ativas. Formato e critério na seção [Mural](#mural-ao-vivo) |
| `GET /api/overview` | Saúde |
| `GET /api/carga` | Contadores para `scripts/medir-carga.mjs` |
| `POST /api/hooks` | O receptor de hooks, na mesma porta |
| `POST /mcp` | O servidor MCP ([src/mcp](src/mcp/README.md)); `npm run mcp` dá o mesmo por stdio |
| `GET /api/mudancas?desde=<cursor>&espera=<s>` | Long polling: responde quando algo muda ou no timeout (item 2.4, seção abaixo) |
| `GET /api/historico?antes=<AAAA-MM-DD>&dias=<N>&busca=<texto>` | As sessões encerradas por dia, do mais recente ao mais antigo, com o detalhe de cada uma e a anterior e a seguinte pelo /clear; `proximo` vai como `?antes=` na próxima página. `dias` padrão 7, máximo 31; `busca` até 100 caracteres; inválido dá 400. No `--demo`, o P4 traz oito encerradas em vários dias. Contrato em [src/api/historico.ts](src/api/historico.ts) (#33) |
| `GET /ui` e `/ui/*` | A interface do console: a janela do app desktop e, depois, o artefato ([ui/](ui/README.md), #26) |

`?conta=`, `?org=`, `?local=`, `?modelo=` e `?cwd=` são o que o painel lê da própria sessão. Pedido com `Origin` ou com `Host` de fora dá 403 (decisão 0003); só um `GET` da própria `/ui` (`Origin` igual a `http://<Host>`) passa.

| Arquivo | O quê |
| --- | --- |
| [painel.ts](src/api/painel.ts) | Monta a resposta: estado e faixa pela máquina de estados, custo e tokens pelo item 1.6, plano atual e a lista dos planos da sessão (item 1.9 e #131, com o dono de cada passo), família, conta e "precisam de você" |
| [mural.ts](src/api/mural.ts) | Monta o mural (#34): as sessões abertas, na ordem, cada card pela mesma leitura do painel (`leituraDaSessao`) |
| [atencao.ts](src/api/atencao.ts) | Os níveis de atenção (#140): o que bloqueia a sessão até você agir (permissão, pergunta, plano, decisão pedida, erro) e o que é só a sua vez; os PRs aguardando aprovação saem do trabalho por branch |
| [resumo.ts](src/api/resumo.ts) | Turno, plano (`TodoWrite`, só quando a sessão não tem plano gravado), pergunta, pedido de permissão, erro e contexto, lidos dos eventos de forma incremental |
| [trabalho.ts](src/api/trabalho.ts) | Issue e PR pelo nome do branch, com o cache do GitHub (decisão 0001), sem o pedido esperar o GitHub |
| [indice-desktop.ts](src/api/indice-desktop.ts) | Índice do Claude Desktop: título, branch, sessão mãe (`spawnedFrom`), esforço (`effort`), arquivada e conta pela pasta, relido só quando muda |
| [contas.ts](src/api/contas.ts) | A conta de cada sessão pela ordem da decisão 0006 e os rótulos de `~/.ahrena-console/contas.json` |
| [historico.ts](src/api/historico.ts) | `GET /api/historico`: lê o pedido e responde a página de [src/historico/](src/historico/) (#33) |
| [servidor.ts](src/api/servidor.ts) | As rotas |
| [ui.ts](src/api/ui.ts) | Serve a pasta [ui/](ui/README.md) em `/ui`, com a política de conteúdo que só deixa a página falar com o núcleo |

**Consumo.** Nada varre transcripts por pedido: o seguidor importa só o que mudou (na API, a varredura de reserva é a cada 30 s, `--varredura`; o `fs.watch` avisa cada escrita na hora), o resumo de cada sessão lê só os eventos novos desde o último pedido, o custo é recalculado no máximo a cada 30 s, "precisam de você" é uma consulta por índice (esperando ou com erro) guardada por 4 s para todos os painéis, e o índice do Desktop e o arquivo de rótulos são conferidos no máximo a cada 30 s. O GitHub e o git respondem por trás, com o último dado no pedido. Para medir:

```bash
node scripts/medir-carga.mjs --rota painel --sessoes 20 --abertos 1
```

### Mural ao vivo

`GET /api/mural` (#34) responde `{ versao: 1, geradoEm, contagem: { todas, esperando, ativas }, cards }` (contrato `Mural` e `CardDoMural` em [src/api/tipos.ts](src/api/tipos.ts)). Cada card traz id (leva a `/ui/sessoes/<id>`), título, projeto (o nome da pasta), branch, status, estado, motivo, urgente, desde, a atividade (a linha do meio: o que pede, o erro, "terminou sem erro" ou o que está fazendo), modelo, esforço, agentes (`ativos`/`total`, o principal mais os subagentes), custo (`usd: null` é "sem preço"), plano (`feitos`/`total`/`atual`) e contexto (`pct`/`usados`/`limite`/`rotulo`); plano e contexto são `null` quando a sessão não tem.

- **Aberta:** não arquivada no Claude Desktop, e `active` (o que inclui esperando, delegando e em background) ou `error` sem `endedAt`; a `completed` (ou o erro já encerrado) só enquanto a última atividade estiver dentro do `abandonoMs` do vigia (180 min), o card "Terminou sem erro": fica pelo mesmo tempo que uma sessão parada leva para ser dada como abandonada. `abandoned` nunca entra.
- **Ordem e urgência:** `urgente` é a espera `notification` ou `interrupted` e também o erro, como no "precisam de você" do painel. Primeiro as que precisam de você (`waiting` e `error`), as urgentes antes, e entre elas o pedido mais recente; depois as outras, pela atividade mais recente.
- **Contagem:** `esperando` são as `waiting` e `error`; `ativas`, as `active`, `delegating` e `background`; as concluídas só contam em `todas`.
- **Esforço:** o `effort` do índice do Claude Desktop (`local_*.json`, o mesmo arquivo que já dá título e branch); sessão só de terminal ou fora do índice, `null`.
- **Branch:** o do Desktop ou da metadata e, sem eles, o do git pelo trabalho por branch, que responde do cache (o primeiro pedido não espera o git).
- **Consumo:** o custo sai do mesmo cache do painel (por sessão, a cada 30 s ou quando ela muda), os eventos pelo resumo incremental, e a resposta inteira fica guardada por 2 s, com pedidos ao mesmo tempo esperando a mesma montagem. Duas consultas por índice (vivas e as concluídas recentes); nada varre transcripts.

O transcript passou a guardar a entrada de `AskUserQuestion` (a pergunta) e das ferramentas do plano (`TodoWrite`, `TaskCreate`, `TaskUpdate`, `update_plan`), cortada como os outros textos; a de nenhuma outra.

## Importação do histórico

`importHistory({ storage })` lê os transcripts JSONL de `~/.claude/projects` e grava sessões, agentes, eventos e uso de tokens pela porta. Entram o arquivo principal (`<sessão>.jsonl`) e os subagentes nos dois layouts: `<sessão>/subagents/agent-<id>.jsonl` (com o `.meta.json`, que dá tipo, descrição e quem lançou) e o antigo `agent-<id>.jsonl` na pasta do projeto. `<sessão>.superseded-<n>.jsonl` é cópia antiga do principal e fica de fora.

- **Ids estáveis:** sessão é o `sessionId`; agente principal `<sessão>:main`; subagente `<sessão>:<agentId>`; evento `jsonl:<uuid da linha>`.
- **Sem contar duas vezes:** o streaming grava a mesma mensagem em várias linhas, com uso parcial e final. O uso é recalculado a partir dos eventos da sessão, deduplicado por `message.id`, ficando a entrada final. Mensagens `<synthetic>` não têm custo. Escrita de cache vai para 5 min ou 1 h pelo `cache_creation`; sem ele, conta como 5 min.
- **Retoma de onde parou:** o cursor de cada arquivo (bytes lidos, tamanho, mtime e os 64 bytes antes do cursor) fica em `metadata.importacao` da sessão ou do subagente e é gravado por último. Arquivo sem mudança não é relido; linha pela metade espera a próxima rodada; arquivo reescrito, menor ou maior, é relido do início (`filesRewound`), e os ids absorvem a repetição.
- **Não decide estado:** sessão nova nasce `completed` com `source: 'import'`. Sessão que já existe (dos hooks) mantém status, espera e `metadata`. A máquina de estados é o item 1.5; o custo, o 1.6.

`importHistory({ storage, files })` importa só os arquivos dados, sem varrer a raiz.

## Seguir em tempo real

`followTranscripts({ storage })` observa `~/.claude/projects` e importa só o que mudou, pelo mesmo importador.

```ts
import { followTranscripts } from '@ahrena-console/nucleo';

const follower = followTranscripts({ storage, onError: console.error });
await follower.start();  // importação completa e, daí em diante, só o que mudar
await follower.sync();   // varre agora, sem esperar o intervalo
await follower.stop();   // espera a rodada em andamento; pode chamar start() de novo
```

- **Dois avisos:** `fs.watch` recursivo dá o arquivo que mudou em poucas centenas de ms (`debounceMs`, padrão 150). A varredura a cada `scanIntervalMs` (padrão 5 s) é a reserva, porque o watch perde avisos no macOS e não existe enquanto a raiz não existe; ela também religa o watch.
- **Custo baixo:** o seguidor guarda tamanho e mtime de cada arquivo em memória e só entrega ao importador o que mudou. Rodada sem mudança faz só `stat`, sem ler arquivo nem consultar o banco: com 300 sessões, poucos ms.
- **Pastas novas:** aviso de uma pasta que ainda não tem transcript conhecido (projeto, sessão, `subagents`) pede uma varredura, para achar o subagente novo mesmo que o arquivo dele não avise.
- **Sem sobreposição:** as rodadas são em fila. Se uma falhar, `onError` recebe o erro e os arquivos dela voltam a ser tentados na próxima.

## Custo e tokens

Item 1.6. Tudo é **estimativa**: não há leitura de fatura, e todo resultado leva `estimate: true` / `estimativa: true`.

- **Tabela de preços:** o padrão fica versionado em [precos-padrao.ts](src/custo/precos-padrao.ts), com a fonte (a página pública de preços da Anthropic) e a data da consulta. O usuário sobrescreve pela porta: `definirPreco(porta, preco)` grava, `restaurarPadrao(porta, pattern?)` apaga a sobrescrita. `tabelaDePrecos(porta)` devolve as linhas com a origem (`padrao` ou `usuario`) e o preço padrão que foi trocado; `precosVigentes(porta)` só os preços. Cada modelo casa pelo id e pelo id com data, sem padrão aberto, para um modelo novo não herdar o preço de outro.
- **Cache:** escrita de 5 min e de 1 h e leitura com preço próprio por modelo; sem preço informado, valem os multiplicadores 1,25x, 2x e 0,1x do input.
- **Modificadores** (em [pricing.ts](src/pricing.ts)): batch 0,5x, `inference_geo = us` 1,1x, fast pelo multiplicador do modelo (Opus 5.5, 5 e 4.8: 2x) e contexto longo do Haiku 5.5 (prompt acima de 100 mil tokens, 5x), todos acumulando. Busca na web a US$ 10 por mil. Web fetch não tem cobrança além dos tokens; execução de código é cobrada por hora de contêiner e fica de fora.
- **Sem preço:** modelo fora da tabela, ou em modo fast sem multiplicador conhecido, aparece como "sem preço" (`costUsd: null`, com o motivo), nunca como zero.
- **Piso depois da compactação:** `aplicarPiso(anterior, vivo)` move para o `baseline` o que a contagem viva perdeu, então `tokens + baseline` nunca diminui. A importação do histórico já grava o uso por ele.
- **Agregações:** `agregarCusto(porta, { desde, ate, fusoHorario, sessionIds })` devolve o total e as linhas por sessão, agente, modelo e dia; `custoDaSessao(porta, id)` é o atalho para uma sessão. A parte de cada agente e dia vem das mensagens do assistente gravadas como eventos, deduplicadas por `message.id`. O que o bucket tem além disso (o piso, uso gravado sem evento) entra sem agente, no dia da última atualização do bucket, para todos os agrupamentos somarem o mesmo total. Linha com parte sem preço soma só o que tem preço e lista em `semPreco` os modelos e tokens que ficaram de fora.

## Estados

A sessão persiste `active`, `completed`, `error` ou `abandoned`. `waiting` não é gravado: é uma camada sobre `awaitingInputSince`, com o motivo em `awaitingReason` (`notification`, `interrupted`, `stop`, `session_start`). `displayStatus()` devolve o que a interface mostra. As transições são da máquina de estados, em [src/estados/](src/estados/README.md), que também dá ao inbox os estados "delegando" e "esperando processo em background".

## Plano da sessão

Item 1.9. O plano é a lista de tarefas que o agente mantém enquanto trabalha, não a issue do GitHub (essa é o Trabalho). `getPlan(sessionId)` devolve o `SessionPlan`: os passos na ordem, cada um com texto, texto no gerúndio (`activeForm`), estado (`pending`, `in_progress`, `completed`) e dono, mais `done`/`total`, o passo atual (`currentStepId`, o primeiro em andamento) e a hora da última mudança (`changedAt`).

- **De onde vem:** dos hooks `PreToolUse` e `PostToolUse` (`ingestHook`) e do transcript (importador e seguidor), que chamam `atualizarPlano(porta, sessionId, eventos)` com os eventos que acabaram de gravar. O transcript guarda a entrada dessas ferramentas no evento (`tool_input`, curta) e o id da tarefa no resultado do TaskCreate (`taskId`).
- **Lista inteira:** TodoWrite e `update_plan` com `items` (de qualquer plugin: `mcp__<servidor>__update_plan`) reescrevem o plano. O passo de mesmo texto mantém o dono e a hora. Lista mais velha que a última mudança não volta o plano.
- **Incremental:** TaskCreate acrescenta um passo com id provisório (o próximo número), trocado pelo do resultado; TaskUpdate muda estado, texto e dono, e `deleted` tira o passo. `update_plan` com `advance`, `done` e `start` (posições a partir de 1) anda na lista que já existe.
- **`/clear`:** `SessionStart` com `source: clear` ou o prompt `/clear` do transcript esvazia o plano.
- **Dono:** o principal, por padrão; o subagente que criou ou pegou (`in_progress`) a tarefa; o `owner` do TaskUpdate; a sessão filha da `session` de um item do `update_plan`. A lista de TodoWrite ou `update_plan` de um subagente é dele e não troca o plano da sessão.
- **Sem contar duas vezes:** a mesma chamada chega pelo Pre, pelo Post e pelo transcript; vale a primeira, pelo `tool_use_id`. Resultado com erro desfaz a última chamada aplicada. O estado disso fica em `metadata.extracao`.

### Histórico dos planos

Issue #131. A sessão abre vários planos; cada um fica guardado como `PlanRecord`, com início, fim, passos, `done`/`total` e resultado: `current` (o aberto), `completed` (todos os passos feitos) ou `abandoned` (X de Y). A porta grava com `putPlanRecord` e lista com `listPlanRecords(sessionId)`, do mais recente para o mais antigo (migração 5, tabela `session_plan_history`).

- **A regra:** `separarPlano(anterior, novo, incremental)` em [historico.ts](src/plano/historico.ts). Plano novo quando a lista é trocada por outra com menos da metade dos passos em comum, ou quando o anterior terminou e vem passo novo por fazer (ou a mesma lista inteira de volta a pendente). Marcar, desmarcar, reordenar, acrescentar e renomear continuam no plano. Lista vazia (`/clear`, TodoWrite vazio) fecha o plano.
- **TaskCreate depois das tarefas feitas:** as tarefas antigas continuam na lista da ferramenta, mas são do plano anterior; o novo leva só as novas.
- **Plano gravado antes da #131:** vira o primeiro do histórico na próxima mudança. O estado fica em `metadata.historico`.
- **`wrap_up`:** no Claude Desktop, o fechamento do turno dá por feita a lista do `update_plan`. O `wrap_up` do principal marca os passos que faltam; sem isso, quase todo plano do Desktop ficava abandonado.
- **Sessões importadas antes:** a importação antiga não guardou a entrada das ferramentas do plano. Uma vez por banco, depois da importação inicial, a API refaz o plano e o histórico de cada sessão com os eventos gravados e os mesmos eventos relidos do transcript (`reconstruirPlano`, em [src/api/reprocessamento.ts](src/api/reprocessamento.ts)), e captura as decisões do transcript. A marca fica na tabela `reprocessamentos` (migração 6).

## Contas

A 0.0.1 acompanha várias contas do Claude ao mesmo tempo ([decisão 0006](../../docs/decisoes/0006-multiplas-contas.md)). A conta é `ClaudeAccount`, com id `<accountUuid>/<organizationUuid>`, e é um atributo da sessão: `Session.accountId` e a procedência em `Session.accountSource` (`env`, `config`, `transcript`, `desktop`, `profile`), os dois nulos na "Sem conta". A porta grava e lista as contas (`putAccount`, `getAccount`, `listAccounts`) e filtra as sessões com `listSessions({ accountIds })`, em que `null` na lista pede as "Sem conta".

A precedência fica em `accountSourceOverrides(nova, gravada)` e `applySessionAccount(sessao, contaId, fonte)`: uma fonte de ordem menor corrige uma maior, nunca o contrário, e a mesma ordem não troca a conta gravada. Quem resolve a conta (hooks, importador, perfis) usa essas funções em vez de decidir sozinho.

## Migrações

Cada mudança de esquema é uma migração nova no fim de `MIGRATIONS`. A versão aplicada fica em `PRAGMA user_version`; cada migração roda na própria transação e, se falhar, o banco fica na versão anterior.

## Trabalho do GitHub

Item 5.2: a árvore iniciativa → épico → item → plano, com o tipo de issue, o progresso das sub-issues e, por card aberto, os PRs vinculados com CI e review. Segue a [decisão 0001](../../docs/decisoes/0001-github-consulta-cache.md): nada de consulta aninhada.

```ts
import { createGithubWork, SqliteCacheStore } from '@ahrena-console/nucleo';

const work = createGithubWork({
  filter: 'repo:dono/repo is:issue is:open',
  store: new SqliteCacheStore(storage.db), // sem isto, cache em memória
});
const tree = await work.tree();        // leitura rasa + delta a cada 60 s
const card = await work.expand(key);   // filhas, PR, CI e review deste card
await work.tree({ force: true });      // botão de atualizar (mínimo de 30 s)
await work.patchNode(key, (n) => ({ ...n, title })); // escrita do console, sem reler
```

| Arquivo | O quê |
| --- | --- |
| [work.ts](src/github/work.ts) | Nó, detalhe (PR, CI, review), nível pelo tipo de issue e etapa do item |
| [tree.ts](src/github/tree.ts) | Montagem da árvore a partir da chave do pai, mescla pelo `updatedAt` e filtro do delta |
| [source.ts](src/github/source.ts) | Porta da fonte: `listShallow`, `nodes`, `children`, `detail` |
| [github-source.ts](src/github/github-source.ts) | Adaptador GraphQL, com o token do `gh` |
| [cache.ts](src/github/cache.ts) | Cache com TTL, leitura velha até 24 h, uma chamada por chave, pausa no limite e `patch` |
| [sqlite-cache.ts](src/github/sqlite-cache.ts) | Cache na tabela `github_cache` do banco do núcleo |
| [work-service.ts](src/github/work-service.ts) | `GithubWork`: o que o painel e o MCP usam |
| [project.ts](src/github/project.ts) | `GithubProject`: kanban de um GitHub Project por Status e mover um card |

Custo medido no repositório do console: leitura inicial 1 ponto (mais 1 se faltarem pais), filhas de um card 2, detalhe 1. As consultas são sempre em série. TTLs: lista 5 min com delta a cada 60 s, filhas 10 min, PR e CI do card aberto 60 s.

Nível: `Initiative` → iniciativa, `Epic` → épico, `User Story`, `Tech Task`, `Spike`, `Bug` → item, `Plan` → plano. Sem tipo, fica um nível abaixo do pai. Etapa do item: `a fazer`, `em andamento` (PR rascunho), `ci rodando`, `ci falhou`, `ajustes pedidos`, `em revisão`, `mergeado`, `concluída`.

Os testes usam respostas reais gravadas em `test/github/fixtures/respostas.json`. Para regravar (cerca de 4 chamadas, com pausa):

```bash
node test/github/gravar-fixtures.ts > test/github/fixtures/respostas.json
```

### Kanban de um Project

Item 5.3: os itens de um GitHub Project v2 em raias pelo campo Status, na ordem das opções do Project, e mover um card muda o Status no GitHub. O Project é configurável (dono e número, como na URL `.../orgs/dono/projects/3`); o deste repositório é o Project 3 da organização `ahrenatechnology`.

```ts
import { createGithubProject, GithubCache, SqliteCacheStore } from '@ahrena-console/nucleo';

const kanban = createGithubProject({
  project: { owner: 'ahrenatechnology', number: 3 }, // `field: 'Status'` é o padrão
  cache: new GithubCache({ store: new SqliteCacheStore(storage.db) }),
});
const board = await kanban.board();           // raias com os cards; TTL de 2 min
await kanban.board({ force: true });          // botão de atualizar (mínimo de 30 s)
const r = await kanban.move(card.itemId, lane.id); // mutação; devolve o quadro já atualizado
r.moved;                                      // { itemId, from, to }: de que raia para qual
```

Cada card traz também `milestone` (o título do marco), `subIssues` (`{ total, completed }`) e `pullRequest` (o PR que fecha a issue, ou o próprio PR, com `ci` e `review`), `null` quando não há. Os três são opcionais no tipo: um quadro guardado antes deles continua válido.

Pela decisão 0001: a leitura usa `fieldValueByName(name: "Status")`, 100 itens por página, e custa ~3 pontos por página com o marco, as sub-issues e o PR (estimado pela regra do GitHub; sem o PR, 1); mover é uma mutação (`updateProjectV2ItemFieldValue`) que devolve o item, e o cache é atualizado com ela, sem reler o Project. Itens sem Status ficam numa raia "Sem status", a primeira, como no GitHub; itens arquivados ficam de fora.

Ler e mover pedem o escopo `project` no token do `gh`. Sem ele, `move` e `board` lançam `ProjectPermissionError`, com a instrução `gh auth refresh -s project`; com o cache vazio, `board` lança `NoDataError` e o erro da fonte vem em `cause`. Opção ou item desconhecidos lançam `ProjectOptionUnknownError` e `ProjectItemUnknownError`, sem chamar o GitHub. Quando o GitHub limita, a mutação pausa as chamadas como as leituras, e o quadro continua saindo do cache.

A API local expõe o quadro em `GET /api/projeto` e `POST /api/projeto/mover` (ver [docs/kanban-do-projeto.md](../../docs/kanban-do-projeto.md#no-núcleo-80-wireframe-c11)); a `--demo` usa o Project falso do C11 (`ProjetoDoSimulador`, em `src/simulador/projeto.ts`).

Os testes usam a leitura real do Project 3 gravada em `test/github/fixtures/project.json` (uma chamada, sem mutação). Para regravar:

```bash
node test/github/gravar-project.ts > test/github/fixtures/project.json
```

## Simulador

Gera sessões, agentes e subagentes, eventos e uso de tokens plausíveis e grava pela porta, para testar e demonstrar o painel e o artefato sem dados reais. Item 6.4 do backlog.

```bash
npm run simular                            # 12 sessões das últimas 6 h, de uma vez, em simulacao.sqlite
npm run simular -- --caos --seed 42        # com falhas, reproduzível
npm run simular -- --caos --tempo-real --velocidade 60 --precos
npm run simular -- --help
```

| Opção | O quê |
| --- | --- |
| `--banco <arquivo>` | Banco SQLite de destino. Padrão `simulacao.sqlite` (ignorado pelo git) |
| `--seed <semente>` | A mesma semente com as mesmas opções grava os mesmos dados. Sem ela, uma é sorteada e exibida |
| `--sessoes <n>` | Número de sessões. Padrão 12 |
| `--duracao <min>` | Janela simulada. Padrão 360; o abandono precisa de pelo menos ~240 |
| `--caos` | Liga o modo caos |
| `--intensidade <0..1>` | Fração extra de sessões com caos, além de uma de cada tipo. Padrão 0.4 |
| `--tempo-real` | Grava cada operação na hora dela, em vez de tudo de uma vez. Ctrl+C para; o que foi gravado fica |
| `--velocidade <x>` | Em tempo real, minutos simulados por minuto de relógio. Padrão 30 |
| `--precos` | Grava preços **ilustrativos** para os modelos simulados que ainda não têm preço, para o custo aparecer |

**Lote** grava a janela inteira terminando agora: as sessões já aconteceram e as que começaram tarde ficam em andamento. **Tempo real** começa agora e corre `velocidade` vezes mais rápido; as datas gravadas acompanham o relógio.

O **modo caos** garante pelo menos uma sessão de cada falha:

| Roteiro | O que fica gravado |
| --- | --- |
| `travada` | `active` esperando input (`notification` com pedido de permissão, ou `interrupted`), e nada mais acontece |
| `erro` | `PostToolUseFailure` e a sessão em `error` |
| `abandono` | Para no meio de um comando e, 180 min depois, a sessão é gravada como `abandoned` |
| `estouro` | Dois picos de tokens que estouram o contexto de 200k; cada um gera `PreCompact` e move o uso para o piso (`baseline`) |
| `enxame` | De 8 a 14 subagentes em paralelo no mesmo turno |

Os estados são gravados como dados; as transições continuam sendo da máquina de estados (item 1.5).

Tudo é sintético: projetos inventados sob `/simulacao/`, nenhum nome de pessoa nem caminho real. Grava duas contas sintéticas (UUIDs do bloco `00000000-…`, pastas sob `/simulacao/`) e alterna as sessões entre elas, com procedência `env` numa e `config` na outra. Todo registro leva `metadata.simulado = true`, a sessão leva o `roteiro` e o medidor de contexto (`metadata.contexto`), e os ids começam por `sim-<hash da semente>`, então rodar a mesma semente de novo no mesmo banco sobrescreve em vez de duplicar.

Pelo código:

```ts
import { simular } from '@ahrena-console/nucleo/simulador';

const resumo = await simular(porta, { semente: 42, caos: true, modo: 'lote' });
```

`gerarCenario()` devolve só o roteiro, sem gravar; `agora` e `esperar` são injetáveis para testes.

## Testes

```bash
npm install   # só a devDependency do teste de contrato do MCP (o cliente oficial)
npm test
```

## Mudanças e long polling (item 2.4)

O que deixa as telas ao vivo sem polling curto: o artefato, cujo `watchTool` tem piso de 30 s (validação V2), o app de bandeja (decisão 0005) e o painel.

- **Cursor.** [cursor.ts](src/mudancas/cursor.ts): uma sequência em memória que avança a cada mudança relevante, com tipo (`sessao`, `estado`, `precisa-de-voce`, `plano`, `decisao`, `conta`), chave, sessão e conta. Guarda as últimas 1.024 numa fila; registrar não lê o banco. O cursor é opaco (`<geração>.<seq>`): cursor vazio, de antes do núcleo reiniciar ou mais velho que a fila volta na hora com `reiniciar: true` (releia tudo).
- **Espera.** `aguardarMudancas(cursor, { filtros, timeoutMs, signal })` responde na hora se já há novidade; senão segura até chegar uma que passe nos filtros (sessão, conta, tipo) ou até o timeout (padrão 25 s, máximo 110 s, abaixo dos ~130 s do app). Cada espera responde no mínimo 1 s depois de começar: com hooks chegando sem parar, quem faz long polling em laço acorda no máximo uma vez por segundo, e a rajada sai numa resposta só, uma vez por (tipo, chave). O cursor devolvido é sempre o de agora: as mudanças que os filtros deixaram de fora ficam para trás e não voltam num pedido seguinte com outros filtros. No máximo 256 esperas abertas; acima disso, `ErroDeLotacao` (503 no HTTP).
- **Fontes.** [fontes.ts](src/mudancas/fontes.ts): `comMudancas(storage, cursor)` embrulha a porta (`putSession`, `putPlan`, `putAccount`); `sessao` só é registrada quando muda um campo que as telas mostram (nome, status, pasta, modelo, fim, espera e motivo, conta), não a cada hook que só avança o `updatedAt`. Atividade nova (eventos) não é mudança por si: estado, plano e decisões têm os seus tipos. `decisoesComMudancas` a das decisões, e `aoMudarDaMaquina` vai no `aoMudar` da máquina de estados (`estado` e, quando entra ou sai do inbox, `precisa-de-voce`). A API (`cli.ts`) liga as três.
- **HTTP.** `GET /api/mudancas?desde=<cursor>&espera=<s>&sessao=<id>&conta=<id|sem-conta>&tipo=<tipo>` ([http.ts](src/mudancas/http.ts)). O cliente que fecha a conexão libera a espera; lotado, 503 com `Retry-After`.
- **MCP.** [mcp.ts](src/mudancas/mcp.ts): a ferramenta `wait_for_changes` no formato `Ferramenta` do [servidor MCP](src/mcp/README.md), registrada no `cli.ts` logo depois de `criarServidorMcp`. Argumentos `cursor`, `timeout` (segundos), `sessions`, `account` (rótulo, id ou `none`, como nas outras ferramentas) e `types`; saída `{ cursor, reset, timedOut, changes }`, com a conta como rótulo e cor, nunca o id. Ouve `ctx.sinal`: o cliente que desiste libera a espera. Contrato com o cliente oficial em [test/mudancas/contrato-sdk.test.ts](test/mudancas/contrato-sdk.test.ts).

**Consumo.** Parado, cada espera aberta é só um timer; nada varre o banco. Para medir, parado e com hooks sintéticos pelo receptor de verdade:

```bash
node scripts/medir-esperas.mjs --esperas 50 --segundos 60 --hooks-por-min 600
```
