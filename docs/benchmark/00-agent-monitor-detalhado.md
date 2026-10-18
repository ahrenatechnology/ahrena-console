# Claude Code Agent Monitor (CCAM): inventário detalhado

Complementa [00-agent-monitor.md](00-agent-monitor.md). Base: código em `refs/agent-monitor` (v2.3.0, commit a06db03, MIT) e as capturas de `images/readme/`. Nada foi instalado nem executado. Quando um detalhe vem só da captura de tela, e não do código, o texto diz isso.

---

## 1. Mapa de telas

### Moldura comum (`client/src/components/Layout.tsx`, `Sidebar.tsx`)

- **Barra lateral fixa à esquerda**, de cima para baixo: logo "Agent Dashboard · Claude Code Monitor"; 9 itens de navegação (Dashboard, Kanban Board, Sessions, Activity Feed, Analytics, Workflows, Agent Config, Run Agent, Settings), cada um com ícone lucide; no rodapé, seletor de idioma (EN, 中文, VI, ES, KO), botão **Collapse**, indicador **Live** com a versão (abre o modal "Connection details"), **Up to date / Update available**, links GitHub e site do autor.
- **Cabeçalho de página** igual em todas: ícone em quadrado, título, pílula verde **● Live**, subtítulo com contagem ("1860 session recorded", "2360 agent tracked"), e à direita os controles da página (segmented control, **Refresh**, **Export**, **Pause**).
- **Sobreposições globais**: Tabby (gato flutuante, arrastável), `UpdateNotifier` (modal "Dashboard update available" com o comando `git pull && npm run setup && npm run build` e botões Check now / Dismiss / Copy command), `CommandPalette` (⌘K / Ctrl+K), `ActionToast` (confirmação curta, `aria-live`), `SplashScreen` no primeiro carregamento, link "skip to content".
- **Modal Connection details** (captura `live.png`): três números (Total de eventos, Last 60s, Peak events/s), sparkline de throughput dos últimos 60 s, URL do WebSocket, "connected 53s ago", último evento, barras dos tipos de mensagem mais frequentes (`new_event` 77%, `agent_updated`, `session_updated`, `remote_source.status`, `codex_config_changed`) e lista de atividade recente. As estatísticas persistem entre recargas e têm **Reset**.
- **Escopo global de dados** (`lib/dataScope.ts`): toda GET com escopo recebe `?sources=` (todas as máquinas, só esta, ou selecionadas) e o filtro de produto (Claude Code, Codex, ambos). É configurado em Settings e vale para todas as páginas.

### 1.1 Dashboard (`/`, `pages/Dashboard.tsx`, 1.604 linhas)

Objetivo: o "agora" da frota. Tem duas visões num segmented control no topo à direita, **Monitor** e **Health**.

**Monitor** (captura `dashboard.png`):
- Grade 3×2 de `StatCard`: Total Sessions (1.9K, "4 active"), Active Agents, Active Subagents ("34 in active sessions"), Events Today, Total Events, Total Cost (US$ 18.98K). Cada card tem rótulo em caixa alta, número grande, sublinha cinza e ícone colorido no canto.
- Duas colunas abaixo:
  - **Active Agents** (link "View Board →"): lista de `AgentCard` do agente principal de cada sessão viva. O card mostra ícone de robô, título da sessão (até 3 linhas), projeto e "N subagents · N turns", as **duas últimas mensagens humanas** em itálico com barra lateral, modelo, custo, "just now", tarefa atual e id curto. A borda esquerda tem a cor do status. Um chevron à esquerda expande os subagentes ("9 subagents" em violeta).
  - **Recent Activity** (link "View All →"): linhas com badge de status, frase do evento ("Turn completed in 86.2s", "Session resumed", "Session closed"), sessão truncada e tempo relativo.
- Captura `tasks-overview.png`: passar o mouse no donut de progresso de um card abre o popover **Task Progress**, com anel de %, "2 / 8 complete", tarefa atual, três chips (Completed, In progress, Pending), checklist das primeiras tarefas, "+3 more tasks in Session Detail" e a fonte ("Codex update_plan").

**Health** (captura `dashboard-health.png`):
- **Runtime**: uptime, CPU 1/5/15 min, Node RSS, barras de Host Memory e V8 Heap.
- **Storage**: tamanho do banco ("589.8 MB · WAL") e donut com a proporção de sessions, agents e events (events = 99%).
- **Health Score**: anel de 0 a 100. O tooltip "Formula" mostra a conta: 0,4 × taxa de sucesso + 0,25 × cache hit + 0,25 × (100 − taxa de erro) + 0,10 × (100 − heap%). Verde a partir de 90, amarelo a partir de 70, vermelho abaixo. Rodapé com Cache, Errors, Compact e Saved.
- **Token Usage** por modelo (barras horizontais coloridas com %), **Concurrency** (barras por intervalo, com Peak, Active e Avg), **Tool Usage** top 8 (Bash, Edit, Read, MCP…), **Subagent Effectiveness** (barra verde de sucesso por tipo de subagente).

### 1.2 Kanban Board (`/kanban`, `pages/KanbanBoard.tsx`)

Captura `board.png` e `board-sessions.png`. Toggle **Agents | Sessions** no topo.

- **Agents**: 4 colunas, `working`, `waiting`, `completed`, `error` (`AGENT_COLUMNS`). Cada coluna tem bolinha colorida, título em caixa alta, ícone de ajuda e contador.
- **Sessions**: 5 colunas, `active`, `waiting`, `completed`, `error`, `abandoned` (`SESSION_COLUMNS`). O `SessionCard` mostra título, id curto, as duas últimas mensagens, `cwd`, "N agent(s)", modelo, custo, "running 45h 5m" ou "ran 2s" e tempo relativo.
- **O que move um card**: nada que o usuário faça. **Não há arrastar.** A coluna é o status efetivo calculado no servidor: o status persistido, com a sobreposição "waiting" quando existe `awaiting_input_since` (ver seção 3). O card troca de coluna sozinho quando chega `agent_updated` ou `session_updated` pelo WebSocket. Clicar num card abre o detalhe da sessão.
- Colunas `completed` e `error` são paginadas, porque passam de milhares de cards.

### 1.3 Sessions (`/sessions`, `pages/Sessions.tsx`)

Captura `sessions.png`.
- Barra de filtros: busca por texto ("Search sessions…"), seletor de projeto ("All projects"), ordenação ("Cost: highest", com botão para inverter) e pílulas de status (All, Active, Waiting, Completed, Error, Abandoned).
- Tabela: **Session** (nome e id curto), **Status** (badge; quando está esperando, aparece um chip extra com o motivo, como "At prompt"), **Last active**, **Duration** ("running" quando viva), **Agents**, **Cost**, **Directory** (monoespaçado, truncado) e chevron. A linha inteira leva ao detalhe.
- Paginação no servidor. Estado vazio pelo `EmptyState` (ícone, título e dica).

