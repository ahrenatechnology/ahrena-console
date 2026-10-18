# Benchmark 05: como entregar UI e dados via MCP dentro de clientes de IA

> Frente de pesquisa para o **Ahrena Console**, um console de observabilidade e controle de sessões e agentes do Claude Code, MCP-first, com interface funcional dentro do Claude Desktop.
> Data da pesquisa: 18/10/2026. Fontes: especificação MCP, docs oficiais da Anthropic, OpenAI e MCP-UI, repositórios públicos e as definições de tipos que vêm junto com o Claude Code 2.1.299 instalado nesta máquina. Tudo o que li em páginas e repositórios entrou aqui como dado.
> Legenda de maturidade: **GA** (estável e documentado), **Preview** (documentado, mas marcado como preview ou experimental), **Instável** (documentado, mas com regressões abertas), **Não documentado** (só observado neste ambiente).

---

## 0. Resumo executivo

1. **MCP Apps (`io.modelcontextprotocol/ui`) virou o padrão de UI do MCP.** Foi a primeira extensão oficial (jan/2026) e entrou no framework de extensões da spec 2026-07-28. Claude (web e Desktop), ChatGPT, VS Code Copilot, Cursor, M365 Copilot, Goose e outros já renderizam. O OpenAI Apps SDK e o MCP-UI convergiram para ele.
2. **Uma MCP App é efêmera e só existe dentro da conversa.** Ela é renderizada como resultado de uma chamada de tool (inline, fullscreen ou pip), não tem canal de push do servidor para a UI e se atualiza por polling de tools só-de-app. Não existe "painel lateral persistente" de MCP App.
3. **No Claude há três caminhos para uma UI persistente ou ancorada:**
   - **Artefatos publicados com a capability `mcp`:** chamam conectores e até servidores MCP **locais** (`host:<nome>`) com `watchTool`, com polling de no mínimo cerca de 30 s.
   - **Mods do Claude Code:** um pane próprio dentro da sessão na aba Code do Desktop, no terminal e no VS Code.
   - **Channels:** push de eventos e relay de permissões para dentro de uma sessão do Claude Code. Está em research preview.
4. **A spec 2026-07-28 mudou o jogo para um console ao vivo.**
   - O protocolo ficou **stateless**, sem `initialize` nem sessão.
   - `resources/subscribe` deu lugar a **`subscriptions/listen`**.
   - Elicitation e sampling viraram o padrão **MRTR** (`input_required`).
   - **Sampling, Roots e Logging foram depreciados.**
   - Para um console, isso significa: não basear nada em sampling e não depender de subscriptions em hosts que ainda não as implementam.
