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
| [src/states/](src/states/) | Máquina de estados: transições, vigia, sonda de processo e leitura do inbox (item 1.5) |
| [src/decisoes/](src/decisoes/README.md) | Decisões da sessão: modelo, porta, captura pelos hooks e pelo transcript, e a cadeia de substituição (#99) |
| [src/api/](src/api/) | API local mínima para o painel lateral (seção abaixo) |
| [src/mcp/](src/mcp/README.md) | Servidor MCP em `/mcp` e por stdio: `sessions_needing_attention` e `fleet_overview` (#21) |
| [src/mudancas/](src/mudancas/) | Cursor de mudanças e long polling: `aguardarMudancas`, `GET /api/changes` e a ferramenta MCP `wait_for_changes` (item 2.4, seção abaixo) |
| [src/plano/](src/plano/) | Plano da sessão: TodoWrite, TaskCreate, TaskUpdate e `update_plan`, com o dono de cada passo (item 1.9, seção abaixo) |
| [src/historico/](src/historico/) | Histórico das sessões encerradas: por dia no fuso da máquina, com busca, custo e a ligação depois do /clear (#33, C15) |
| [src/agent-config/](src/agent-config/) | A tela Agent Config: o que há nas pastas de configuração do Claude Code e a edição de uma skill, com backup (#63, seção abaixo) |
| [src/owner/](src/owner/README.md) | Núcleo com dono único: a trava `~/.ahrena-console/nucleo.json`, a adoção e a saída quando o pai some (#86) |
| [src/telemetry/](src/telemetry/) | Telemetria das máquinas: coletores do Mac e do Linux atrás de uma porta, amostras de 12 h no SQLite, alertas e `/api/machines` e `/api/telemetry` (#175, seção abaixo) |

## API local

Um servidor HTTP em `127.0.0.1:4720` que roda o importador, o seguidor, o receptor de hooks e a máquina de estados, e responde só o que o painel lateral ([plugins/ahrena-console](../../plugins/ahrena-console/)) precisa.

```bash
npm run api                              # histórico real, banco em ~/.ahrena-console/nucleo.sqlite
npm run api -- --demo --cenario p4       # banco em memória com um cenário do painel (P1 a P7), dados sintéticos
                                         # o Detalhe da /ui: /ui/sessoes/sim-detalhe-pedidos (pede permissão) e /ui/sessoes/sim-painel-esta
npm run api -- --help
npm run api -- --no-telemetry            # sem medir esta máquina (/api/machines e /api/telemetry dão 404)
```

**Um núcleo por máquina** ([src/owner/](src/owner/README.md), #86). Se já há um de pé, `npm run api` o adota: imprime a porta e a versão e sai com 0. Para o app, a extensão e o terminal:

```bash
npm run core -- status|start|stop       # start: adota ou sobe em segundo plano; --parent <pid>, --replace, --json
```

As rotas antigas, em português (`/api/painel/<sessão>`, `/api/sessao/<sessão>`, `/abrir/<local_…>`, `/api/atencao`, `/api/mudancas?desde=&espera=`, `/api/sessoes`, `/api/historico?antes=&dias=&busca=`, `/api/decisoes/<sessão>?escopo=`…), continuam respondendo como alias das novas, com a mesma resposta, até o mod publicado e o app instalado migrarem (issue #173, fase 1). O mapa fica num lugar só, [src/api/legacy-routes.ts](src/api/legacy-routes.ts).

| Rota | O quê |
| --- | --- |
| `GET /api/panel/<session>` (`?account=`, `?model=`, `?decisions=`) | Tudo o que o painel desenha, num pedido: a sessão (status, motivo, faixa, turno, conta), contexto, custo, tokens, background, plano atual e os planos da sessão, subagentes, sessões filhas, trabalho pelo branch e "precisam de você" com a família, a máquina e a divisão por conta. Contrato em [src/api/tipos.ts](src/api/tipos.ts) |
| `GET /api/wall` | O "Mural ao vivo" (#34, wireframe C2): um card por sessão aberta nesta máquina, em todas as contas, e a contagem para o seletor Todas / Esperando / Ativas. Formato e critério na seção [Mural](#mural-ao-vivo) |
| `GET /api/overview` | Saúde |
| `GET /api/load` | Contadores para `scripts/medir-carga.mjs` |
| `POST /api/hooks` | O receptor de hooks, na mesma porta |
| `POST /mcp` | O servidor MCP ([src/mcp](src/mcp/README.md)); `npm run mcp` dá o mesmo por stdio |
| `GET /api/changes?since=<cursor>&wait=<s>` | Long polling: responde quando algo muda ou no timeout (item 2.4, seção abaixo) |
| `GET /api/events?limit=&after=&before=&type=&session=&tool=&status=&search=&from=&to=` | O feed de atividade (#94): `{ events, cursor, older, options }`, cada evento `{ id, createdAt, type, status, tool, summary, session: { id, title, project }, agent: { id, name }, detail: { callId, input } }` (`agent.name` é `main`, o tipo do subagente ou `subagent`); `cursor` vai como `?after=` (ao vivo) e `older` como `?before=`. Inválido dá 400 citando o parâmetro. Contrato em [src/api/eventos.ts](src/api/eventos.ts) |
| `GET /api/sessions?status=&order=&direction=&page=&search=&dir=` | A tela Sessões (#28): `{ total, registered, page, perPage, pages, directories, items }`, cada item `{ id, title, status, reason, lastActivity, start, running, durationMs, agents, costUsd, cwd, account: { label, color } }`. `status` é `all`, `active`, `waiting`, `completed`, `error` ou `abandoned`; `order` é `activity`, `duration` ou `cost` (os valores antigos, `esperando`, `custo`…, continuam aceitos). Contrato em [src/api/sessoes.ts](src/api/sessoes.ts) |
| `GET /api/history?before=<AAAA-MM-DD>&days=<N>&search=<texto>` | As sessões encerradas por dia, do mais recente ao mais antigo: `{ days: [{ day, sessions }], next }`, cada sessão `{ id, title, project, model, status, start, end, durationMs, costUsd, previous, next }`, com a anterior e a seguinte pelo /clear (`{ id, title }`); o `next` da página vai como `?before=` na próxima. `days` padrão 7, máximo 31; `search` até 100 caracteres; inválido dá 400. No `--demo`, o P4 traz oito encerradas em vários dias. Contrato em [src/api/historico.ts](src/api/historico.ts) (#33) |
| `GET /ui` e `/ui/*` | A interface do console: a janela do app desktop e, depois, o artefato ([ui/](ui/README.md), #26) |
| `GET /api/machines` | As máquinas (#175, #176): `[{ id, label, state, reason, version, port, lastReadAt, alerts }]`, esta máquina (`local`) primeiro, depois as remotas do `machines.json`. `state` é `connected`, `unreachable` (com `reason` `port-closed` ou `no-response`) ou `incompatible-version`. Seção [Telemetria](#telemetria-das-máquinas) |
| `GET /api/telemetry?machine=<id>&hours=1\|12` | A telemetria de uma máquina (#175): `{ version, machine, hours, current, series, alerts }`. `machine` padrão `local`, `hours` padrão 1; inválido dá 400, máquina que não existe 404 |
| `GET /api/kanban?view=sessions\|agents&column=<id>&page=<n>` | O Kanban só leitura (#31): `{ view, perPage, columns }`, cada coluna `{ id, label, total, page, hasMore, items }`: as sessões (`active`, `waiting`, `completed`, `error`, `abandoned`) ou os agentes (`working`, `waiting`, `done`, `error`), 10 por página, a mais recente primeiro. O card de sessão é a linha da lista de Sessões mais `lastPrompt` e `model`; o de agente, `{ id, sessionId, main, name, description, status, reason, model, start, lastActivity, running, durationMs }`. Sem `column`, todas na página 1; com ela, só aquela, na `page` pedida. Os valores antigos (`sessoes`, `agentes`, `ativa`, `trabalhando`…) continuam aceitos; parâmetro inválido dá 400 citando o nome novo. Contrato e regras de status em [src/api/kanban.ts](src/api/kanban.ts) |
| `GET /api/decisions?groupBy=&state=&group=&q=` | A página Decisões da /ui (#103): `{ groupBy, state, q, counts: { current, branches, toConfirm, superseded30d, promoted }, groups }`, cada grupo `{ key, type, title, repo, folder, current, toConfirm, total, items, more }` com os cards de decisão. `groupBy` é `branch`, `family` ou `session`; `state` é `all`, `current` ou `to_confirm` (os valores antigos continuam aceitos). Contrato em [src/api/decisoes-ui.ts](src/api/decisoes-ui.ts) |
| `GET /api/sessions/<id>/decisions?scope=&state=&q=` | A aba Decisões do Detalhe: `{ session, scope, state, q, byScope, total, items, injection: { enabled, scope, decisions, tokens, text }, mcp: { tool, exists, call, response } }` |
| `POST /api/decisions/<id>/promote` | O "Promover a registro": `{ session }` devolve `{ draft: { path, markdown, hash, repo, canWrite, reason } }`, sem gravar; `{ session, confirm: true, path, hash }` grava e devolve `{ decision, path }` (201). O corpo antigo (`{ sessao, confirmar, caminho }`) continua aceito |
| `GET /api/project?refresh=1` e `POST /api/project/move` | O kanban do GitHub Project (#80, seção [Kanban de um Project](#kanban-de-um-project)): `{ project: { owner, number, title, url, field }, lanes: [{ id, name, color, cards }], milestones, total, fetchedAt, stale, reason, source }`, cada card `{ itemId, type, issueType, number, title, url, repo, state, milestone, subIssues: { done, total }, pr: { number, url, ci, review }, laneId }` (`ci` `ok \| failed \| running`, `review` `approved \| changes-requested \| pending`). Mover recebe `{ itemId, optionId }` e devolve `{ board, moved: { itemId, from, to } }`. Erros: `{ error, code, command?, variable? }`, com `code` `invalid`, `no-scope`, `rate-limited`, `unknown-lane`, `unknown-item`, `github-down`, `github-refused`, `off` ou `no-project` |
| `GET /api/analytics?tz=<IANA>` | A Visão geral do Analytics (#95, C12): `{ generatedAt, timeZone, today, since, until, accounts: [{ id, label, color }], numbers: { sessions: { total, active }, agents: { total, active }, tokens: { total, cachePct }, cost: { usd, days, unpriced, byAccount: [{ account, usd, unpriced }] }, events: { total, perSession } }, activity: { weeks, since, days: [{ day, events }] }, last30: { days: [{ day, sessions }], peak, total }, tokensByModel: [{ model, tokens }], tools: [{ name, uses }], weekday: [{ day, sessions }] }`; `weekday[].day` é `mon` … `sun`. `usd: null` é "sem preço"; `unpriced` lista os modelos fora da tabela. Fuso inválido dá 400 (`tz: …`). Contrato em [src/api/rota-analytics.ts](src/api/rota-analytics.ts) |
| `GET /api/analytics/cost?days=7\|30\|90&tz=<IANA>` | O Custo do Analytics (#32, C13): `{ generatedAt, timeZone, days, today, since, until, estimate, currency, accounts, todaySummary: { usd, sessions, byAccount }, period: { usd, dailyAverage }, cache: { pct }, unpriced: { models, totalTokens }, byDay: [{ day, usd }], peak, byModel: [{ model, usd, pct, totalTokens }], byProject: [{ project, usd }], byAccount: [{ account, label, color, usd, unpriced, byDay }] }`. Parâmetro inválido dá 400 citando `days:` ou `tz:`; a rota antiga `/api/analytics/custo` responde o corpo antigo, em português (#173) |
| `GET /api/repos?refresh=1` | Os repositórios da conta do GitHub (#104, C22), sempre 200 e sem esperar o GitHub: `{ state, updatedAt, error, account, summary: { organizations, repositories, withSessionsThisMonth, openPrs, prsAwaitingReview, openIssues, issuesClosedThisWeek, ci: { greenRate, runs, days } }, groups: [{ owner, type, repos }] }`, cada repo `{ owner, name, fullName, url, visibility, language, commits12, openIssues, openPrs, ci, sessions: { active, needYou, thisMonth }, lastPush }`. `state` é `ready`, `loading`, `no-github` ou `error`; `type` `org \| personal`; `visibility` `public \| private`; `ci` `ok \| failed \| running` ou `null`. A mudança `repos` da lista tem a chave `list` (a do repositório, `owner/repo`). Contrato em [src/api/repos-tipos.ts](src/api/repos-tipos.ts) |
| `GET /api/repos/<owner>/<repo>?period=30d\|90d\|1y&refresh=1` | As métricas de um repositório (#105, C23): `{ state, updatedAt, error, computing, period, repo: { fullName, url, visibility, ci, defaultBranch, stars, forks, watchers, release: { tag, at }, license }, tabs, lines: { total, inPeriod }, commits: { total, perWeek, weeks }, frequency: { weeks: [{ week, added, removed }], added, removed }, issues: { byType: [{ type, closed, open }], closed, open, medianTimeToCloseMs, sample: { read, total, truncated } }, prs: { merged, closedUnmerged, open, medianTimeToMergeMs, medianTimeToFirstReviewMs, medianSize, reviewRounds, agentShare, sample }, ci: { greenRate, runs, averageDurationMs }, languages: [{ name, bytes, share }], contributors: [{ login, commits, added, removed }], releases, releasesTotal, community, canWrite, traffic?, security? }`. `state` também pode ser `not-found`; `computing` lista as estatísticas que o GitHub ainda calcula (`commits`, `frequency`, `lines`, `contributors`). O ano antigo, `1a`, ainda é aceito; período inválido dá 400 (`period: um de 30d, 90d, 1y`) |
| `GET /api/dev-console?context=<id>` | O Dev Console (#177, decisão 0008 seção 4), derivado do GitHub (cache da 0001) e das sessões: placar, "depende de você" (as sessões que pedem permissão, perguntam, esperam um plano ou uma decisão, pararam num erro ou foram interrompidas, com a frase do `/api/attention`, e as decisões sugeridas sem resposta), fila de merge e não prontos com o motivo (`reason`, o de maior prioridade, e `reasons`, todos, nesta ordem: `draft`, `conflict`, `checking`, `ci-failing`, `changes-requested`, `behind`, `ci-running`, `no-ci`, `stacked`; `checking` é `mergeable` ainda `UNKNOWN`, relido no TTL dos PRs), quadro das issues em seis colunas (`todo`, `delegated`, `in-progress`, `in-review`, `blocked` pelas etiquetas `blocked` ou `bloqueada`, configuráveis, e `done`, fechada como concluída em 24 h) e mesclados nas últimas 24 h, e `decisionsToday` (as decisões vigentes tomadas hoje nas sessões do contexto, vivas ou encerradas hoje, #179), com `readAt`, `stale` e `truncated` por repositório (lista do GitHub maior que a página). Sem `context`, os contextos e a fila de todos. Contextos em `~/.ahrena-console/dev-console.json` (`owner/repo` sem diferença de caixa); sem ele, um por repositório com sessão nos últimos 7 dias ([src/dev-console/](src/dev-console/index.ts)) |
| `GET /api/agent-config?project=<abs>` | A tela Agent Config: raízes, resumo e as listas de skills, subagentes, comandos, memória, MCP, plugins, hooks e arquivos de configuração, e `backups` (a pasta dos backups) (#63, seção abaixo) |
| `GET /api/agent-config/skill?root=<id>&name=<nome>` | O `SKILL.md` de uma skill, com a `version` |
| `POST /api/agent-config/skill` | Cria ou troca o `SKILL.md` de uma skill, com backup antes; com `create: true`, só cria (409 se já existe) |

`?account=`, `?org=`, `?local=`, `?model=` e `?cwd=` são o que o painel lê da própria sessão. Pedido com `Origin` ou com `Host` de fora dá 403 (decisão 0003); só um `GET` da própria `/ui` (`Origin` igual a `http://<Host>`) passa, e o `POST /api/agent-config/skill` vindo dela.

| Arquivo | O quê |
| --- | --- |
| [painel.ts](src/api/painel.ts) | Monta a resposta: estado e faixa pela máquina de estados, custo e tokens pelo item 1.6, plano atual e a lista dos planos da sessão (item 1.9 e #131, com o dono de cada passo), família, conta e "precisam de você" |
| [mural.ts](src/api/mural.ts) | Monta o mural (#34): as sessões abertas, na ordem, cada card pela mesma leitura do painel (`leituraDaSessao`) |
| [atencao.ts](src/api/atencao.ts) | Os níveis de atenção (#140): o que bloqueia a sessão até você agir (permissão, pergunta, plano, decisão pedida, erro) e o que é só a sua vez; os PRs aguardando aprovação saem do trabalho por branch |
| [resumo.ts](src/api/resumo.ts) | Turno, plano (`TodoWrite`, só quando a sessão não tem plano gravado), pergunta, pedido de permissão, erro e contexto, lidos dos eventos de forma incremental |
| [trabalho.ts](src/api/trabalho.ts) | Issue e PR pelo nome do branch, com o cache do GitHub (decisão 0001), sem o pedido esperar o GitHub |
| [indice-desktop.ts](src/api/indice-desktop.ts) | Índice do Claude Desktop: título, branch, sessão mãe (`spawnedFrom`), esforço (`effort`), arquivada e conta pela pasta, relido só quando muda |
| [contas.ts](src/api/contas.ts) | A conta de cada sessão pela ordem da decisão 0006 e os rótulos de `~/.ahrena-console/contas.json` |
| [historico.ts](src/api/historico.ts) | `GET /api/history`: lê o pedido e responde a página de [src/historico/](src/historico/) (#33) |
| [kanban.ts](src/api/kanban.ts) | O Kanban (#31): as colunas das duas visões, o status de cada agente, a página de cada coluna; custo e último prompt só para os cards devolvidos |
| [servidor.ts](src/api/servidor.ts) | As rotas |
| [agent-config.ts](src/api/agent-config.ts) | As rotas da tela Agent Config, sobre [src/agent-config/](src/agent-config/) |
| [legacy-routes.ts](src/api/legacy-routes.ts) | As rotas e os parâmetros antigos, em português, como alias das novas (#173) |
| [ui.ts](src/api/ui.ts) | Serve a pasta [ui/](ui/README.md) em `/ui`, com a política de conteúdo que só deixa a página falar com o núcleo |

**Consumo.** Nada varre transcripts por pedido: o seguidor importa só o que mudou (na API, a varredura de reserva é a cada 30 s, `--varredura`; o `fs.watch` avisa cada escrita na hora), o resumo de cada sessão lê só os eventos novos desde o último pedido, o custo é recalculado no máximo a cada 30 s, "precisam de você" é uma consulta por índice (esperando ou com erro) guardada por 4 s para todos os painéis, e o índice do Desktop e o arquivo de rótulos são conferidos no máximo a cada 30 s. O GitHub e o git respondem por trás, com o último dado no pedido. Para medir:

```bash
node scripts/medir-carga.mjs --rota painel --sessoes 20 --abertos 1
```

### Mural ao vivo

`GET /api/wall` (#34) responde `{ version: 1, generatedAt, count: { all, waiting, active }, cards }` (contrato `Mural` e `CardDoMural` em [src/api/tipos.ts](src/api/tipos.ts)); a rota antiga `/api/mural` continua respondendo o corpo antigo, com as chaves em português (#173). Cada card traz `id` (leva a `/ui/sessions/<id>`), `title`, `project` (o nome da pasta), `branch`, `status`, `state`, `reason`, `urgent`, `since`, a `activity` (a linha do meio: o que pede, o erro, "terminou sem erro" ou o que está fazendo), `model`, `effort`, `agents` (`active`/`total`, o principal mais os subagentes), `cost` (`usd: null` é "sem preço"), `plan` (`done`/`total`/`current`) e `context` (`pct`/`used`/`limit`/`label`); `plan` e `context` são `null` quando a sessão não tem.

- **Aberta:** não arquivada no Claude Desktop, e `active` (o que inclui esperando, delegando e em background) ou `error` sem `endedAt`; a `completed` (ou o erro já encerrado) só enquanto a última atividade estiver dentro do `abandonMs` do vigia (180 min), o card "Terminou sem erro": fica pelo mesmo tempo que uma sessão parada leva para ser dada como abandonada. `abandoned` nunca entra.
- **Ordem e urgência:** `urgent` é a espera `notification` ou `interrupted` e também o erro, como no "precisam de você" do painel. Primeiro as que precisam de você (`waiting` e `error`), as urgentes antes, e entre elas o pedido mais recente; depois as outras, pela atividade mais recente.
- **Contagem:** `count.waiting` são as `waiting` e `error`; `count.active`, as `active`, `delegating` e `background`; as concluídas só contam em `count.all`.
- **Esforço:** o `effort` do índice do Claude Desktop (`local_*.json`, o mesmo arquivo que já dá título e branch); sessão só de terminal ou fora do índice, `null`.
- **Branch:** o do Desktop ou da metadata e, sem eles, o do git pelo trabalho por branch, que responde do cache (o primeiro pedido não espera o git).
- **Consumo:** o custo sai do mesmo cache do painel (por sessão, a cada 30 s ou quando ela muda), os eventos pelo resumo incremental, e a resposta inteira fica guardada por 2 s, com pedidos ao mesmo tempo esperando a mesma montagem. Duas consultas por índice (vivas e as concluídas recentes); nada varre transcripts.

O transcript passou a guardar a entrada de `AskUserQuestion` (a pergunta) e das ferramentas do plano (`TodoWrite`, `TaskCreate`, `TaskUpdate`, `update_plan`), cortada como os outros textos; a de nenhuma outra.

### Detalhe da sessão e Workflows

O Detalhe da sessão (#29, #30 e #97) lê, só do banco ([src/api/detalhe.ts](src/api/detalhe.ts) e [src/api/workflows.ts](src/api/workflows.ts)):

- `GET /api/sessions/<id>`: `{ version: 1, generatedAt, session, cost, branch, local, opensSession, command, endedAt, counts: { agents, events } }`, com o card e o custo do painel.
- `GET /api/sessions/<id>/agents`: `numbers` (`events`, `perMinute`, `tools`, `uniqueTools`, `subagents`, `compactions`, `errors`, `durationMin`, `running`), `tools` (`{ name, n }`), `tasks` (o plano do painel), `tokens` (`cacheRead`, `cacheWrite`, `input`, `output`, `total`) e `agents` (`type` `main | subagent`, `name`, `task`, `model`, `turns`, `status`, `start`, `end`, `costUsd`, `parent`).
- `GET /api/sessions/<id>/conversation?agent=&limit=`: `{ agents, agent, total, messages }`; cada mensagem tem `role` (`you | assistant`), `at`, `text`, `model`, `tokens` (`input`, `output`) e `tools` (`name`, `summary`, `state` `ok | error | permission | running`, `input`, `result`).
- `GET /api/sessions/<id>/events?q=&type=&tool=&agent=&status=&from=&to=&limit=&before=`: `{ total, filtered, items, next, options: { types, tools, agents, status } }`; cada item tem `at`, `type`, `tool`, `summary`, `agent` (`id`, `name`), `status` e `data` (o `data` do evento em JSON, cortado). Filtro malformado é ignorado.
- `GET /api/sessions/<id>/workflow`: `{ sessionId, start, end, durationMs, summary, nodes, edges, reviewRounds, changesRequested, timeline: { start, end, lanes: [{ nodeId, label, spans }] } }`; o nó tem `state` `active | completed | error` e `changesRequested` (os ajustes pedidos por um review); a aresta, `type` `opened | delivered | changes-requested` e `label` (o texto da tela: `plano`, `diff`, `v2`, `ajustes`).

`GET /api/workflows?filter=all|active|completed&node=<id>` (#96) responde `{ filter, node, generatedAt, sessions, truncated, max, kpis, runs, graph }`: `kpis` (`averageDepth`, `subagentsPerSession`, `subagentSuccess`, `commonFlow: { label, fraction }`, `roundsPerPr`, `averageDurationMs`), `runs` (`name`, `state` `active | completed | error`, `model`, `project`, `sessionId`, `tools`, `tokens`, `durationMs`, `start`, `end`, `phases`, `loop`, `agents` com `state` `completed | running | changes-requested | error`) e `graph` (`columns` `origin | main | subagent | compaction | outcome`, `nodes` e `edges` `{ from, to, volume }`). Os nós são `origin:prompt`, `origin:resume`, `main`, `subagent:<tipo>`, `compaction:none`, `compaction:compacted` e `outcome:completed|error|active|abandoned`.

As rotas antigas `/api/sessoes/<id>[/agentes|/conversa|/eventos|/workflow]` continuam respondendo o corpo antigo, com as chaves e os valores em português; `/api/workflows` não tem caminho antigo, mas ainda aceita `?filtro=`/`?no=` e os valores antigos (`todas`, `ativas`, `concluidas`, `principal`, `subagente:<tipo>`…) (#173).

## Agent Config (#63)

A tela Agent Config (wireframes C16 e C17) mostra o que o Claude Code tem configurado nesta máquina e edita skills. A leitura mora em [src/agent-config/](src/agent-config/), as rotas em [src/api/agent-config.ts](src/api/agent-config.ts); o contrato está em [src/agent-config/model.ts](src/agent-config/model.ts).

**De onde lê.** As raízes de usuário são todas as pastas de configuração que os perfis conhecem (decisão [0006](../../docs/decisoes/0006-multiplas-contas.md): `~/.claude`, as `~/.claude-*`, as de `perfis.json` e as que os hooks revelaram), cada uma com o seu `.claude.json` (`~/.claude.json` para a padrão, `<pasta>/.claude.json` para as outras). A raiz do projeto é `<projeto>/.claude`. De cada uma:

| O quê | Onde | O que sai |
| --- | --- | --- |
| Skills | `skills/*/SKILL.md` | O nome da pasta (a chave da edição), `name` e `description` do frontmatter, a data |
| Subagentes | `agents/*.md` | `name` (ou o nome do arquivo) e `description` |
| Comandos | `commands/**/*.md` | O caminho sem `.md`, com `:` no lugar de `/` (`git/limpar.md` é `git:limpar`) |
| Memória | `CLAUDE.md` da pasta de usuário; `CLAUDE.md`, `CLAUDE.local.md` e `.claude/CLAUDE.md` do projeto; os `.md` de `<pasta>/projects/<cwd codificado>/memory` | Nome e caminho, nunca o conteúdo |
| Hooks | `settings.json` e `settings.local.json` | O nome do evento e quantos hooks ele tem. Nenhum comando |
| MCP | `mcpServers` do `.claude.json` (topo: usuário; `projects[<projeto>]`: projeto) e do `.mcp.json` do projeto | Só o nome do servidor |
| Plugins | `enabledPlugins` dos settings | As chaves ligadas (`nome@marketplace`) |
| Configurações | `settings.json`, `settings.local.json` e o `.claude.json` | Quais existem, com o caminho |

Os JSON são lidos sem valores: o próprio parse descarta todo texto e número, então `env`, `command`, `args`, `url`, headers, o `oauthAccount` e o e-mail nunca existem no objeto lido. O `.credentials.json` não é aberto. Arquivo ilegível ou JSON quebrado tira só aquela parte da resposta. Um `SKILL.md` ou `agents/*.md` que é symlink para fora da própria pasta continua listado, mas o frontmatter dele não é lido (`description: null`): um link (symlink ou hardlink) para o `.credentials.json` não vaza pela descrição.

**O projeto.** `projects` são os `cwd` das sessões que o núcleo já viu, das mais recentes para as mais velhas, sem repetir, até 50, só pastas que existem nesta máquina ([projects.ts](src/agent-config/projects.ts)). Sem `?project=`, vale o primeiro (ou nenhum, com `project: null`); `?project=` fora da lista dá 400, para o pedido nunca escolher uma pasta qualquer do disco. As rotas da skill aceitam o mesmo `project` (na query do `GET`, no corpo do `POST`) para a raiz `p`.

**As raízes.** Ids opacos e estáveis: a letra do tipo e um hash curto do caminho real (`u-…` para cada pasta de configuração de usuário, `kind: home`; `c-…` para o `.claude.json` dela, `claude-json`, só se existe; `p-…` para `<projeto>/.claude`, `project-claude`; `r-…` para o projeto, `project`). O id não depende da ordem da descoberta dos perfis: o `POST` grava na mesma pasta que a tela mostrou, e um id cuja pasta saiu da descoberta dá 400. Só `home` e `project-claude` recebem skill. O projeto que é a pasta pai de uma home (o próprio `$HOME`) não tem `p`: `<projeto>/.claude` é a home, já lida como usuário, e não sai de novo como projeto (nem o `.claude/CLAUDE.md`); o `POST` com o id `p-…` dessa pasta dá 400.

**A edição de uma skill.** `GET /api/agent-config/skill?root=&name=` devolve `{ root, name, scope, path, content, version, editedAt }`, com `version` = sha256 do conteúdo. `POST /api/agent-config/skill` com `{ root, name, content, version?, project?, create? }` grava e responde `{ ok, path, version, editedAt, backup }`:

- skill que existe: copia o `SKILL.md` atual para `~/.ahrena-console/backups/<aaaa-mm-dd>/<pasta>-<hash>/<nome>/SKILL.md.bak-<data>-<sufixo>` e só então troca, por um temporário na mesma pasta e `rename`;
- skill que não existe: cria `skills/<nome>/SKILL.md` (o botão "Nova"), com `backup: null`; na raiz `p`, cria a `.claude` do projeto se faltar;
- `version` que não bate com a atual, ou que veio para uma skill que não existe: 409, nada gravado;
- `create: true` (o "Nova" da tela) com a skill existindo: 409, nada gravado. A conferência corre dentro da fila do arquivo e a criação usa `link` em vez de `rename`, então de dois "Nova" juntos um passa e o outro dá 409.

Defesas: nome `^[a-z0-9][a-z0-9._-]{0,63}$` sem `..` (400); `root` só um id conhecido de tipo `home` ou `project-claude` (400); a pasta `skills`, a da skill e o `SKILL.md` têm o caminho real dentro do caminho real da raiz (e o `SKILL.md`, dentro da pasta da skill), o `SKILL.md` não pode ser symlink nem para ler nem para gravar, mesmo apontando para dentro da raiz, e a `.claude` do projeto tem de ficar dentro do projeto (403; a listagem marca essas skills com `editable: false`); duas gravações no mesmo arquivo passam uma de cada vez, então a segunda com a mesma `version` dá 409; só se escreve `SKILL.md`; conteúdo em texto até 256 KiB (413); corpo do `POST` acima do limite: 413 assim que passa, sem ler o resto, e a conexão fecha; `Content-Type: application/json` (415). A origem segue a decisão [0003](../../docs/decisoes/0003-responder-sessao.md): Host nosso, e `Origin` ausente ou exatamente `http://<Host>` (a própria `/ui`). Apagar uma skill fica fora desta entrega.

**Na `--demo`.** Nada da `~/.claude` real é lido: a API monta num temporário do sistema uma pasta de configuração e um projeto fictícios (`motor-de-regras`), com as skills do wireframe, agentes, comandos, `CLAUDE.md`, settings com hooks e plugins, `.claude.json` e `.mcp.json` ([demo.ts](src/agent-config/demo.ts)). Os backups também ficam lá, e a pasta é apagada quando a API sai.

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

A sessão persiste `active`, `completed`, `error` ou `abandoned`. `waiting` não é gravado: é uma camada sobre `awaitingInputSince`, com o motivo em `awaitingReason` (`notification`, `interrupted`, `stop`, `session_start`). `displayStatus()` devolve o que a interface mostra. As transições são da máquina de estados, em [src/states/](src/states/README.md), que também dá ao inbox os estados "delegando" e "esperando processo em background".

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

A API local expõe o quadro em `GET /api/project` e `POST /api/project/move`, com o corpo na tabela das rotas acima (as rotas antigas, `/api/projeto` e `/api/projeto/mover`, respondem o corpo antigo, em português; ver [docs/kanban-do-projeto.md](../../docs/kanban-do-projeto.md#no-núcleo-80-wireframe-c11)); a `--demo` usa o Project falso do C11 (`ProjetoDoSimulador`, em `src/simulador/projeto.ts`).

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

## Telemetria das máquinas

#175, [decisão 0008](../../docs/decisoes/0008-machine-telemetry-and-dev-console.md). O núcleo mede a própria máquina a cada 30 s enquanto está de pé e guarda 12 h no SQLite. É a base das telas "Esta máquina" e "Workstation" (C24 e C25) e do bloco Máquinas da bandeja (A6); a leitura da máquina remota pelo túnel é a #176 ([Máquinas remotas](#máquinas-remotas), abaixo). Código, rotas e chaves de JSON em inglês; o texto dos alertas, que a tela mostra, em pt-BR.

| Arquivo | O quê |
| --- | --- |
| [model.ts](src/telemetry/model.ts) | A leitura (`TelemetryReading`), os alertas, os pontos da série e os estados de uma máquina |
| [ports.ts](src/telemetry/ports.ts) | As portas: `TelemetryCollector` (mede) e `TelemetryStore` (guarda), e o que o coletor recebe de fora: `CommandRunner`, `FileReader`, `StatFs`, `PortProbe`, `OsFacts` |
| [alerts.ts](src/telemetry/alerts.ts) | Os alertas sobre as amostras e o `AlertTracker`, que diz o que entrou e o que saiu |
| [sampler.ts](src/telemetry/sampler.ts) | O `TelemetrySampler`: lê, grava com a poda, recalcula os alertas e publica a passagem em `/api/changes` |
| [service.ts](src/telemetry/service.ts) | O `TelemetryService`: o que `/api/machines` e `/api/telemetry` respondem |
| [adapters/darwin.ts](src/telemetry/adapters/darwin.ts), [adapters/linux.ts](src/telemetry/adapters/linux.ts) | Os coletores, um por plataforma, com a base comum em [adapters/common.ts](src/telemetry/adapters/common.ts) |
| [adapters/sqlite.ts](src/telemetry/adapters/sqlite.ts) | As amostras na tabela `telemetry_samples` (migração 9, [migration.ts](src/telemetry/migration.ts)) |
| [adapters/system.ts](src/telemetry/adapters/system.ts) | O executor de comandos, a sonda de porta e o `collectorFor(plataforma)` do núcleo no ar |
| [machines-config.ts](src/telemetry/machines-config.ts) | O `~/.ahrena-console/machines.json` das máquinas remotas (#176) |
| [remote.ts](src/telemetry/remote.ts) | A `RemoteMachine`: lê o núcleo de lá a cada 30 s, guarda a última leitura, o estado, os alertas e as sessões que precisam de você (#176) |
| [adapters/loopback-http.ts](src/telemetry/adapters/loopback-http.ts) | O `GET` em `127.0.0.1:<porta>` com `Host: 127.0.0.1:4720` e 3 s de prazo (#176) |

**De onde vem cada número.** Tudo é leitura, sem `sudo` e sem dependência nova: o `node:os` e os comandos que já vêm no sistema.

| Grupo | Mac | Linux |
| --- | --- | --- |
| CPU (`cpu.usedPct`, `cpu.load` contra `cpu.cores`) | `os.cpus()` (a diferença entre duas amostras) e `os.loadavg()` | igual |
| Memória (`memory.usedBytes`, `memory.swapUsedBytes`, `memory.pressure`) | `vm_stat`, `sysctl vm.swapusage`, `sysctl kern.memorystatus_vm_pressure_level` | `/proc/meminfo` (sem pressão) |
| GPU (`gpu`) | `ioreg -c IOAccelerator` | `nvidia-smi`, se existir |
| Volumes (`disk.volumes[]`) | `fs.statfs` de cada ponto; o `df -P` só lista (fora os volumes de sistema do APFS) | igual (fora `tmpfs`, snaps e EFI) |
| Rede (`network`) | `route -n get default` e `netstat -ibn`, bytes/s entre amostras | `/proc/net/route` e `/proc/net/dev` |
| Claude (`claude.processes`, `.cli`, `.desktop`) e `topProcesses` | `ps -axo` (o CLI pela linha de comando, o Desktop por `Claude.app`) | `ps -eo` |
| Docker (`docker`) | `docker ps -a` (stacks pelo rótulo `com.docker.compose.project`) e `docker system df`, se o `docker` responder | igual |
| Portas (`ports[]`) | `lsof -nP -iTCP -sTCP:LISTEN` (os processos do usuário) | `ss -ltnp` |
| Túnel (`tunnels[].ports[].state`) | os `ssh` com `-L` (ou `LocalForward` pelo `ssh -G <destino>`), e a sonda de cada porta: `up`, `idle`, `busy`, `down` | não se aplica (`null`) |

- **Ausente, nunca erro.** Cada comando roda sem shell, com `LC_ALL=C` e 2,5 s de tempo (3 s no `docker system df`). O que falta, falha ou estoura o tempo sai `null` no grupo; a rota nunca falha por isso. A primeira leitura espera 1 s entre duas medidas, para CPU e rede já virem preenchidas.
- **Amostras.** A tabela `telemetry_samples` (uma linha por máquina e hora: as colunas das séries e a leitura inteira em JSON). A poda vai na mesma transação da gravação: nada passa de 12 h. A série de 1 h tem um ponto por amostra (120); a de 12 h, baldes de 2 min com a média (360).
- **Alertas.** Carga de 1 min acima dos núcleos em todas as amostras dos últimos 5 min (`load-high`), volume acima de 85% (`volume-full:<ponto>`), porta em todas as interfaces (`port-exposed:<porta>`) e porta do túnel ocupada por outro processo (`tunnel-busy:<porta>`). Cada um com `level`, `message` e `detail` em pt-BR e `since`. A entrada e a saída viram a mudança `alert` em `/api/changes` (`?type=alert` só elas), com a chave `<máquina>:<alerta>`.
- **Túnel.** A sonda conecta em `127.0.0.1:<porta>` e não escreve nada: a conexão que fica aberta 1 s é `up` (o outro lado responde), a que fecha antes é `idle` (o `ssh` aceitou e lá não há ninguém), a recusada é `down`; outro processo escutando a porta é `busy`.
- **No ar.** O `cli.ts` liga o amostrador na subida e o para no desligamento; sem coletor para a plataforma, ou com `--no-telemetry`, as duas rotas dão 404. Na `--demo`, as leituras são do simulador ([src/simulador/telemetry.ts](src/simulador/telemetry.ts)): esta máquina (`mac-exemplo`) e a máquina remota sintética `workstation` (`ws-exemplo`), com 12 h já semeadas e os alertas dos wireframes; a carga da workstation passa dos núcleos por uns 15 min a cada 40, então o alerta entra e sai sozinho.
- **Testes.** Os coletores rodam sobre saídas escritas à mão em [test/fixtures/telemetry](test/fixtures/telemetry/) (Mac e Linux), nunca sobre o sistema.

### Máquinas remotas

#176, seções 2 e 3 da [decisão 0008](../../docs/decisoes/0008-machine-telemetry-and-dev-console.md). A máquina remota roda o próprio núcleo; o deste Mac o lê pela porta que o **seu** túnel já encaminha. O núcleo não abre SSH, não guarda chave, não conhece o host e não sobe nem derruba túnel.

```json
{ "machines": [ { "id": "workstation", "label": "Workstation", "port": 14720 } ] }
```

- **Configuração.** `~/.ahrena-console/machines.json` (ou `--machines <arquivo>`), lido ao subir. `port` é a porta deste Mac encaminhada para a `4720` de lá (`LocalForward 14720 127.0.0.1:4720`). Sem arquivo, só esta máquina; arquivo inválido (qualquer entrada errada, `id` repetido ou `local`) vai para o log e também fica só esta máquina. A `--demo` não lê o arquivo: a workstation dela continua sintética.
- **Leitura.** A cada 30 s, e uma vez na subida: `GET http://127.0.0.1:<port>/api/telemetry` e, se respondeu, `GET /api/attention`, com `Host: 127.0.0.1:4720` (a defesa da [0003](../../docs/decisoes/0003-responder-sessao.md) recusa outro Host) e 3 s de prazo. Só `GET`: nada deste Mac escreve na remota.
- **Estado.** `connected`; `unreachable` com `reason` `port-closed` (a porta recusa: o túnel caiu) ou `no-response` (aceita e não responde HTTP em 3 s, fecha na hora ou responde um erro HTTP que não seja 404); `incompatible-version` quando o `version` da telemetria de lá é outro, falta, ou lá não há a rota (404). Antes da primeira leitura, `unreachable` sem `reason`. `not-configured` não aparece: sem arquivo não há remota para mostrar.
- **Última leitura.** Vai para `telemetry_samples` com o `id` da remota, só com os campos da leitura, até 256 kB e com o `takenAt` da hora em que este Mac leu (o relógio de lá não decide a poda); `/api/telemetry?machine=<id>` a devolve, com `lastReadAt`, também com a remota fora do ar.
- **Alertas.** Os que o núcleo de lá calculou, mais `machine-unreachable` ("Workstation sem conexão", com o `label`) enquanto não dá para ler. A queda e a volta saem em `/api/changes` como `alert`, chave `<id>:machine-unreachable`.
- **Sessões.** As que precisam de você lá entram em `/api/attention` com `machine: { id, label }` e `local: null` (sem "Abrir no Claude Desktop"); as daqui têm `machine: null`. Uma que entra ou sai da lista lá vira `needs-you` em `/api/changes`, chave `<id>:<sessão>`. Um núcleo de lá anterior à #173 (fase 2b) ainda responde a atenção em português (`itens`, `sessao`, `motivo`…): este Mac a lê como a inglesa até a fase 6.
- **Testes.** Um núcleo remoto FALSO em loopback, numa porta livre ([test/telemetry/fake-remote.ts](test/telemetry/fake-remote.ts)): nenhuma rede externa.

## Testes

```bash
npm install   # só a devDependency do teste de contrato do MCP (o cliente oficial)
npm test
```

## Mudanças e long polling (item 2.4)

O que deixa as telas ao vivo sem polling curto: o artefato, cujo `watchTool` tem piso de 30 s (validação V2), o app de bandeja (decisão 0005) e o painel.

- **Cursor.** [cursor.ts](src/mudancas/cursor.ts): uma sequência em memória que avança a cada mudança relevante, com tipo (`session`, `state`, `needs-you`, `plan`, `decision`, `account` e `alert`, o alerta de máquina da [telemetria](#telemetria-das-máquinas); a rota antiga `/api/mudancas` ainda responde e aceita os nomes antigos, `sessao`, `estado`, `precisa-de-voce`, `plano`, `decisao`, `conta`), chave (`key`), sessão e conta. Guarda as últimas 1.024 numa fila; registrar não lê o banco. O cursor é opaco (`<geração>.<seq>`): cursor vazio, de antes do núcleo reiniciar ou mais velho que a fila volta na hora com `reset: true` (releia tudo).
- **Espera.** `aguardarMudancas(cursor, { filtros, timeoutMs, signal })` responde na hora se já há novidade; senão segura até chegar uma que passe nos filtros (sessão, conta, tipo) ou até o timeout (padrão 25 s, máximo 110 s, abaixo dos ~130 s do app). Cada espera responde no mínimo 1 s depois de começar: com hooks chegando sem parar, quem faz long polling em laço acorda no máximo uma vez por segundo, e a rajada sai numa resposta só, uma vez por (tipo, chave). O cursor devolvido é sempre o de agora: as mudanças que os filtros deixaram de fora ficam para trás e não voltam num pedido seguinte com outros filtros. No máximo 256 esperas abertas; acima disso, `ErroDeLotacao` (503 no HTTP).
- **Fontes.** [fontes.ts](src/mudancas/fontes.ts): `comMudancas(storage, cursor)` embrulha a porta (`putSession`, `putPlan`, `putAccount`); `session` só é registrada quando muda um campo que as telas mostram (nome, status, pasta, modelo, fim, espera e motivo, conta), não a cada hook que só avança o `updatedAt`. Atividade nova (eventos) não é mudança por si: estado, plano e decisões têm os seus tipos. `decisoesComMudancas` a das decisões, e `aoMudarDaMaquina` vai no `onChange` da máquina de estados (`state` e, quando entra ou sai do inbox, `needs-you`). A API (`cli.ts`) liga as três.
- **HTTP.** `GET /api/changes?since=<cursor>&wait=<s>&session=<id>&account=<id|no-account>&type=<type>` (o antigo `sem-conta` ainda vale) ([http.ts](src/mudancas/http.ts)): `{ cursor, changes: [{ type, key, sessionId, accountId, seq }], reset, timedOut }`. O cliente que fecha a conexão libera a espera; lotado, 503 com `Retry-After`.
- **MCP.** [mcp.ts](src/mudancas/mcp.ts): a ferramenta `wait_for_changes` no formato `Ferramenta` do [servidor MCP](src/mcp/README.md), registrada no `cli.ts` logo depois de `criarServidorMcp`. Argumentos `cursor`, `timeout` (segundos), `sessions`, `account` (rótulo, id ou `none`, como nas outras ferramentas) e `types` (os tipos em inglês; os nomes antigos, `sessao`, `plano`…, ainda valem); saída `{ cursor, reset, timedOut, changes }`, com a conta como rótulo e cor, nunca o id. Ouve `ctx.sinal`: o cliente que desiste libera a espera. Contrato com o cliente oficial em [test/mudancas/contrato-sdk.test.ts](test/mudancas/contrato-sdk.test.ts).

**Consumo.** Parado, cada espera aberta é só um timer; nada varre o banco. Para medir, parado e com hooks sintéticos pelo receptor de verdade:

```bash
node scripts/medir-esperas.mjs --esperas 50 --segundos 60 --hooks-por-min 600
```