### 1.4 Session Detail (`/sessions/:id`, `pages/SessionDetail.tsx`, 1.280 linhas)

Captura `session-agents.png`, `session-conversation.png`, `session-timeline.png`, `tasks-details.png` e `dynamicworkflows-session.png`.

- **Cabeçalho**: seta de voltar, título, badge de status, chips copiáveis (id da sessão, modelo, início e duração, custo em verde) e `cwd` copiável. Botão de refresh no canto.
- Quando a sessão espera o usuário, aparece um banner amarelo com o ícone e a explicação do motivo (`REASON_ICONS`).
- **Abas**: **Agents (50)**, **Conversation**, **Timeline (50/4987)**.
- **Aba Agents**:
  - Seis cards de KPI: Events (com taxa por minuto), Tool calls (únicas), Subagents (+1 main), Compactions, Errors (fundo vermelho quando há erro) e Duration.
  - **Top Tools**: barras horizontais com ícone por ferramenta e uma cor por ferramenta (`conversation/toolStyle.ts`).
  - **Subagents**: contagem por tipo, incluindo "Context Compaction" em âmbar.
  - **Token Flow**: uma barra empilhada fina com Cache read, Cache write, Input e Output, cada um com valor absoluto e %.
  - **Event Mix**: chips "PostToolUse · 1,966", "Stop · 1,652" etc.
  - **Task Progress** (captura `tasks-details.png`): anel de %, "0 / 12 complete", barra, chips por estado, coluna "Owners" com progresso por dono e lista paginada de tarefas com título, descrição e estado. A fonte aparece como chip ("Claude TaskCreate", "Derived from task lifecycle events").
  - **Dynamic Workflows**: os runs do Workflow tool dessa sessão (ver 1.7).
  - **Agents · N**: a árvore de agentes, com o agente principal e os subagentes aninhados como `AgentCard`.
- **Aba Conversation** (`components/conversation/*`): seletor do agente (Main Agent ou um subagente), contador de mensagens e Refresh. Mensagens com avatar, papel, modelo, tokens de entrada e saída e hora. O markdown é renderizado (títulos, listas, `code` inline em âmbar). As chamadas de ferramenta são blocos que expandem (`ToolCallBlock`: ícone, nome, comando, chip "OK"). Os blocos de código têm destaque de sintaxe (`lib/highlight.ts`) e há renderização no estilo TUI (`tuiSegments.ts`). A paginação é incremental: um sentinela no topo carrega as páginas mais antigas. Fica ao vivo por WebSocket, com polling de reserva quando a aba está visível.
- **Aba Timeline**: o mesmo componente do Activity Feed, restrito à sessão (filtros Status, Event type, Tool e Agent; busca; intervalo From–To; linhas que expandem).

### 1.5 Activity Feed (`/activity`, `pages/ActivityFeed.tsx`)

Captura `feed.png`.
- Banner que expande: "About events, filters, and grouping" (`EventFiltersInfo`).
- `EventFilters`: busca em summary, tool e payload; datas From e To (`DateTimePicker`); multiselects Status, Event type, Tool e Session.
- Linhas: hora e data, badge de status, breadcrumb "projeto › sessão › agente" e summary; à direita, chip da ferramenta, tempo relativo e botão **Session ↗**.
- Uma linha expandida mostra o `EventDetail`: um bloco "Summary" com um renderer próprio por ferramenta (`event-views/tool-views.tsx`, para Bash, Edit com diff, Read etc.) e uma tabela chave-valor (Event ID, Recorded at, Session ID, Agent ID, Provider, Event, Item type, Call Id, Raw tool name, Timestamp).
- **Pause** congela o stream. Eventos parecidos são agrupados (`lib/event-grouping.ts`).

### 1.6 Analytics (`/analytics`, `pages/Analytics.tsx`, 1.563 linhas)

Captura `analytics.png`.
- Cabeçalho com relógio ao vivo, Refresh e **Export** (JSON/CSV).
- Cinco KPIs coloridos: Total Sessions (azul), Total Agents (verde), Total Tokens (violeta, "96% cache hit rate"), Total Cost (verde, "21 Model") e Total Events (amarelo, "~263.2 per session").
- **Event Activity · Last 52 Weeks**: heatmap no estilo GitHub, em tons de índigo. Ao lado, **Last 30 Days**: barras de eventos por dia, com o dia de pico e o total.
- Abas (`ANALYTICS_TABS`), guardadas na URL:
  - **Cost Analytics**: Daily Cost Trends (linha verde, com o dia de pico e o total de 30 dias), Cost by Model (donut com o total no centro e legenda com %, seguida de uma lista de valores) e Cost by Weekday (barras horizontais em ciano).
  - **Token Analytics**: Token Breakdown e Token Mix.
  - **Productivity Analytics**: Event Types, Tool Usage, Agent Status e Session Outcomes.
  - **Workflow Intelligence**: Subagent Types e afins.

### 1.7 Workflows (`/workflows`, `pages/Workflows.tsx`)

Captura `workflows.png`, `dynamicworkflows-workflows*.png`. É a tela mais original do CCAM.
- Segmented control **All Sessions | Active Only | Completed**, mais Refresh, Download (JSON) e "Updated hh:mm".
- Seis KPIs (`WorkflowStats`), cada um com um popover (i) que explica a conta e interpreta o valor: Avg Agent Depth, Avg Subagents/Session, Agent Success Rate, Most Common Flow ("Bash → Bash"), Avg Compactions e Avg Duration.
- **Dynamic Workflows** (`WorkflowRunsPanel`): runs do *Workflow tool* do Claude Code, reconstruídos dos journals em disco. Cada linha mostra nome, badge de status, modelo padrão, agentes, tool calls, tokens, duração e idade. Expandida, mostra:
  - chips de fase coloridos que filtram (Mine, Rank);
  - uma tabela por agente: Agent, Phase, State, Tokens, Tools e Duration;
  - **Results**: um teaser por agente. Ao expandir, o transcript completo é carregado sob demanda (Prompt e Result).
- Onze seções numeradas, todas em D3:
  1. **Agent Orchestration Graph** (`OrchestrationDAG`, 1.238 linhas): DAG em colunas Origin → Main Agent → Subagent types → Compactions → Outcomes, com arestas curvas cuja espessura é o volume. Clicar num nó filtra o resto da página.
  2. **Tool Execution Flow**: Sankey (`d3-sankey`) das transições ferramenta → ferramenta.
  3. **Agent Collaboration Network**: grafo de força com coocorrência de tipos de agente e legenda paginada.
  4. **Subagent Effectiveness**: anel de sucesso, métricas e sparkline semanal.
  5. **Workflow Patterns**: as sequências de passos mais frequentes, com ranking.
  6. **Model Delegation Flow**: modelo principal → modelo do subagente, com cor por família (opus, sonnet, haiku).
  7. **Error Propagation Map**: erros por profundidade da hierarquia e por tipo de agente.
  8. **Concurrency Timeline**: faixas por tipo de agente.
  9. **Session Complexity Scatter**: x = duração, y = agentes, raio = tokens, cor = status. Clicar abre o drill-in.
  10. **Compaction Impact**.
  11. **Session Drill-In**: seletor de sessão com busca e abas para a árvore de agentes, a timeline de ferramentas e a sequência de eventos.