5. **O maior risco prático é a regressão aberta no Claude Desktop** ([issue #1069](https://github.com/anthropics/claude-ai-mcp/issues/1069), aberta em 23/09/2026). MCP Apps de **servidores locais stdio** (inclusive `.mcpb`) estão saindo só como texto em builds recentes de Windows e macOS. Como conector HTTP remoto, a mesma UI funciona.

---

## 1. Mecanismos: como funcionam, quem suporta e maturidade

### 1.1 MCP Apps (extensão oficial de UI, SEP-1865)

**O que é.** A extensão `io.modelcontextprotocol/ui` deixa um servidor MCP entregar HTML interativo que o host renderiza dentro da conversa. A spec de referência é `specification/2026-01-26/apps.mdx` no repositório [`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps). Desde a release 2026-07-28 ela faz parte do framework de extensões versionadas, negociado pelo campo `extensions` das capabilities.

**Como funciona**

1. A tool declara `_meta.ui.resourceUri: "ui://..."` na sua descrição, e o host pode pré-carregar a UI antes da chamada.
2. O recurso `ui://` é lido com `resources/read`. O MIME é `text/html;profile=mcp-app` e o conteúdo é HTML, normalmente com JS e CSS embutidos.
3. O host renderiza o HTML num **iframe sandboxed** (num WebView nativo no mobile) com uma origem dedicada, separada da origem do host.
4. UI e host conversam por **JSON-RPC sobre `postMessage`**, num "dialeto" do MCP:
   - **UI → host:** `ui/initialize`, `ui/message` (manda uma mensagem ao chat), `ui/update-model-context` (atualiza o contexto do modelo sem gerar mensagem), `ui/open-link`, `ui/request-display-mode`, `ui/notifications/size-changed`, além de `tools/call` e `resources/read` repassados ao servidor.
   - **Host → UI:** `ui/notifications/tool-input`, `tool-input-partial` (streaming dos argumentos), `tool-result`, `tool-cancelled`, `host-context-changed` (tema, locale, dimensões, safe areas) e `ui/resource-teardown`.

**Recursos relevantes para um console**

- **Visibilidade de tools:** `_meta.ui.visibility: ["model","app"]` é o padrão. `["app"]` cria **tools só-de-app**, que o modelo não vê e a UI pode chamar, desde que pela mesma conexão de servidor. É o mecanismo certo para polling e para ações de botão.
- **Display modes:** `inline`, `fullscreen` e `pip`. A app declara os modos que suporta e o host decide. No Claude, o fullscreen mantém o composer visível. As diretrizes do Claude citam "inline card", "inline carousel" e "full screen", e não citam pip.
- **CSP declarativa:** `_meta.ui.csp` com `connectDomains`, `resourceDomains`, `frameDomains` e `baseUriDomains`. O padrão é `connect-src 'none'`. No Claude, `frameDomains` está **restrito até passar por revisão de segurança**.
- **Permissões opcionais:** câmera, microfone, geolocalização e `clipboardWrite`. O host pode negar.
- **`_meta.ui.domain`:** a origem do sandbox. No Claude ela é `sha256(urlDoServidor)[0:32].claudemcpcontent.com`. **Não se aplica a servidores locais stdio**, que não têm URL.
- **Tema:** o host injeta tokens CSS (`--color-background-primary` etc.). No Claude, light e dark são obrigatórios.

**Limitações da spec atual**

- Não há **canal de push servidor → UI**. A UI só recebe o que o host repassa (resultado de tool e list-changed). Atualização ao vivo, na prática, é polling de tool só-de-app; o exemplo oficial `system-monitor-server` faz polling a cada 2 s.
- Só HTML, e **um único recurso de UI por resposta de tool**.
- Ficaram para depois: embutir URL externa (`externalUrl`), persistência de estado, comunicação view ↔ view e API de screenshot.
- A app vive no ciclo de uma mensagem. Rolou a conversa ou recarregou, ela é reinstanciada, e o estado precisa morar no servidor.

**Quem suporta** ([matriz oficial](https://modelcontextprotocol.io/extensions/client-matrix)): Claude web, Claude Desktop, ChatGPT, VS Code GitHub Copilot, Cursor, Microsoft 365 Copilot, Goose, Postman, MCPJam, Archestra.AI e PostHog Code. Na versão mobile do Claude também renderiza, em WebView, mas o conector precisa ser adicionado na web ou no Desktop.
**Não suporta:** o Claude Code CLI e as tools do Claude Code no geral. Não achei nenhuma fonte de render de `ui://` no Claude Code. O fallback é o texto do resultado da tool.

**SDK:** [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps), com:

- `registerAppTool` e `registerAppResource` no servidor, que geram o metadata de cada host, inclusive os aliases do ChatGPT;
- a classe `App` na UI;
- o `AppBridge` para quem implementa host.

Há templates para React, Vue, Svelte, Preact, Solid e vanilla, e um plugin de skills para o Claude Code: `/plugin marketplace add modelcontextprotocol/ext-apps`.

**Maturidade:** **GA no padrão**, adotado por vários hosts. No Claude Desktop o **caminho local está Instável** (issue #1069, descrita na seção 4).

### 1.2 MCP-UI (`@mcp-ui/server` e `@mcp-ui/client`)

**O que é.** O projeto comunitário que veio antes e inspirou o MCP Apps.

- **`@mcp-ui/server`:** `createUIResource`, com os tipos legados `rawHtml`, `externalUrl` e `remoteDom`. O `remoteDom` saiu do helper na v6.
- **`@mcp-ui/client`:** componentes React para hosts. Hoje são o `AppRenderer` e o `AppFrame`, que já renderizam MCP Apps.

**Status atual.** Virou a **implementação de referência do lado host** e uma **camada de compatibilidade**.

- **Adapter:** traduz o protocolo antigo (`prompt`, `tool`, `link`, `notify`, `ui-size-change`) para o JSON-RPC do MCP Apps. Dá para ligar o adapter `mcpApps` ou o `appsSdk`, mas só um por recurso.
- **Recomendação oficial:** app nova usa MCP Apps direto (`registerAppTool` e `_meta.ui.resourceUri`).

**Para o Ahrena Console:** usar o `@mcp-ui/client` **só se** o console standalone for também um host MCP, renderizando as próprias MCP Apps fora do Claude. No servidor, MCP Apps puro.

**Maturidade:** estável como biblioteca. Como formato de servidor está **legado**.

### 1.3 OpenAI Apps SDK (ChatGPT)

**O que é.** O SDK do ChatGPT para "apps", baseado em MCP. Usava `_meta["openai/outputTemplate"]` e a API `window.openai` (`toolInput`, `toolOutput`, `callTool`, `sendFollowUpMessage`, `widgetState`, `requestDisplayMode`).

**Status atual.** O ChatGPT **implementa o padrão MCP Apps** e a própria OpenAI [recomenda os campos padrão](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt).

- O `window.openai` ficou como camada **opcional, só do ChatGPT**, para o que o padrão não cobre: checkout (`requestCheckout`), arquivos (`uploadFile`, `selectFiles`, `getFileDownloadUrl`), modais (`requestModal`) e `widgetState` persistido por instância.
- **Boas práticas declaradas:**
  - separar tools de dados de tools de render, para não re-renderizar o widget a cada chamada;
  - versionar a URI `ui://`, que funciona como cache key;
  - não usar `localStorage` para estado central.
- A revisão de submissões confere a CSP declarada contra o comportamento real.

**Maturidade:** o SDK ainda leva o rótulo de preview, com submissões abertas. A convergência com o MCP Apps é oficial (changelog de fev/2026).

**Para o Ahrena Console:** escrevendo em MCP Apps, o console roda no ChatGPT sem esforço extra. O `window.openai` não traz nada essencial para o caso de uso.

### 1.4 Superfícies específicas do Claude Desktop e do Claude Code

| Mecanismo | O que entrega | Onde funciona | Maturidade |
|---|---|---|---|
| **Servidor MCP local** (`claude_desktop_config.json` ou `.mcpb`) | tools, resources e prompts. MCP Apps renderizam inline após o usuário clicar **Allow** ou **Always allow** | Claude Desktop (chat e Cowork) | GA para tools. **Instável para MCP Apps locais** (#1069) |
| **Desktop Extensions `.mcpb`** (antigo DXT) | Zip com `manifest.json` e servidor (node, python, uv ou binário). Instalação com um clique, `user_config` com campos sensíveis guardados no keychain, atualização automática e diretório curado | Claude Desktop para macOS e Windows | GA. **Não traz API de UI própria**: a UI continua sendo MCP Apps |
| **Conector remoto (custom connector / diretório)** | Servidor MCP HTTP com OAuth. MCP Apps com `ui.domain`. Mais de 950 servidores no diretório. Dashboard de observabilidade para o dono do conector. **MCP tunnels** (research preview) para alcançar servidores em rede privada | claude.ai web, Desktop e mobile | GA (tunnels em Preview) |
| **Artefatos com runtime capabilities** | Página HTML publicada em claude.ai/artifact/…, persistente, compartilhável e fixável na barra lateral. A capability **`mcp`** chama os conectores do usuário e **servidores MCP locais (`host:<nome>`)**. Também há `db` (documentos com `onSnapshot` ao vivo), `room` (presença e eventos efêmeros entre quem está vendo), `sample` (pergunta ao Claude), `user`, `files` (arquivos de um projeto do Claude Code) e `downloads` | claude.ai e Claude app. **`host:` só responde dentro do app Desktop** | Preview (runtime contract 0.2.85). Detalhes na seção 1.4.1 |
| **Mods do Claude Code** (plugins com hooks module) | **Pane próprio** (sidebar), faixa acima do prompt, status line, toasts e redesenho de mensagens e tools. `$.tool.register` cria tools para o modelo, e há `$.http.fetch`, `$.process`, `$.fs`, `$.clock` e `$.store`. O elemento `Client` roda um módulo JS próprio, com animação e ponteiro | Claude Code no terminal, **na aba Code do Claude Desktop** (`e.surface === 'desktop'`) e no VS Code (≥ 2.1.299). Mobile tem elementos reduzidos | Documentado ([docs](https://code.claude.com/docs/en/plugins/mods/interface)), mas **recente** e escopado a uma sessão |
| **Channels** (`claude/channel`) | Servidor MCP local que **empurra eventos** para dentro de uma sessão do Claude Code (`notifications/claude/channel`). Pode ter tool de resposta e **relay de permissões** (aprovar ou negar Bash, Write etc. remotamente via `claude/channel/permission`) | Claude Code ≥ 2.1.80, somente stdio. Canais custom exigem `--dangerously-load-development-channels` ou o allowlist da organização | **Research preview**. No runtime v2, canais com protocolo 2026-07-28 não registram |
| **Widget inline do próprio Claude** (`show_widget` / visualize) | O Claude gera HTML ou SVG inline, com `sendPrompt()` | claude.ai e Desktop | Recurso do Claude. **O servidor não controla** |
| **Ferramentas internas do Desktop sobre sessões Code** | `list_sessions`, `get_session`, `list_events`, `send_message`, `stop_session`, `set_session_permission_mode`, `get_usage`, `search_session_transcripts` e outras | Só para o agente dentro do Claude Desktop | **Não documentado**. São built-ins do app: **um artefato não pode declará-los como `host:`** |

#### 1.4.1 Artefatos que chamam MCP: o caminho mais próximo de um "painel"

Fonte: as definições `mcp.d.ts` do runtime contract 0.2.85, que vêm com o Claude Code 2.1.299.

- **Declaração na publicação:** `capabilities: {mcp: {servers: [{server: "host:ahrena-console", tools: ["list_sessions", ...]}]}}`. A lista de tools é obrigatória, explícita e mínima. Essa declaração **impede o compartilhamento público**.
- **Leitura ao vivo:** `watchTool(server, tool, input, handler, {refetchInterval})`.
  - O cache é compartilhado e as chamadas idênticas são agrupadas (N seções custam uma chamada).
  - O polling tem **piso de cerca de 30 s** e pausa com a página escondida.
  - Só aceita tools de leitura: uma tool com `readOnlyHint: false` é rejeitada.
  - Cada view comporta até 64 watches.
- **Ações:** `callTool`, uma chamada por vez. Para tool sem anotação de read-only, o app pode pedir confirmação ao usuário.
- **Servidores `host:`:**
  - Só funcionam quando a página é aberta **no app Claude Desktop**; fora dele dão `server_not_connected`.
  - **Por enquanto só o dono do artefato** usa servidores host.
  - Os argumentos ficam no dispositivo e o serviço só vê o nome da tool.
- **Combinações úteis:** `db` para histórico e anotações do time, `room` para presença de quem está vendo o console, `sample` para "explique esta sessão".

---

## 2. MCP Resources, subscriptions, sampling e elicitation: o que serve para um console ao vivo

A spec **2026-07-28** ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) reescreveu essa parte.

| Primitivo | Situação na 2026-07-28 | Suporte nos clientes Claude | Utilidade para o console |
|---|---|---|---|
| **Resources** (`resources/list`, `resources/read`, templates) | Ativo. Os resultados agora trazem `ttlMs` e `cacheScope`, que servem de dica de frescor e reduzem polling | O Claude Code permite referenciar com `@`. O Desktop expõe resources como anexos de contexto. A MCP App pode chamar `resources/read` | **Alta** para snapshots legíveis (`ahrena://session/{id}/transcript`, `ahrena://fleet/summary`) e para a própria UI (`ui://`) |
| **Subscriptions** | `resources/subscribe` e o GET de SSE foram **substituídos** por `subscriptions/listen`: um único stream POST de longa duração, em que o cliente escolhe `toolsListChanged`, `resourcesListChanged` ou `resourceSubscriptions` | `list_changed` é tratado pelo Claude Code (interativo). **Não há evidência pública** de que Claude Desktop ou claude.ai reajam a `resources/updated` ou `subscriptions/listen` levando dados até a UI | **Baixa no curto prazo.** Uma MCP App não recebe push de resource. Polling (UI) e long-poll em tool (`wait_for_update`, o padrão que já usado por outros servidores MCP de telemetria) são mais confiáveis |
| **Notificações por request** (`progress`, `message`) | Seguem no stream da própria request. O nível de log vai por request (`_meta.io.modelcontextprotocol/logLevel`) | Variável | Média, para tools longas (por exemplo, "reconstruir índice") |
| **Tasks** (`io.modelcontextprotocol/tasks`) | Saiu do core e virou extensão. Funciona por polling (`tasks/get`, `tasks/update`) | Em rollout ("em breve nos produtos Claude") | Média, para ações de controle demoradas (rodar um agente headless e acompanhar) |
| **Sampling** | **Depreciado**, com janela mínima de 12 meses | Raro em clientes | **Não usar.** Se o console precisar de LLM, chamar a API direto ou usar `sample` do artefato |
| **Elicitation** (form e URL) | Virou **MRTR**: a tool responde `resultType: "input_required"` com `inputRequests`, e o cliente reenvia a chamada com `inputResponses`. `notifications/elicitation/complete` foi removido | **Claude Code tem suporte** (≥ 2.1.76, formulário e URL). **Claude Desktop e claude.ai não tinham suporte** em meados de 2026, segundo terceiros | Útil para confirmar ações destrutivas (parar uma sessão, mudar o modo de permissão) **no Claude Code**. No Desktop, confirmar na UI da MCP App ou contar com a confirmação nativa do app |
| **Roots** | Depreciado | O Claude Code ainda responde | Não usar. Passar caminhos como parâmetro |
| **Stateless** (sem `initialize`, sem `Mcp-Session-Id`) | Obrigatório na 2026-07-28 | Rollout em andamento. Servidores precisam conviver com clientes 2025-11-25 | **Arquitetural:** o servidor do console deve guardar o estado num store (SQLite ou daemon) e usar handles explícitos (`session_id`, `cursor`) como argumentos |

**Conclusão prática para "ao vivo":**

- **Dentro de MCP App ou artefato:** polling de tool só-de-app (MCP App, poucos segundos) ou `watchTool` com `refetchInterval` (artefato, ≥ 30 s), com cursor incremental (`since_event_id`).
- **Dentro de uma sessão do Claude Code:** channels, para o modelo reagir, e mods, para a UI do pane, que pode usar `$.http.fetch` para um daemon local.
- **Standalone:** WebSocket ou SSE próprio, como fazem claude-view e agents-observe.

---

## 3. Fichas de servidores MCP de referência

### 3.1 Grafana MCP ([grafana/mcp-grafana](https://github.com/grafana/mcp-grafana))
- **Tools:** dashboards (buscar, ler, criar e atualizar, patch, extrair por JSONPath), datasources, PromQL e LogQL com descoberta de labels, Incident, Alerting (regras, contact points, silences), OnCall, Tempo, Pyroscope, SQL, render de painel em PNG e deeplinks. Também há um "generic API call".
- **Resources e prompts:** não documentados.
- **UI:** `get_tempo_trace` abre um **visualizador de trace interativo (MCP App)** nos hosts compatíveis, sem deixar de devolver o texto.
- **Transporte e segurança:** stdio, SSE e streamable-http. `--disable-write` tira todas as escritas, e `--enable-query` e `--disable-query` controlam as queries brutas. Bearer token no servidor HTTP, RBAC do Grafana e allowlist para override de URL.
- **Lição:** **UI opcional por tool, com texto sempre presente**, e **um modo read-only por flag**.

### 3.2 Sentry MCP ([getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp))
- **Tools:** issues e eventos, mais buscas em linguagem natural (`search_errors`, `search_traces`, `search_logs`, `search_issues`) feitas por um **agente embutido** (OpenAI, Anthropic ou OpenRouter), e Seer.
- **Agrupamento por skills:** `inspect`, `triage`, `seer` e `project-management`, cada uma podendo ser ligada ou desligada.
- **Transporte:** remoto (`mcp.sentry.dev/mcp`, com OAuth) e stdio (`npx @sentry/mcp-server`). É middleware sobre a API, no modelo de worker remoto.
- **UI:** nenhuma.
- **Lição:** **agrupar tools por "skill" ou papel** e **colocar um LLM dentro da tool de busca**, em vez de depender de sampling, que agora está depreciado.

### 3.3 Linear MCP (conector remoto oficial, presente neste ambiente)
- **Tools:** CRUD amplo de issues, projetos, ciclos, documentos, comentários, releases, diffs e notificações, num padrão consistente de `list_*`, `get_*` e `save_*`.
- **Transporte:** HTTP remoto com OAuth e listagem no diretório do Claude.
- **UI:** nenhuma no conjunto observado.
- **Lição:** **nomenclatura previsível** (`list`, `get`, `save`, `delete`) e **um upsert (`save_*`) no lugar de create e update separados**, o que reduz o número de tools no contexto.

### 3.4 claude-view ([tombelieber/claude-view](https://github.com/tombelieber/claude-view)): sessões do Claude Code
- **Dados:** lê os JSONL de `~/.claude/projects/`, indexa em SQLite e captura hooks em dois canais (WebSocket ao vivo mais backfill por JSONL).
- **MCP:** 85 tools, sendo 8 escritas à mão (`list_sessions`, `search_sessions`, `list_live_sessions`, `get_fluency_score`…) e 77 geradas da OpenAPI. Há ainda 9 skills (`/session-recap`, `/daily-cost`).
- **UI:** dashboard web local próprio (backend Rust, frontend React, SSE e WebSocket). **Não usa MCP Apps.**
- **Instalação:** binário ou `npx`, ou via marketplace de plugins do Claude Code. Licença MIT.
- **Lição:** **gerar tools a partir da API REST infla o catálogo** (85 tools). O console deveria expor poucas tools de alto nível e deixar o resto em resources.

### 3.5 Claude Code Agent Monitor, ou CCAM ([hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor)): sessões do Claude Code, Codex e Cursor
- **MCP:** cerca de 100 tools em grupos (sessions, agents, transcripts, analytics, alerts, config, runs, remote sources, maintenance).
- **Segurança:** **read-only por padrão**. Escrita exige `MCP_DASHBOARD_ALLOW_MUTATIONS=true`. Ações destrutivas exigem também `MCP_DASHBOARD_ALLOW_DESTRUCTIVE=true` e mais **tokens de confirmação por operação**.
- **Transporte:** stdio, HTTP/SSE com token e REPL.
- **Fluxo de uso recomendado:**
  1. escopar;
  2. buscar o detalhe;
  3. ler os eventos antes do transcript;
  4. declarar a evidência;
  5. propor a mutação;
  6. verificar.
- **UI:** dashboard web com Kanban e app nativo. Não usa MCP Apps.
- **Lição:** **o modelo de gating de mutações é diretamente reaproveitável** no plano de controle do console.

### 3.6 agents-observe ([simple10/agents-observe](https://github.com/simple10/agents-observe))
- **Captura:** um plugin do Claude Code com `hooks/hooks.json`. Os hooks de ferramenta, prompt, stop e subagente fazem POST para o servidor, e se faltar dado ele busca no transcript local.
- **MCP:** o servidor sobe automaticamente via `.mcp.json` do plugin, e a skill `/observe` faz start, stop e status.
- **UI:** dashboard em `localhost:4981` (React 19 com shadcn, Hono, SQLite e WebSocket, com histórico por REST e eventos ao vivo por WS).
- **Lição:** **plugin do Claude Code como unidade de distribuição** (hooks, MCP e skill num pacote só) é o caminho de instalação mais simples.

### 3.7 Exemplo oficial `system-monitor-server` ([ext-apps/examples](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/system-monitor-server))
- `get-system-info` é visível ao modelo e ligado à UI. `poll-system-stats` é **só-de-app** (`visibility: ["app"]`) e a UI faz polling dele **a cada 2 s**.
- **Lição:** é o **padrão canônico** de dashboard ao vivo em MCP Apps. Uma tool de "abrir" visível ao modelo e tools só-de-app para dados incrementais.

---

## 4. Três arquiteturas candidatas para o Ahrena Console

Todas partem do mesmo **núcleo**, que é independente da superfície.

- **Coletor (daemon local):**
  - hooks do Claude Code (PreToolUse, PostToolUse, Stop, SubagentStop, Notification);
  - tail dos JSONL em `~/.claude/projects`;
  - opcionalmente, OpenTelemetry do Claude Code;
  - armazenamento em SQLite.
- **Servidor MCP `ahrena-console`:**
  - stateless e compatível com 2025-11-25 e 2026-07-28;
  - poucas tools de alto nível (`fleet_overview`, `list_sessions`, `get_session`, `session_events(since)`, `explain_session`);
  - tools de controle com gating (`stop_session`, `send_to_session`, `set_permission_mode`, `approve_pending`);
  - resources `ahrena://…` para snapshots.
- **Bundle de UI único (HTML/JS):** servido como `ui://ahrena/console` (MCP App), como artefato e como web standalone.

### Arquitetura A: MCP App nativa (padrão aberto, renderização inline e fullscreen)

**Como funciona**

- A tool `open_console` (visível ao modelo) tem `_meta.ui.resourceUri = ui://ahrena/console-v1` e abre um dashboard que pede **fullscreen**.
- As tools só-de-app `poll_fleet(since)`, `session_detail(id)` e `act(...)` alimentam a UI por polling de 2 a 5 s.
- `ui/update-model-context` injeta no Claude o que o usuário está olhando, por exemplo "sessão X selecionada", e `ui/message` dispara perguntas do tipo "por que a sessão X travou?".
- **Distribuição:**
  - **conector HTTP remoto** (recomendado por causa do #1069 e do `ui.domain`). Pode rodar numa máquina remota via túnel, ou na nuvem com um agente local mandando dados;
  - `.mcpb` para quem quiser rodar local.

**Prós**
- É **padrão aberto** e funciona com **o mesmo código** no Claude web, Desktop, mobile, ChatGPT, VS Code Copilot e Cursor.
- A UI está **colada na conversa**: o Claude vê o contexto selecionado e age por meio das mesmas tools.
- A segurança fica por conta do host (sandbox, CSP e consentimento "Allow").
- O ecossistema de SDK e exemplos está maduro (`registerAppTool`, templates React).

**Contras**
- **Não há painel persistente.** O console aparece quando o modelo chama a tool, some com o scroll e reinicia a cada render.
- **Sem push.** É polling, que custa chamadas e latência. Em host com aprovação por tool, o polling só-de-app não passa pelo modelo, mas é preciso confirmar se cada host trata isso sem pedir aprovação.
- **Caminho local instável no Claude Desktop** (#1069). `ui.domain` só existe para servidor remoto. `frameDomains` é restrito, então não dá para embutir o console standalone via iframe.
- O **Claude Code CLI não renderiza** a UI.
- As diretrizes do Claude desaconselham navegação profunda, menus e popovers dentro da app. Um console rico precisa caber em fullscreen com abas e paginação.

### Arquitetura B: artefato persistente que fala com o servidor MCP local (`host:ahrena-console`)

**Como funciona**

- O Ahrena Console é um **artefato publicado** no claude.ai, fixado na barra lateral, declarando:
  - `mcp: {servers: [{server: "host:ahrena-console", tools: [...]}]}`;
  - opcionalmente `db` (anotações, incidentes e histórico do time), `room` (quem está olhando), `sample` ("resuma esta sessão") e `user`.
- Os painéis usam `watchTool` com `refetchInterval` (piso de cerca de 30 s), e as ações usam `callTool`, com a confirmação do app para tools que não são read-only.
- O servidor MCP local é instalado como `.mcpb` ou entrada de config no Desktop, e é o mesmo servidor da Arquitetura A, que continua oferecendo a MCP App inline para uso conversacional.

**Prós**
- **Persistente e endereçável:** URL própria, fica na barra lateral, versionado. É o mais perto de "abrir o console dentro do Claude Desktop" como app.
- Alcança **dados locais da máquina** (sessões em `~/.claude`) **sem expor nada na internet**. Os argumentos ficam no dispositivo.
- Ganha de graça `db` com `onSnapshot`, presença multiusuário e LLM (`sample`) sem gerir chaves.
- Encaixa no fluxo de artefatos versionados que a Ahrena já usa (skills `versioning-artifacts` e `publishing-artifacts`).

**Contras**
- **É proprietário do claude.ai.** Não roda no ChatGPT nem no VS Code, e o contrato ainda é 0.2.x.
- **`host:` só funciona no app Desktop e só para o dono do artefato** (por enquanto). Um console de time precisa de um servidor remoto (conector) em vez de `host:`.
- **Polling com piso de cerca de 30 s** não serve para "ao vivo" de verdade, por exemplo um log de tools em streaming.
- Declarar `mcp` **impede o compartilhamento público**, e cada servidor exige consentimento do visitante.
- Não cobre a sessão do Claude Code por dentro: não há como aprovar um prompt de permissão em tempo real.

### Arquitetura C: plugin do Claude Code (mod com pane, hooks, MCP e channels)

**Como funciona**

- Um **plugin do Claude Code** (marketplace Ahrena) empacota:
  - **hooks** de ingestão para o coletor;
  - o **servidor MCP** `ahrena-console`;
  - um **mod** com `$.ui.open({id:'ahrena-console'})`, que abre um **pane lateral persistente** na aba Code do Desktop, no terminal e no VS Code, desenhado por `ui.render` com elementos nativos (Box, Text, Button, Select, Svg e Markdown, mais `Client` para gráficos animados). O pane lê o daemon via `$.http.fetch` e se redesenha em timer (`$.clock`);
  - um **channel** (`claude/channel` com `claude/channel/permission`) que injeta alertas da frota na sessão e **relaya prompts de permissão** de outras sessões para aprovação.
- **Visão da frota:** o pane mostra a frota inteira, e o modelo consulta via tools.
- **Visão standalone:** a mesma API do daemon serve uma web local.

**Prós**
- É **o único caminho com UI persistente ao lado do trabalho** dentro do Claude Desktop (aba Code), com atualização tão rápida quanto o timer e **sem polling via modelo**.
- Tem **plano de controle real**: hooks podem bloquear tools (`tool.call` → `deny`), channels aprovam permissões remotamente, e o daemon fala direto com os processos.
- Distribuição e atualização via marketplace de plugins, como agents-observe e claude-view já fazem.

**Contras**
- **Fica restrito ao Claude Code.** Não aparece no chat do Claude Desktop nem no claude.ai, nem em outros clientes.
- A **API de mods é nova** e muda com frequência (versionada pelo build do CC). A UI é limitada a elementos nativos, sem HTML arbitrário, salvo no `Client`.
- **Channels são research preview:** canais custom exigem uma flag `--dangerously-…` ou o allowlist da organização (Team/Enterprise), e no runtime v2 não registram com protocolo 2026-07-28.
- O pane é **por sessão**: um console de frota aberto em cada sessão duplica o trabalho, então é preciso um daemon único.

### Recomendação de composição (para discussão)

Não escolher só uma. O desenho mais robusto é **núcleo único + três superfícies finas**:

1. **Agora:** núcleo (daemon e servidor MCP) mais **A como conector remoto**, com `open_console` em fullscreen e polling só-de-app. É o que dá UI dentro do Claude Desktop e do claude.ai hoje com padrão aberto. Publicar também `.mcpb`, mas só depender do caminho local quando o #1069 for resolvido.
2. **Em paralelo:** **B** como "home" fixada do console para o dono da máquina, reaproveitando o mesmo bundle de UI e as mesmas tools.
3. **Para operadores no Claude Code:** **C** (pane, hooks e channel) quando a necessidade for controle em tempo real e aprovação de permissões.
4. **Standalone:** o daemon serve o mesmo bundle com WebSocket e SSE, para quem estiver fora do Claude.

---

## 5. Riscos e lacunas (o que ainda não dá para fazer)

1. **Não existe painel lateral persistente via padrão MCP.** O MCP Apps é inline, fullscreen ou pip e está preso a uma mensagem. A persistência só vem de artefatos (claude.ai) ou de mods (Claude Code), ambos proprietários.
2. **Sem push servidor → UI no MCP Apps.** Também não há evidência de que os hosts Claude repassem `subscriptions/listen` ou `resources/updated` à UI. Ao vivo, por enquanto, é polling: segundos na MCP App e no mínimo cerca de 30 s no artefato.
3. **Regressão do Claude Desktop com MCP Apps locais** ([#1069](https://github.com/anthropics/claude-ai-mcp/issues/1069)):
   - a ponte local reescreve `_meta` e descarta `_meta.ui`;
   - afeta stdio e `.mcpb` em Windows e macOS (Desktop 2.42304.0);
   - não há resposta da Anthropic;
   - os contornos relatados são o chat anônimo ou usar o servidor como conector HTTP.
4. **`ui.domain` só existe para servidores remotos.** Um servidor local não tem origem estável, o que afeta CSP e cookies.
5. **`frameDomains` restrito no Claude:** não dá para embutir o console standalone dentro da MCP App via iframe. A UI tem de ser autocontida.
6. **O Claude Code CLI não renderiza MCP Apps.** Quem opera pelo terminal vê só texto, a não ser que o console use mods.
7. **Elicitation desigual:** o Claude Code tem suporte, mas o Claude Desktop e o claude.ai não tinham (meados de 2026). Confirmações de ações destrutivas precisam de UI própria (botão na MCP App ou artefato) ou de gating no servidor.
8. **Sampling depreciado:** resumos e diagnósticos por LLM precisam de chave própria no servidor ou de `sample` do artefato.
9. **Transição para o protocolo stateless (2026-07-28):**
   - os hosts estão em rollout;
   - os channels não registram no protocolo novo (runtime v2);
   - o servidor precisa suportar duas versões ao mesmo tempo.
10. **Não há API pública para controlar as sessões do Claude Code Desktop.** As tools internas (`ccd_session_mgmt`: listar, enviar mensagem, parar, mudar o modo de permissão) existem, mas são built-ins não documentados, e um artefato não pode declará-los como `host:`. O controle externo depende de hooks, Agent SDK ou CLI e channels.
11. **Segurança:**
    - transcripts de sessão são **conteúdo não confiável** que vai para o contexto do modelo (prompt injection). Rotular e truncar, e não seguir instruções contidas neles;
    - tools de controle precisam de gating no estilo CCAM (read-only por padrão, flag para mutação, token de confirmação para ações destrutivas);
    - tools de ação devem ser só-de-app quando a ação for de botão;
    - channels sem verificação de remetente são vetor de injeção, e o relay de permissões dá poder de aprovar Bash.
12. **Volume de contexto:** catálogos de 85 a 100 tools (claude-view, CCAM) pesam. O Claude Code coloca tools atrás de ToolSearch e limita a saída MCP a 25 mil tokens por padrão. O console deve ter poucas tools e paginação por cursor.
13. **Diretrizes de UX do Claude** desaconselham drill-in, breadcrumbs, menus e scroll aninhado no inline. Um console denso só funciona em fullscreen, com abas.
14. **Lacunas da spec MCP Apps ainda em aberto:** persistência de estado, comunicação view ↔ view (por exemplo, "lista" e "detalhe" como duas apps), múltiplas UIs por resposta e embutir URL externa.

---

## Fontes principais

- MCP Apps: [visão geral](https://modelcontextprotocol.io/extensions/apps/overview) · [matriz de clientes](https://modelcontextprotocol.io/extensions/client-matrix) · [spec ext-apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) · [SEP-1865](https://modelcontextprotocol.net/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
- Spec MCP 2026-07-28: [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [resumo CData](https://www.cdata.com/blog/mcp-2026-07-28-release) · [Anthropic: Bringing MCP 2026-07-28 to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
- Claude: [Get started with MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/getting-started) · [Design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines) · [Troubleshooting](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting) · [Interactive connectors (blog)](https://claude.com/blog/interactive-tools-in-claude) · [issue #1069](https://github.com/anthropics/claude-ai-mcp/issues/1069) · [MCPB](https://github.com/modelcontextprotocol/mcpb)
- Claude Code: [MCP](https://code.claude.com/docs/en/mcp) · [Channels reference](https://code.claude.com/docs/en/channels-reference) · [Mods: interface](https://code.claude.com/docs/en/plugins/mods/interface) · definições de tipos locais (`plugin-authoring/types/claude-code.d.ts`, `artifact-capabilities/0.2.85/mcp.d.ts`, Claude Code 2.1.299)
- OpenAI: [MCP Apps compatibility in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt) · [changelog](https://learn.chatgpt.com/apps-sdk/changelog)
- MCP-UI: [MCP Apps integration](https://mcpui.dev/guide/mcp-apps) · [mcp-use widgets](https://docs.mcp-use.com/typescript/api-reference/server/widgets)
- Elicitation: [Claude Code 2.1.76](https://www.havoptic.com/r/claude-code-2.1.76) · [RelativityOne (matriz de clientes)](https://help.relativity.com/RelativityOne/Content/Relativity/MCP/Anthropic_Claude.htm) · [feature request Desktop](https://claudeissues.com/issue/41347-feature-mcp-elicitation-support-in-claude-desktop-app)
- Servidores: [mcp-grafana](https://github.com/grafana/mcp-grafana) · [sentry-mcp](https://github.com/getsentry/sentry-mcp) · [claude-view](https://github.com/tombelieber/claude-view) · [CCAM MCP Workflows](https://github.com/hoangsonww/Claude-Code-Agent-Monitor/wiki/MCP-Workflows) · [agents-observe](https://github.com/simple10/agents-observe) · [system-monitor-server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/system-monitor-server)