### 1.8 Agent Config (`/config`, `pages/CcConfig.tsx`, 4.305 linhas)

Captura `config.png`, `config-skills.png`, `config-codex.png`.
- Toggle **Claude Code | Codex BETA**, filtro de escopo **All scopes | User | Project**, botões **Backups** e Refresh, e "Last updated".
- Abas com contador: Overview, Skills, Subagents, Slash commands, Memory, Plugins, Marketplaces, MCP servers, Hooks, Keybindings, Output styles e Settings.
- **Overview**: "Roots" (Claude home, `.claude` do projeto, raiz do projeto, `~/.claude.json`, todos copiáveis) e "Quick summary", uma grade de cards com contador e a divisão user/project.
- **Listas** (Skills, por exemplo): busca, botão **+ New** e um card por item com nome, chip de escopo, descrição, caminho e as ações **View source**, **Edit** e **Delete**. A edição é um editor de texto; toda gravação faz backup antes (`server/lib/cc-mutate.js`). O watcher (`cc-watcher.js`) avisa a UI por `cc_config_changed`.
- **Codex**: Overview (home, modelo, reasoning, personality) e as abas Settings, Models, Profiles, MCP servers, Projects, Skills, Hooks, Rules, Plugins e Instructions.

### 1.9 Run Agent (`/run`, `pages/Run.tsx`, 4.789 linhas, a maior)

Captura `run.png` e `run-results.png`.
- Toggle **Claude Code | Codex BETA** e botão **Dashboard runs (39)**, que abre o histórico.
- Painel explicativo "Running Claude in your browser · stream-json", com duas colunas:
  - *Works here*: streaming de texto, thinking e tools, multi-turno, resume, slash commands do usuário, projeto e plugins, `@` de arquivos, medidor de contexto e alternância entre runs ativos.
  - *CLI only*: `/help`, `/model` e `/clear`, prompts de permissão no meio da sessão, compactação e troca de modelo durante a sessão.
- Formulário:
  - **Mode**: Conversation (multi-turno) ou One-shot.
  - **Source session**: New session ou Resume existing session (o `cwd` fica travado no da sessão original).
  - **Prompt**, com ⌘/Ctrl+Enter para enviar, `/` para slash commands e `@` para arquivos.
  - **Working directory**, **Model** e **Permission mode** (acceptEdits é o recomendado).
- **Resultado**: barra de status (Completed, One-shot, modelo, id), **View session** e **New run**. Mensagens You/Claude, blocos de ferramenta com JSON de entrada e "Tool result (1 line)" que expande. No rodapé fixo, **Context 62.6k / 200k (31%)** com barra, mais Input, Output e Cache hit.
- No servidor, `run-spawner.js` e `codex-run-spawner.js` fazem o spawn de `claude -p --output-format stream-json`; a saída sai por WebSocket em `run_stream` e `run_status`.

### 1.10 Settings (`/settings`, `pages/Settings.tsx`, 3.425 linhas)

Captura `settings.png`, `alerts.png`, `remote.png`. Uma página longa com uma barra **Jump to** horizontal de âncoras, com chevrons. Botão **Export Data** no topo.

Seções (ids no código):
- Card "Total Estimated Cost".
- `data-display`: Dashboard Data, com três cards de escolha (Claude Code, Codex, Both).
- `claude-pricing`, `gpt-pricing`, `cursor-pricing`: tabelas editáveis com Pattern (o `%` é curinga), Model, Input, Output, Cache read, Cache write 5m e 1h, Fast input e output, e ações de editar e apagar. Têm **Reset Defaults** e **+ Add Model**. Preços introdutórios aparecem em violeta.
- `hooks`: status e reinstalação dos hooks.
- `session-homes`: Session Data Locations (`~/.claude`, `~/.codex`).
- `import`: Import History (`ImportHistory`, com rescan, caminho e upload).
- `remote-sources`: Remote Data Sources. Tem cards de escopo (All sources, This machine only, Selected sources), "Configured sources" com **Sync all** e **+ Add source**. O formulário pede Label, SSH host, Port, Identity file, Claude home remoto, Codex home remoto e "Sync automatically in the background". Cada fonte tem status ("Syncing", "9 linked") e as ações Test, Sync, Disable, editar e apagar.
- `tabby`: liga e desliga o companion.
- `notifications`: Web Push e notificações do navegador.
- `sound`: sons por evento (`useSoundCues`).
- `alerts`: o `AlertsNotifications`, com abas **Rules**, **Channels** e **Activity** (detalhes em 4.1).
- `data`: Data Management (limpeza, snapshots e retenção com `SnapshotStorage`, clear all com `ConfirmModal`).
- `about`.

### 1.11 NotFound

Página 404 com links de volta.

### Estados vazios e de erro (padrão em todas as telas)

- `EmptyState`: ícone, título e uma dica de ação, centralizados.
- `Skeleton` durante o carregamento.
- O indicador Live fica cinza ou vermelho quando o WebSocket cai, e `useWebSocket` reconecta com backoff.
- Erros de API viram aviso inline. O Tabby fala ("hiss… an error popped up").
- Estados ruins de dado são tratados no servidor, não na UI: o watchdog corrige erro obsoleto e encerra sessões órfãs (ver seção 3).

---

## 2. Biblioteca de componentes

| Componente | Arquivo | O que é |
| --- | --- | --- |
| StatCard | `components/StatCard.tsx` | Tile de métrica: rótulo em caixa alta, número grande formatado (1.9K), sublinha e ícone colorido |
| AgentStatusBadge / SessionStatusBadge | `StatusBadge.tsx` | Pílula com ponto e texto. Em "waiting", ganha um chip aninhado com o motivo (ícone, label e tooltip). Tem modo `compact` para cards |
| AgentCard | `AgentCard.tsx` | Card de agente: borda esquerda na cor do status, título, meta, duas últimas mensagens humanas, modelo, custo, idade, tarefa atual, id e donut de tarefas. Expande os subagentes |
| SessionCard | `SessionCard.tsx` | Variante de sessão para o Kanban |
| ProgressDonut / TodoProgressIndicator / TodoProgressPanel | `TodoProgress*.tsx`, `todoProgress.ts` | Progresso do plano (TodoWrite, TaskCreate, Codex `update_plan`): donut, popover e painel com lista e donos |
| EventFilters / EventDetail / tool-views | `EventFilters.tsx`, `EventDetail.tsx`, `event-views/*` | Filtro facetado, detalhe chave-valor e um renderer por ferramenta |
| ConversationView / MessageList / ToolCallBlock / CodeBlock / MarkdownContent | `conversation/*` | Transcript renderizado |
| CommandPalette / PaletteHint / paletteCommands / fuzzy | `CommandPalette.tsx`, `lib/palette*` | ⌘K: grupos "Pages" e "This page" (ações de contexto da página, como "Clear all session filters" e "Cost: highest"), comandos recentes e busca fuzzy com destaque |
| Select, MultiSelect, Checkbox, DateTimePicker, ConfirmModal, Tip, FieldHelp | — | Primitivos de formulário próprios, sem lib de UI |
| PaginatedLegend | — | Legenda paginada para gráficos com muitas séries |
| AlertsNotifications, WebhookSettings, webhookGuides | — | Centro de alertas e um guia de configuração por provedor |
| ImportHistory, RemoteSources, SnapshotStorage | — | Painéis de Settings |
| UpdateNotifier, SplashScreen, ActionToast, DocumentTitle | — | Infraestrutura de UX |
| Tabby | `components/Tabby/*` | Mascote (ver abaixo) |

**Gráficos**: **não há lib de gráficos.** Tudo é SVG feito à mão ou **D3 v7** com `d3-sankey` (`package.json`: só react, react-router, i18next, lucide-react, d3, d3-sankey e as fontes Inter e JetBrains Mono). Tipos usados: barras horizontais (o tipo dominante), donut, anel de progresso, linha, sparkline, heatmap de 52 semanas, barras diárias, barra empilhada de tokens, DAG em colunas, Sankey, grafo de força, scatter de bolhas e faixas de concorrência.

**Timeline**: lista vertical de eventos (feed). Não existe um Gantt por agente. O mais próximo é o Concurrency Timeline e o "tool timeline" do Session Drill-In.

**Árvore e DAG de agentes**:
- *Árvore*: `agents.parent_agent_id`, mostrada como cards aninhados no Session Detail e na expansão do Dashboard.
- *DAG agregado*: `OrchestrationDAG`, que soma os padrões de spawn de todas as sessões; não é o DAG de uma sessão.

**Kanban**: duas visões (agentes com 4 colunas, sessões com 5), só leitura e sem arrastar. O card se move por mudança de status vinda dos hooks.

**Feed de atividade**: Activity Feed e "Recent Activity" no Dashboard, com Pause, agrupamento e linhas que expandem.

**Notificações**:
- `useNotifications`: notificação do navegador para waiting, erro e fim de sessão.
- Web Push (VAPID, `server/lib/push.js`, tabela `push_subscriptions`).
- Sons (`useSoundCues`, `lib/sound.ts`).
- Alertas por regra com entrega em webhook.
- `ActionToast`.

**Buddy "Tabby"** (`components/Tabby/*`, captura `tabby.png`):
- Gato em SVG (`CatAvatar`) com 8 humores (`disconnected`, `worried`, `stuck`, `happy`, `thinking`, `watching`, `sleeping`, `idle`), derivados do stream do WebSocket por um reducer puro (`brain.ts`). As pupilas seguem o cursor.
- Pulsos (`session_done`, `session_start`, `subagent_spawn`, `waiting`, `error`, `run_done`) viram balões com frases (`quips.ts`), como "a hook tripped on something ⚠️".
- Arrastável e com dock no estilo AssistiveTouch. ⌘B abre o painel.
- O painel tem chips **Live**, **Waiting** e **Errored**, ações rápidas (Run Claude, Activity, Sessions, Errored, Mute, Clear alerts) e uma caixa **Ask Tabby**. A caixa responde a intenções locais por palavra-chave (erros, waiting, running, status, help). Qualquer outra pergunta vira `/run?prompt=…&autostart=1`, sem backend de LLM próprio.

**Tema e paleta** (`client/tailwind.config.js`, `index.css`):
- Só escuro.
- Superfícies `#06060a` → `#0c0c14` → `#13131e` → `#1a1a28` → `#222233` → `#2a2a3d`; borda `#2a2a3d` (clara `#363650`); acento índigo `#6366f1` (hover `#818cf8`).
- Status: emerald (working/active), yellow (waiting), violet (completed), red (error), slate (abandoned). Cada um com fundo a 10% e borda a 20%.
- Fontes Inter e JetBrains Mono (ids, caminhos, números de tabela).
- Classes `.card`, `.card-hover`, `.btn-primary`, `.btn-ghost`, `.badge`, `.input`; animações `fade-in`, `slide-up` e `pulse-dot`.

---

## 3. Modelo de dados e estados

### Tabelas (`server/db.js`, SQLite WAL, migrações inline)

- `sessions`: id, name, status, cwd, model, started_at, ended_at, metadata, card_prompt_preview. Colunas adicionadas por migração: `awaiting_input_since`, `awaiting_reason`, `source`.
- `agents`: id, session_id, name, type (main ou subagent), subagent_type, status, task, current_tool, started_at, ended_at, parent_agent_id, metadata.
- `events`: id, session_id, agent_id, event_type, tool_name, summary, data em JSON, created_at. **Tool call é um evento**; não existe tabela de spans.
- `token_usage`, chave (session, model, speed, inference_geo, service_tier, context_size):
  - tokens de input, output, cache_read, cache_write e cache_write_1h;
  - contagem de web_search, web_fetch e code_execution;
  - colunas `baseline_*` para compactação.
- `model_pricing`, `gpt_model_pricing`, `cursor_model_pricing`.
- `alert_rules`, `alert_events`, `webhook_targets`, `webhook_deliveries`, `push_subscriptions`.
- `workflows` (runs do Workflow tool), `dashboard_runs` (runs lançados pela UI), `remote_sources`, `codex_ingest_state`, `codex_tool_ingest_state`.

### Estados

- **Sessão** (persistido): `active | completed | error | abandoned`.
- **Agente** (persistido): `working | waiting | completed | error`.
- **Sobreposição "waiting"**: quando `awaiting_input_since` está preenchido, a UI mostra Waiting, seja qual for o status persistido. O motivo fica em `awaiting_reason`:
  - `notification`: pedido de permissão ou de input; o agente está bloqueado. Urgente.
  - `stop`: o turno terminou e a vez é do usuário.
  - `session_start`: CLI recém-aberta, esperando no prompt vazio.
  - `interrupted`: Esc, ou o watchdog detectou que o turno morreu. Urgente.

### Derivação a partir dos hooks (`server/routes/hooks.js`, `docs/HOOKS.md`)

| Hook | Efeito |
| --- | --- |
| SessionStart | Cria ou reativa a sessão (inclusive `completed`/`abandoned` no resume) e cria o agente principal. Marca waiting com motivo `session_start`; com `source = compact`, preserva o estado. Varre as outras sessões ativas paradas há mais de `DASHBOARD_STALE_MINUTES` (padrão 180) e as passa para `abandoned` |
| UserPromptSubmit | Agente principal vai para `working` e limpa o awaiting |
| PreToolUse | `working` e `current_tool = tool`. Se a ferramenta for `Agent`, cria o subagente em `working`, com nome vindo de `description` ou `subagent_type` e `task` igual ao prompt. O pai é o agente principal, se ele estiver trabalhando; senão, o subagente ativo mais profundo (CTE recursiva) |
| PostToolUse | Limpa o awaiting (permissão concedida) e `current_tool`. O PostToolUse de `Agent` **não** encerra o subagente |
| Notification | Marca waiting com motivo `notification` só se for bloqueante: `notification_type` em `permission_prompt`, `elicitation_dialog`, `agent_needs_input` etc. Se não houver tipo, decide por regex. Uma mensagem de compactação vira evento `Compaction` |
| Stop | Agente principal vai para `waiting` com motivo `stop`; a sessão continua `active`. Com `stop_reason = error`, agente e sessão vão para `error` |
| SubagentStop | Escolhe o subagente ativo (por nome/descrição, depois tipo, depois prompt, depois o mais antigo) e o marca `completed`. Em seguida importa os JSONL dos subagentes |
| SessionEnd | Sessão e agentes vão para `completed`, a não ser que haja um erro de API não recuperado no fim do transcript (`isErrorAtTail`), caso em que fica `error` |

**Regra de ator**: quando quem age é um subagente, o evento não limpa um waiting de motivo `notification` do agente principal.

**A cada hook com `transcript_path`**, o servidor:

- sincroniza o modelo e o nome da sessão;
- cria um pseudoagente "Context Compaction" para cada resumo de compactação;
- registra `APIError` e `TurnDuration`;
- regrava `token_usage`.

**Watchdog de 15 s**, para cobrir hooks perdidos:
1. Volta `error` para `active` quando o transcript avançou além do erro.
2. Detecta turno morto: o agente está `working`, sem ferramenta, e nem hook nem transcript mudaram por `DASHBOARD_WORKING_IDLE_SECONDS` (padrão 120). Nesse caso, marca waiting com motivo `interrupted`.
3. Faz a sonda de processo (`session-liveness.js`, com `ps` + `lsof` no macOS e `/proc` no Linux): se não há processo `claude` vivo com aquele `cwd`, a sessão vai para `completed` e ganha um `SessionEnd` sintético. A sonda é desligada no Windows, em container e para fontes remotas.

**Cursor** não tem Stop: vai para waiting depois de 120 s sem atividade e para completed depois de 10 min.

### Custo e tokens

- A fonte é o **transcript JSONL**, re-parseado de forma incremental a cada hook (`token-usage.js`, `transcript-cache.js`), incluindo os subagentes.
- Os tokens vão para buckets por modelo e por dimensão de preço: velocidade fast, região US, Batch, contexto curto ou longo do GPT, cache de 5 min ou 1 h.
- **Deduplicação** por `message.id`, porque o streaming grava o usage parcial e depois o final.
- **Compactação**: funciona como high-water mark, `baseline = max(antigo_live + antigo_baseline − novo_live, 0)`. O total efetivo nunca diminui.
- **Preço**: tabelas editáveis com padrão `LIKE` (`claude-opus-4%`), preço introdutório com data de corte, e cobrança separada das ferramentas de servidor (web search etc.).
- Modelos sem preço aparecem como "unpriced", em vez de custar zero.
- Custo = Σ tokens × preço por bucket. A regra que vale é a de padrão mais longo.
- Modificadores: fast, US ×1,1, batch ×0,5.
- Multiplicadores de cache: read 0,1, write 5m 1,25, write 1h 2,0.
- Web search a US$ 10 por mil.
- O custo por agente vem de `agents.metadata.tokens`.
- Os runs do Workflow tool entram com `service_tier = workflow`. Não há leitura de limite oficial nem de fatura; tudo é estimativa.

### Mensagens WebSocket (`/ws`, `{type, data, timestamp}`, ping a cada 30 s)

| Grupo | Mensagens |
| --- | --- |
| Sessões e agentes | `session_created`, `session_updated`, `agent_created`, `agent_updated` |
| Eventos | `new_event` (inclui os sintéticos `Compaction`, `APIError`, `TurnDuration` e `Interrupted`) |
| Workflows | `workflow_upserted` |
| Alertas | `alert_triggered`, `alert_updated` |
| Run | `run_status`, `run_stream`, `run_input_ack` |
| Configuração | `cc_config_changed`, `codex_config_changed` |
| Atualização | `update_status` |
| Importação | `import.progress` |
| Fontes remotas | `remote_source.status`, `remote_data.updated` |

Nota: `docs/DATABASE.md` e `server/README.md` descrevem tabelas que não existem mais (`tool_executions`, `notifications`, `pricing_rules`). A fonte de verdade é `server/db.js`.

### O que é "workflow"

Duas coisas diferentes:
1. **Workflow intelligence** (página Workflows): análise agregada da orquestração a partir de agents e events (profundidade, spawn, transições de ferramenta, delegação de modelo, erros, concorrência, compactação). `server/routes/workflows.js`.
2. **Dynamic Workflows**: runs do *Workflow tool* do Claude Code (frotas de subagentes em fases), reconstruídos dos journals em disco (`workflow-ingest.js`, tabela `workflows`, mensagem WS `workflow_upserted`).

---

## 4. Funcionalidades além do básico

### 4.1 Alertas e webhooks

- **Regras** (`alert_rules.rule_type`):
  - `event_pattern`: um evento ou ferramenta que casa com um padrão;
  - `inactivity`: sessão parada por N minutos;
  - `status_duration`: tempo demais num status, como waiting;
  - `token_threshold`: tokens ou custo acima de um limite.
- Cada regra tem `cooldown_seconds` (padrão 300) e liga/desliga. Os disparos vão para `alert_events`, com **acknowledge** (um a um ou todos).
- **Canais** (webhooks): slack, discord, teams, google_chat, mattermost, rocketchat, telegram, pagerduty, opsgenie, splunk_oncall, zapier, make, n8n, pipedream e generic (JSON próprio). O único evento entregue é o alerta disparado (mais o teste). Cada canal tem:

- payload no formato nativo (blocos do Slack etc., em `webhook-providers.js`);
- na família generic, assinatura HMAC-SHA256 (`X-Webhook-Signature`);
- timeout de 10 s e até 3 tentativas, só para erro de rede, 429 ou 5xx;
- secret e headers;
- filtro por regra (`rule_ids`, ou "Receive alerts from all rules"), além de **Test** e de um histórico de entregas com tentativas e status code.
- **Push**: Web Push VAPID. **O servidor não decide quando notificar:** é o cliente aberto (`useNotifications`) que chama `/api/push/send` quando nota sessão nova, erro, conclusão ou subagente. Sem uma aba aberta, não sai push.

### 4.2 Importação de histórico

- No boot, lê `~/.claude/projects/*.jsonl` e os rollouts do Codex (`scripts/import-history.js`, `codex-import.js`).
- Também por API: `/api/import/rescan`, `/scan-path` (outro diretório) e `/upload` (zip ou tar).
- Restaura export e reimporta.

### 4.3 Multi-máquina

- **Pull por SSH** (`remote-sync.js`): `ssh`/`scp` com `BatchMode` e `known_hosts` obrigatório, a cada 15 s. Usa `~/.ssh/config`, chaves e o agent; nenhuma senha é guardada. Uma sessão remota conta como ativa se o espelho mudou nos últimos 10 min. Copia `~/.claude` e `~/.codex` remotos, inclusive de WSL. Sincroniza em segundo plano, tem teste e mostra status.
- **Push**: `POST /api/hooks/ingest-batch`, que só funciona com `REMOTE_PUSH_TOKEN` configurado (até lá devolve 503 e não aceita `?token=`). Os hooks também podem ser encaminhados direto para um dashboard remoto por HTTPS (`CCAM_DASHBOARD_URL` + `CCAM_HOOK_TOKEN`).
- Em ambos, cada sessão leva `source`, e o escopo global filtra por máquina.

### 4.4 Run e resume

**Claude**: spawn local de `claude --output-format stream-json --verbose --include-partial-messages --permission-mode <acceptEdits|default|plan|bypassPermissions>`.

- One-shot usa `-p`. Conversation usa `--input-format stream-json`, com os turnos seguintes entregues por stdin.
- Aceita `--model`, `--effort` e `--resume`.

**Codex**: roda via `codex app-server --stdio` (JSON-RPC), com opções de approvals e sandbox.

**Regras comuns**:

- no máximo 10 runs simultâneos;
- estados `spawning`, `running`, `completed`, `error` e `killed`, gravados em `dashboard_runs`;
- guarda de Origin loopback.

### 4.5 Editor de config

**Lê** tudo: skills, subagents, comandos, output styles, plugins, marketplaces, MCP, hooks, settings, memória, keybindings e statusline.

**Grava ou apaga** só parte disso:

- skills, subagents, comandos e output styles;
- `CLAUDE.md` e a memória por projeto;
- `keybindings.json`.

**Nunca grava** plugins, MCP, hooks nem `settings.json`. Antes de cada mudança faz backup com timestamp; a escrita é atômica e os nomes passam por allowlist. Para o Codex, grava `config.toml`, profiles, hooks, rules, skills e instruções.

### 4.6 Relatórios e exportação

- Export em **JSON**. Não há CSV no servidor.
  - `/api/settings/export` gera um bundle com sessões, agentes, eventos, tokens, workflows, runs, regras e preços.
  - A restauração é idempotente.
  - Analytics e Workflows são exportados pelo cliente.
- Snapshots com retenção e compressão.
- `/api/metrics` em formato Prometheus, com 4 dashboards Grafana prontos (overview, sessions, tools, alerts).
- Relatórios em texto (standup, semanal, executivo) existem **só como skills dos plugins**, não como tela.

### 4.7 Busca

Busca textual por LIKE: em sessões, sobre id, nome e cwd; em eventos, sobre summary, tool e payload. Há também facetas (`/facets`). Não há FTS, nem busca dentro do conteúdo dos transcripts pela UI. A skill `transcript-grep` faz isso.

---

## 5. Superfícies

### 5.1 MCP (`mcp/`, 103 ferramentas em 16 domínios)

Transportes: stdio, Streamable HTTP + SSE legado na porta 8819 (`/mcp`, `/sse`, `/messages`, `/health`) e um REPL interativo (captura `mcp.png`). As ferramentas chamam a REST em `127.0.0.1:4820`. As guardas de política ficam em `mcp/src/policy/tool-guards.ts`:

- mutações exigem `MCP_DASHBOARD_ALLOW_MUTATIONS=true`;
- operações destrutivas exigem também `MCP_DASHBOARD_ALLOW_DESTRUCTIVE=true` e um `confirmation_token` literal, como `CLEAR_ALL_DATA` ou `PRUNE_SNAPSHOTS`;
- a URL da API só aceita hosts locais ou o alias de container, e redirects são rejeitados;
- o MCP HTTP aceita um token opcional (`MCP_HTTP_AUTH_TOKEN`), e as sessões expiram após 30 min ociosas.

| Domínio | Ferramentas (prefixo `dashboard_`) |
| --- | --- |
| sessions | `list_sessions` (lista paginada e filtrada) · `get_session` (sessão com agentes e eventos) · `create_session` · `update_session` |
| session-detail | `get_session_stats` (KPIs da sessão) · `get_session_facets` · `get_event_facets` (valores dos filtros) · `list_session_transcripts` · `get_session_transcript` (mensagens paginadas) · `get_transcript_image` |
| agents | `list_agents` · `get_agent` · `create_agent` · `update_agent` |
| events | `list_events` (feed filtrado) · `ingest_hook_event` (injeta um evento de hook) |
| workflows | `get_workflows` (análise agregada) · `get_session_workflow` · `list_workflow_runs` · `get_workflow_run` |
| observability | `get_stats` · `get_analytics` · `get_operational_snapshot` · `get_system_info` · `health_check` · `get_prometheus_metrics` · `export_data` |
| pricing | `get_pricing_rules` · `upsert_pricing_rule` · `delete_pricing_rule` · os equivalentes `*_gpt_*` e `*_cursor_*` · `reset_pricing_defaults` · `get_total_cost` · `get_session_cost` |
| alerts | `list_alert_rules` · `create_alert_rule` · `update_alert_rule` · `delete_alert_rule` · `list_alerts` · `acknowledge_alert` · `acknowledge_all_alerts` |
| webhooks | `list_webhook_providers` · `list_webhooks` · `create_webhook` · `update_webhook` · `delete_webhook` · `test_webhook` · `list_webhook_deliveries` |
| push | `get_push_public_key` · `subscribe_push` · `unsubscribe_push` · `send_push_notification` |
| remote | `list_remote_sources` · `create_remote_source` · `update_remote_source` · `delete_remote_source` · `test_remote_source` · `sync_remote_source` · `sync_all_remote_sources` |
| import | `get_import_guide` · `rescan_history` · `import_history_path` · `upload_history_files` · `restore_export` |
| run | `start_run` (lança claude ou codex) · `send_run_message` (próximo turno) · `stop_run` · `get_run` · `list_runs` · `list_run_history` · `list_run_models` · `list_run_directories` · `list_run_files` · `get_run_binary` |
| config | `get_claude_config` · `read_claude_config_file` · `write_claude_config_artifact` · `delete_claude_config_artifact` · `write_claude_keybindings` · `list_claude_config_backups` · `get_codex_config` · `read_codex_config_file` · `write_codex_config_file` · `delete_codex_config_file` · `create_codex_profile` |
| settings | `get_agent_homes` · `set_claude_home` · `set_codex_home` · `install_hooks` · `check_for_updates` · `get_update_status` |
| maintenance | `cleanup_data` · `clear_all_data` · `reimport_history` · `reinstall_hooks` · `get_snapshot_storage` · `prune_snapshots` · `compress_snapshots` |

O MCP só devolve dados: **não tem `ui://` nem MCP Apps.** O MCP é praticamente um espelho 1:1 da REST, e por isso ficou tão grande.

### 5.2 Plugins (`plugins/ccam-*`, 14 plugins: 66 skills, 34 comandos, 18 agentes, 3 arquivos de hooks)

| Plugin | Skills |
| --- | --- |
| analytics | cache-efficiency, cost-breakdown, model-mix, productivity-score, session-report, usage-trends |
| config | config-audit, hook-inventory, mcp-audit, memory-review, skill-inventory |
| cost-guard | budget-set, cost-alert, daily-budget-check, model-savings, spend-forecast |
| dashboard | dashboard-status, endpoint-probe, live-watch, quick-stats |
| devtools | data-export, event-trace, health-check, hook-diagnostics, session-debug, transcript-grep |
| insights | anomaly-alert, benchmark, optimization-suggest, pattern-detect, regression-watch, session-compare |
| integrations | alert-management, remote-collection, webhook-management |
| platform | config-explorer, history-portability, hook-setup, mcp-server |
| productivity | daily-standup, monthly-review, sprint-summary, time-of-day, weekly-report, workflow-optimizer |
| quality | api-error-report, error-scan, hook-failure-audit, regression-alert, slo-check |
| reports | cost-report, executive-report, reliability-report, workflow-report |
| runner | run-agent, run-history |
| sessions | cwd-rollup, session-cleanup, session-search, session-timeline, transcript-replay |
| workflows | concurrency-report, dag-map, delegation-audit, error-propagation, fleet-runs |

As skills são prompts que chamam a API ou o MCP. Os "relatórios" do produto moram aqui.

Cada plugin traz também comandos, como `/cost-today`, `/standup`, `/doctor` e `/dag`, e agentes, como budget-sentinel, reliability-engineer e session-investigator. Os hooks dos plugins chamam `jq` + `curl` fixos em `localhost:4820`, sem token. Há um catálogo para Claude Code e outro para Codex.

### 5.3 Statusline (`statusline/`)

Script em bash e em Python, independente do servidor. Uma linha (captura `statusline.png`) com: `user@host`, `cwd`, modelo e janela ("Opus 4.7 (1M context)"), branch git, barra de uso do contexto com % e tokens (↑ input, ↓ output, c para cache read), além do custo da sessão (US$ 19.3484, vindo de `cost.total_cost_usd`). A barra de contexto fica verde abaixo de 50%, amarela até 79% e vermelha a partir de 80%. O custo fica verde abaixo de US$ 5, amarelo até US$ 20 e vermelho acima. É instalada via `statusLine` no `settings.json`.

### 5.4 Desktop (`desktop/`, Electron)

Captura `macos.png`. Traz o servidor embutido (`server-host.ts`). O menu da bandeja mostra "Listening on :4820", sessões ativas, agentes trabalhando e eventos de hoje, e tem Open Dashboard (⌘O), Open in Browser, Restart Server, Show Logs, Open at Login e Quit. Corrige o PATH do shell (`shell-path.ts`) e é empacotado em DMG e NSIS (há também um wizard para Windows).

### 5.5 VS Code (`vscode-extension/`)

Captura `vscode.png`. Uma sidebar com:
- status do servidor ("localhost:4820 · live · Online");
- **Live stats** com sparklines (Sessions, Agents, Tokens, Cost), atualizadas a cada 5 s;
- **Agent health**, uma barra empilhada com working, idle, error, connected e completed;
- **Recent sessions**, com ícone de status, título, idade e chip do modelo.

Também há um webview com o dashboard completo numa aba do editor e um item na barra de status (`Claude: Ns | Na`). Toda a extensão aponta fixo para localhost e não manda token, então não funciona com `DASHBOARD_TOKEN` ligado.

### 5.6 CLI (`cli/`, `bin/`)

`ccam` (Commander) com cerca de 60 comandos:

- servidor: `start`, `stop`, `logs`, `open`;
- monitoramento: `stats`, `kanban`, `top`, `tail`, `stream`, `watch`;
- dados: `sessions`, `transcript`, `run` e afins;
- configuração: alertas, webhooks, pricing, remote-sources;
- administração: `doctor`, `export`, `mcp`;
- completion para bash, zsh e fish.

Tem modo `--json` e um modo offline que lê o SQLite direto. Ver `docs/CLI.md`.

---

## 6. Deploy e operação

- **Local**: Node ≥ 22.22 e `npm run setup` (instala client, server e mcp e grava os hooks em `~/.claude/settings.json` com caminho absoluto do checkout).
  - Desenvolvimento: `npm run dev` (API em 4820, Vite em 5173).
  - Produção: `npm start` (a mesma porta serve a UI compilada).
  - MCP: `npm run mcp:start[:http|:repl]`.
- **Docker**: `Dockerfile` e `docker-compose.yml`, com os perfis `mcp` (8819) e `edge` (nginx unprivileged). `docker-compose.full.yml` acrescenta Prometheus e Grafana.
- **Kubernetes**: `deployments/kubernetes/base` (Kustomize, com overlays e um componente sidecar de MCP) e um chart **Helm** (`deployments/helm/agent-monitor`). O chart força `replicaCount: 1` e o schema rejeita HPA, porque o SQLite só admite um escritor.
- **Terraform**: só um `helm_release` em um namespace existente. **Não provisiona nuvem** (nem AWS, nem GCP).
- Há snippets de nginx e um exemplo de Coralogix.
- **Autenticação**: assume loopback.
  - Tokens estáticos opcionais: `DASHBOARD_TOKEN` (UI e API), `DASHBOARD_HOOK_TOKEN`/`CCAM_HOOK_TOKEN` (ingestão de hooks), `MCP_HTTP_AUTH_TOKEN` (MCP HTTP). Cada um aceita a variante `*_FILE`.
  - CORS restrito e verificação de segurança em `server/lib/security.js`.
- **Multiusuário**: **não existe.** Não há `user_id`, `org_id`, login nem papéis. "Time" significa um dashboard que agrega máquinas por SSH ou push, com um token compartilhado.
- **Idiomas**: en, zh, vi, es, ko (`client/src/i18n/locales`, 15 namespaces).
- **Docs**: `docs/*.md` (API, CLI, DATABASE, DEPLOYMENT, HOOKS, I18N, MCP, PLUGINS), OpenAPI com Swagger e Redoc servidos pelo próprio servidor, e um site estático de wiki em `wiki/`.

---

## 7. O que levar para o Ahrena Console

Critério: um time usa no mês que vem. A proposta 0.0.1 já define "ver primeiro, controlar depois". As prioridades abaixo seguem isso. As colunas mostram onde cada coisa cabe:

- **Mod**: painel lateral com elementos nativos (Box, Text, Button, Select, Input, Svg, Markdown, Code, Link, Client).
- **Artefato**: HTML completo, lendo o núcleo local via `host:` com long polling.
- **Hub**: nuvem AWS serverless para o time.

### P0: MVP

| Item (origem no CCAM) | Mod | Artefato | Hub |
| --- | --- | --- | --- |
| **Inbox "quem precisa de você"**: lista de sessões em waiting, ordenadas por urgência do motivo (`notification` e `interrupted` primeiro), com o chip do motivo e o tempo esperando. É a adaptação do `AWAITING_REASON_CONFIG` | **Sim, é o coração do painel**: Box por linha, Text com o status, Link para abrir a sessão | Sim, como coluna fixa | Sim, para o time inteiro |
| **Contadores ao vivo** (Live, Waiting, Errored, custo de hoje). Origem: TabbyPanel e os StatCards | Sim, uma faixa de 3 ou 4 Text | Sim | Sim |
| **Badge de status com 5 cores + motivo** (emerald, yellow, violet, red, slate) | Sim, Box colorido com Text | Sim | Sim |
| **Máquina de estados com watchdog** (turno morto em 120 s, sonda de processo, `abandoned` em 180 min, cura de erro obsoleto). Sem isso o inbox mente | Núcleo | Núcleo | Precisa de um heartbeat da máquina |
| **Lista de sessões** com busca, filtro de status e projeto, ordenação por custo ou atividade, e colunas Session, Status, Last active, Duration, Agents, Cost, Directory | Versão curta: Select de filtro e as 10 primeiras | **Sim, tela principal** | Sim, com coluna de pessoa e máquina |
| **Detalhe da sessão, aba Agents**: KPIs, Top tools, Token flow, árvore de subagentes com custo por nó e Task Progress | Só o resumo (Markdown) | **Sim** | Sim |
| **Detalhe da sessão, aba Conversation**: markdown, blocos de ferramenta que expandem, seletor de subagente, paginação | Não (pesado demais) | **Sim** | Opcional: transcript só sob consentimento |
| **Kanban de status** só leitura (Sessions: Active, Waiting, Completed, Error, Abandoned). O card se move pelo status, sem arrastar | Não | **Sim**, é barato depois que a lista existe | Sim, por pessoa |
| **Custo e tokens com tabela de preços editável**, buckets de cache 5m e 1h, baseline de compactação, "unpriced" explícito, tudo marcado como estimativa | Total de hoje e da semana | Sim (Cost Analytics: linha diária, donut por modelo) | Sim, por pessoa, projeto e cliente |
| **Medidor de contexto** ("62.6k / 200k (31%)") | Sim, uma barra em Svg | Sim | — |
| **Indicador Live e saúde da coleta** (modal Connection details e `console_doctor`) | Sim, um ponto verde ou vermelho | Sim | Sim, máquinas que pararam de reportar |
| **Ferramentas MCP enxutas**: não copiar as 103. Ficar nas ~10 da proposta (fleet_overview, sessions_needing_attention, list_sessions, get_session, search_sessions, usage_report, query_sql, console_doctor) | — | — | As mesmas, servidas pelo hub |

### P1: logo depois

| Item | Mod | Artefato | Hub |
| --- | --- | --- | --- |
| **Activity Feed** com filtros facetados, Pause e detalhe por ferramenta | Últimos 5 eventos | Sim | Sim |
| **Timeline da sessão** (feed restrito à sessão) | Não | Sim | Sim |
| **Analytics**: heatmap de 52 semanas, barras de 30 dias, custo por modelo e por dia da semana, token mix, tool usage | Não | Sim (SVG próprio ou D3, como o CCAM) | Sim, com comparação entre pessoas |
| **Command palette** ⌘K com ações da página | Não se aplica (o mod já tem `/console`) | Sim | Sim |
| **Alertas por regra** (`inactivity`, `status_duration`, `token_threshold`, `event_pattern`) com cooldown e ack | Mostrar os alertas abertos | Editor de regras | **Sim, o lugar natural é o hub** (as regras valem para o time) |
| **Webhooks** (Slack, Teams, Google Chat, generic) com Test e histórico de entregas | Não | Não | **Hub** |
| **Workflows: Dynamic Workflows** (runs do Workflow tool: fases, tabela por agente, resultados) | Não | Sim | Sim |
| **Notificação local** quando algo entra em waiting com motivo `notification` | Sim, se o mod tiver toast | — | Push ou Slack |
| **Statusline** com contexto, custo e branch | É a origem dos limites oficiais | — | — |

### P2: depois do MVP

| Item | Onde |
| --- | --- |
| Workflow intelligence completa (DAG agregado, Sankey de ferramentas, grafo de colaboração, delegação de modelo, propagação de erro, scatter de complexidade) | Artefato ou hub. Valor alto para demo e baixo no dia a dia |
| Run/Resume pelo console (stream-json, multi-turno, permission mode) | Artefato e mod são o lugar da 0.0.2, junto com responder e aprovar |
| Editor de config (skills, hooks, MCP, memória, com backup) | Artefato. Cuidado com a escrita em `~/.claude` |
| Health do servidor (CPU, heap, donut de storage, health score composto) | Artefato, numa aba "Diagnóstico" |
| Multi-máquina por SSH pull | **Não levar.** O hub resolve com push, e a decisão de push-only já está na proposta |
| Export e restore, snapshots, Prometheus e Grafana | Hub (export por tenant). Prometheus fica opcional |
| Buddy (Tabby) | Opcional. A ideia que vale é o "Ask" local que responde do cache e passa para o Claude o que não sabe. Isso cabe no mod: Input + Button |
| Codex e Cursor | Depende da resposta à pergunta 3 da proposta |

### O que o CCAM não tem e o Ahrena Console precisa (hub)

1. Multiusuário de verdade (`org_id`, `user_id`, papéis), com SSO.
2. Visão por cliente e por org (o CCAM só filtra por máquina).
3. Ingestão por push autenticado por máquina (token por máquina, não um token compartilhado).
4. Sessões headless (OTel) ao lado das interativas.
5. Retenção e redação de segredos antes de qualquer transcript sair da máquina.
6. Limites oficiais (5 h e 7 dias), que só a statusline traz.

### Lições de engenharia

- O CCAM espalha um único conceito por arquivos gigantes (Run.tsx com 4,8 mil linhas, CcConfig.tsx com 4,3 mil, hooks.js com 2,5 mil).
- A lógica de estado é sofisticada justamente porque hooks se perdem. Vale copiar as regras (watchdog, sonda de processo, cura de erro), não o código.
- Gráficos em SVG próprio e D3, sem lib de gráficos, mantêm o bundle pequeno. Isso combina com o artefato de arquivo único.
- O MCP espelhar a REST 1:1 gerou 103 ferramentas, o que pesa no contexto. O Ahrena Console deve desenhar o MCP pelas perguntas do usuário, não pelos endpoints.
