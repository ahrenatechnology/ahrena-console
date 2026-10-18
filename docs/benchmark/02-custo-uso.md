# Benchmark 02 — Custo, uso e métricas

Frente: custo, uso e métricas para o **Ahrena Console** (MCP-first, roda dentro do Claude Desktop como servidor MCP local + artefato/painel, sem depender de terminal/TUI).

Data da pesquisa: 2026-10-18. Stars e atividade são aproximados, lidos da API do GitHub nessa data. Nada foi instalado nem executado. O esquema do `.jsonl` foi conferido lendo transcripts reais deste Mac (só leitura).

---

## 1. Resumo executivo

- **Existem três fontes de dados, e elas se complementam**:
  1. **Transcripts locais** (`~/.claude/projects/**/*.jsonl`): é a única fonte que permite **backfill** do histórico, funciona sem configurar nada e é a base de ccusage, Claude-Code-Usage-Monitor, sniffly e claude-code-log. Limite: o Claude Code apaga transcripts com mais de 30 dias por padrão (`cleanupPeriodDays`), então o console precisa **guardar uma cópia própria** (um "warehouse").
  2. **OpenTelemetry oficial**: tempo real, multi-máquina, gerenciável por admin (managed settings). Só cobre o que acontece **depois** de ligado. É a única fonte com **aceitação de edições por linguagem**, latência e erros de API e eventos de permissão.
  3. **APIs de organização** (Claude Code Analytics Admin API, Enterprise Analytics API e o dashboard claude.ai/analytics): agregado diário por usuário, com até 1 h de atraso. A camada de **contribuição** (PRs com CC, via GitHub App) só existe ali.
- **A fonte oficial de limites é o statusline.** O JSON que o Claude Code entrega ao statusline traz `rate_limits.five_hour` e `rate_limits.seven_day` (`used_percentage`, `resets_at`) e, atrás de um gateway, `spend_limit`. Ferramentas maduras (Usage Monitor v4, ccstatusline) já trocaram a estimativa local por esse dado oficial e **rotulam a procedência** de cada número. O Ahrena Console deve fazer o mesmo.
- **Nenhuma das ferramentas é MCP-first nem roda dentro do Claude Desktop.** Todas são CLI/TUI, dashboard web local ou stack Grafana. Esse é o espaço livre para o Ahrena Console.

---

## 2. Fichas

### 2.1 ccusage (ryoppippi/ccusage, hoje ccusage/ccusage)

- **O que é:** CLI que lê os logs locais de agentes de código e gera relatórios de tokens e custo.
- **Licença:** MIT (o GitHub mostra "Other/NOASSERTION", mas o arquivo LICENSE é MIT).
- **Stars/atividade:** ~19k stars, commits diários (push em 2026-10-18). Monorepo com binários nativos em Rust por plataforma (`packages/ccusage-darwin-arm64` etc.).
- **Fonte de dados:** `.jsonl` local (Claude Code em `~/.claude/projects` e `CLAUDE_CONFIG_DIR`) e os formatos de mais 17 CLIs (Codex, OpenCode, Amp, Gemini CLI, Copilot CLI, Goose, Qwen, Kimi...). Preços vêm de uma tabela em cache (historicamente LiteLLM), com `--offline` e sobrescrita por modelo em `ccusage.json`.
- **Features:**
  - relatórios `daily`, `weekly`, `monthly`, `session`;
  - `blocks`: janelas de 5 h (bloco começa na primeira mensagem e dura 5 h; linhas de "gap"; bloco ativo com tempo restante, burn rate em tokens/min e US$/h e projeção de total);
  - `--token-limit` / `-t max` (usa o maior bloco anterior como teto), com barra verde/amarela/vermelha em 70/90%;
  - `--breakdown` por modelo; tokens de cache de criação e de leitura separados;
  - `--instances` / `--project`: agrupa por projeto;
  - `--since/--until`, `--last 1`, `--timezone`;
  - `--json` com seções (`--sections daily,monthly,session`) e `--by-agent`;
  - `--mode auto|calculate|display` (usa o `costUSD` gravado ou recalcula);
  - `statusline` (beta) para o hook do Claude Code;
  - `--no-cost` para esconder valores (útil em screenshots).
- **Diferencial:** padrão de fato, multi-agente (18 CLIs), JSON estável e rápido (Rust).
- **O que aproveitar no Ahrena Console:**
  - o **modelo de agregação** (dia/semana/mês/sessão/bloco 5 h/projeto/modelo) e o contrato JSON como referência de esquema das tools MCP (`usage_report(granularity, since, until, group_by)`);
  - a **sobrescrita de preço por modelo** em arquivo de config (essencial para Bedrock e preços negociados, alinhado a um desenho multi-provider);
  - o **modo de custo** (confiar no `costUSD` gravado ou recalcular);
  - o **`-t max`** como teto heurístico quando não há limite oficial;
  - o suporte multi-agente como roadmap (Codex etc.).
- **Fraquezas:** só CLI; `--live` foi **removido** na v18 (o tempo real migrou para o statusline); não tem alertas, persistência própria (perde o que o Claude Code apagar após 30 dias), multi-máquina nem MCP. O custo é estimado a preço de lista.

### 2.2 Claude Code Usage Monitor (Maciek-roboblog/Claude-Code-Usage-Monitor, pacote `claude-monitor`)

- **O que é:** monitor em tempo real (TUI com Rich) de uso e limites, com previsões. Na v4 virou um "Usage-Ops companion".
- **Licença:** MIT.
- **Stars/atividade:** ~8,7k stars; último push em 2026-07 (ativo, mas menos frequente).
- **Fonte de dados:** `.jsonl` local (vários diretórios via `--data-paths`, `CLAUDE_CONFIG_DIR`, descoberta no WSL) + **`rate_limits` oficial capturado via `--statusline`** + API OAuth de uso, experimental e opt-in (`--api`).
- **Features:**
  - views `realtime`, `daily`, `monthly`, `session`, `entries`, `sessions`, `burn-rate`;
  - planos `pro`, `max5`, `max20`, `team` e `custom`. O `custom` é o padrão e calcula um limite pessoal pelo **P90 das sessões das últimas 192 h**;
  - três métricas por janela: tokens, mensagens e custo;
  - **camada de confiança:** usa o `rate_limits` oficial quando está fresco e cai para estimativa local **rotulada** quando ele expira;
  - **rótulos de procedência** em todo número: `official`, `local_estimate`, `experimental`, `unknown`;
  - previsão e ritmo ("pace") cientes do reset, previsão por data e "freeze" quando o limite é atingido; % semanal só a partir do dado oficial;
  - **warehouse local opt-in** que sobrevive à limpeza de 30 dias do Claude (dimensões projeto/modelo/dia, retenção configurável, relatórios em CSV/JSON, percentis, recomendação de plano rotulada como estimativa);
  - **contrato de snapshot versionado:** `--once`, `--compact`, `--write-state` (arquivo de estado atômico para GUIs, trays e barras), com códigos de saída para automação;
  - `--filter-models anthropic`, que tira modelos não-Claude roteados do cálculo de limite;
  - multi-fonte **sem misturar contas** na mesma janela de 5 h.
- **Diferencial:** é o mais avançado em **semântica de limites**: procedência, confiança, P90 e o arquivo de estado pensado para outros consumidores.
- **O que aproveitar no Ahrena Console:**
  - **rótulos de procedência** em toda métrica exposta pela tool MCP e pelo painel;
  - **warehouse local** como requisito, não opcional;
  - **snapshot versionado** = o resource MCP `console://usage/snapshot`;
  - **limite "custom" por P90** quando não há dado oficial (API key, Bedrock);
  - **"não misturar contas na mesma janela"**: chave da janela = conta/org, o que importa para quem trabalha em várias orgs e clientes;
  - "pace": consumo atual comparado com o ritmo sustentável até o reset.
- **Fraquezas:** Python + TUI; a UI é o terminal. Os limites fixos de plano (~19k/88k/220k tokens) são aproximações que envelhecem. Sem multi-máquina centralizado e sem MCP.

### 2.3 Telemetria oficial do Claude Code (OpenTelemetry)

- **O que é:** exportação nativa de métricas, eventos (logs) e traces (beta) via OTLP.
- **Licença:** recurso do produto (proprietário); o protocolo OTel é aberto.
- **Atividade:** evolui a cada versão (ex.: `vcs.*` na v2.1.269, `managed_settings_resolved` na v2.1.274).
- **Fonte de dados:** o próprio processo do Claude Code. Os exporters são `otlp` (grpc, http/protobuf, http/json), `prometheus` e `console`.
- **Variáveis principais:**
  - `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER`;
  - `OTEL_EXPORTER_OTLP_PROTOCOL`, `_ENDPOINT`, `_HEADERS` (e as variantes por sinal);
  - `OTEL_METRIC_EXPORT_INTERVAL` (padrão 60 s), `OTEL_LOGS_EXPORT_INTERVAL` (5 s);
  - `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` (padrão **delta**; Prometheus precisa de `cumulative`);
  - privacidade: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` (`1` ou `file:<dir>`), `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`;
  - cardinalidade: `OTEL_METRICS_INCLUDE_SESSION_ID` (on), `_ACCOUNT_UUID` (on), `_VERSION` (off), `_ENTRYPOINT` (off), `_RESOURCE_ATTRIBUTES` (on), `_REPOSITORY` (off);
  - atributos próprios via `OTEL_RESOURCE_ATTRIBUTES` (ex.: `team.id`, `cost_center`);
  - `otelHeadersHelper` (script que gera headers de auth, renovado a cada 29 min);
  - traces: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `CLAUDE_CODE_PROPAGATE_TRACEPARENT`; mTLS suportado.
- **Métricas:**
  | Métrica | Atributos relevantes |
  |---|---|
  | `claude_code.session.count` | `start_type` (fresh/resume/continue/agents_view) |
  | `claude_code.cost.usage` (USD) | `model`, `query_source` (main/subagent/auxiliary), `speed`, `effort`, `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name` |
  | `claude_code.token.usage` | `type` (input/output/cacheRead/cacheCreation) + os mesmos de custo |
  | `claude_code.lines_of_code.count` | `type` (added/removed), `model` |
  | `claude_code.commit.count` | — |
  | `claude_code.pull_request.count` | — (só PRs abertos **pelo** Claude Code) |
  | `claude_code.code_edit_tool.decision` | `tool_name` (Edit/Write/NotebookEdit), `decision`, `source`, `language` |
  | `claude_code.active_time.total` (s) | `type` (user/cli) |
- **Eventos:**
  - `user_prompt` (tamanho, comando; texto só com opt-in);
  - `assistant_response`;
  - `api_request` (modelo, `cost_usd`, tokens por tipo, `duration_ms`, `speed`, `effort`, `query_source`);
  - `api_error` (status, tentativa);
  - `api_refusal`;
  - `tool_result` (tool, sucesso, `duration_ms`, tamanhos);
  - `tool_decision` (accept/reject, origem builtin/mcp);
  - `permission_mode_changed`;
  - `auth`;
  - `mcp_server_connection`;
  - `internal_error`;
  - `plugin_installed`, `plugin_loaded`, `skill_activated`, `managed_settings_resolved`.

  Os eventos são correlacionados por `prompt.id`, `event.sequence` e `request_id`.
- **Atributos padrão:** `session.id`, `organization.id`, `user.account_uuid`, `user.email`, `user.id` (anônimo), `terminal.type`, `app.entrypoint` (cli, sdk-cli, claude-vscode, claude-in-slack), `vcs.*`.
- **Traces (beta):** `claude_code.interaction` agrupa `llm_request`, `tool` (com `blocked_on_user` e `execution`), subagentes e `hook`.
- **Governança:** pode ser imposta e travada via **managed settings**. O `.claude/settings.json` de repositório **não** consegue configurar exporter, só desligar um sinal. As variáveis `OTEL_*` **não** passam para Bash, hooks ou servidores MCP. O formulário de OTel do admin console para Cowork **não** se aplica ao CLI nem à aba Code.
- **Métricas de produtividade que já vêm prontas:** linhas adicionadas/removidas (por modelo), commits, PRs, **aceitação/rejeição de edições por tool e por linguagem** (`code_edit_tool.decision`), tempo ativo do usuário vs. da CLI, sessões por tipo de início, decisões de permissão, além de custo por **subagente, skill, plugin e servidor/tool MCP**.
- **Diferencial:** tempo real, multi-máquina, padrão aberto e controle central. É a única fonte com custo atribuído a skill/plugin/MCP e com latência/erros de API.
- **O que aproveitar no Ahrena Console:** o console pode **ser o coletor OTLP local** (um receiver HTTP em `127.0.0.1:4318` dentro do servidor MCP), o que dá tempo real sem Grafana. Para frota (máquinas remotas via túnel, outras máquinas), basta apontar o endpoint para lá. Em paralelo, ingerir os mesmos nomes de métrica e atributos usados pelos dashboards existentes.
- **Fraquezas:**
  - não faz backfill;
  - custo estimado a preço de lista;
  - o padrão delta confunde Prometheus;
  - `pull_request.count` só conta PRs abertos pelo CC;
  - não traz repositório por padrão (`OTEL_METRICS_INCLUDE_REPOSITORY` ou um wrapper com `git.repo`);
  - **não traz `rate_limits`** (isso só existe no statusline);
  - não alcança subprocessos.

### 2.4 Claude Code Analytics (organização): Admin API, Enterprise Analytics API e dashboards

- **O que é:** métricas agregadas por usuário e por dia, mantidas pela Anthropic.
- **Licença:** serviço proprietário; a Admin API é gratuita para quem tem acesso a ela.
- **Fonte de dados:** servidores da Anthropic. **Não** cobre Bedrock, Vertex, Foundry nem Claude Platform on AWS.
- **Features:**
  - **Admin API**, `GET /v1/organizations/usage_report/claude_code?starting_at=YYYY-MM-DD` (paginação por cursor, `limit` até 1000, atraso de até 1 h), com os campos:
    - `actor` (email ou nome da API key), `customer_type` (api/subscription), `terminal_type`;
    - `core_metrics`: `num_sessions`, `lines_of_code.added/removed`, `commits_by_claude_code`, `pull_requests_by_claude_code`;
    - `tool_actions`: `edit_tool`, `multi_edit_tool`, `write_tool` e `notebook_edit_tool`, cada um com `accepted/rejected`;
    - `model_breakdown`: tokens input/output/cache_read/cache_creation + `estimated_cost` (em **centavos** de USD).
  - **Enterprise Analytics API** (chave `read:analytics`, só no plano Enterprise): engajamento, uso e custo por usuário em todas as superfícies Claude.
  - **Dashboard Team/Enterprise** (claude.ai/analytics/claude-code):
    - linhas aceitas e taxa de aceitação de sugestões, DAU e sessões;
    - **métricas de contribuição** via GitHub App (beta): "PRs with CC", "Lines of code with CC", % de PRs com CC, PRs por usuário;
    - leaderboard top 10 e export em CSV;
    - PRs atribuídos recebem o rótulo `claude-code-assisted` no GitHub.
  - **Como a atribuição funciona:** linhas normalizadas; sessões entre 21 dias antes e 2 dias depois do merge; exclui lockfiles, código gerado e linhas com mais de 1000 caracteres; reescrita acima de 20% não conta.
  - **Dashboard do Console (API):** linhas aceitas, taxa de aceitação, atividade, gasto diário e uma tabela por membro.
- **Diferencial:** é a única fonte de **impacto em código mergeado** (PR atribuído).
- **O que aproveitar no Ahrena Console:**
  - um conector opcional "org" que puxa a Admin API diariamente para quem tem chave;
  - usar o rótulo `claude-code-assisted` (via `gh`) como métrica de impacto, que funciona até sem Enterprise;
  - copiar a **definição de "effective lines"** e a janela de atribuição se o console for calcular algo parecido localmente.
- **Fraquezas:** granularidade diária, sem sessão nem tempo real; exige papel de admin; não cobre provedores de nuvem; a contribuição não existe com ZDR nem para clientes de API.

### 2.5 Dashboards Grafana/Prometheus

**rockdarko/claude-code-metrics-prometheus (Grafana 25255)**
- **O que é:** dashboard Grafana em PromQL sobre as métricas OTel oficiais.
- **Licença:** MIT. **Stars:** ~17; push em 2026-05.
- **Fonte:** OTel → Collector → Prometheus, VictoriaMetrics, Mimir ou Thanos.
- **Features:**
  - KPIs: sessões, usuários, custo, tokens, commits, PRs, linhas, tempo ativo, decisões de tool;
  - leaderboards: usuários, sessões e repos por custo, custo por modelo, decisões de edição por linguagem, sessões por terminal;
  - séries de custo e tokens por modelo e por tipo;
  - atividade por hora;
  - custo por `query_source` e por `effort`, **taxa de acerto de cache**;
  - filtros `organization`, `user` e `model`.
- **Diferencial/aproveitar:**
  - o **wrapper de shell que injeta `git.repo`** em `OTEL_RESOURCE_ATTRIBUTES` para dar custo por repositório;
  - a lista de painéis como checklist do painel do console;
  - o troubleshooting (temporalidade, PRs = 0) como FAQ.
- **Fraquezas:** exige a stack inteira (Collector, Prometheus, Grafana); não faz backfill.

**Grafana 25052 (1w2w3y)**
- **O que é:** o dashboard original que inspirou o 25255, mas sobre **Azure Application Insights (KQL)**.
- **O que aproveitar:** mostra que o mesmo modelo de dados roda em backends de nuvem (App Insights, e por analogia CloudWatch), o que importa para os clientes Ahrena em AWS e Azure.
- **Fraquezas:** preso ao Azure.

**li0nel/claude-otel**
- **O que é:** guia + dashboard para Grafana Cloud free tier, "sem Docker nem collector".
- **Licença:** não declarada. **Stars:** ~1; push em 2026-03.
- **Features:** custo e tokens totais, sessões, tempo ativo, **tabela por sessão** (custo, tempo, tokens in/out, cache read/write), custo por modelo, top 10 sessões por custo.
- **Aproveitar:** a **visão por sessão** como unidade principal e o caminho "5 minutos, zero infra".
- **Fraquezas:** depende de nuvem de terceiros (retenção de 14 dias no free tier); projeto pequeno.

**ColeMurray/claude-code-otel**
- **O que é:** stack docker-compose com OTel Collector, Prometheus, **Loki (eventos)** e Grafana.
- **Licença:** MIT. **Stars:** ~510; parado desde 2025-06.
- **Features:**
  - custo por modelo e usuário, DAU/WAU/MAU;
  - uso e **performance de tools** (taxa de sucesso, tempo de execução);
  - latência e erros de API;
  - produtividade (linhas, commits, PRs) e dashboards executivos.
- **Aproveitar:** é o único que usa os **eventos** (Loki) e não só as métricas, o que dá taxa de sucesso por tool e análise de erro.
- **Fraquezas:** abandonado; stack pesada.

### 2.6 ccstatusline (sirmalloc/ccstatusline)

- **O que é:** statusline altamente configurável para o Claude Code (widgets e powerline).
- **Licença:** MIT. **Stars:** ~13k; ativo (push em 2026-10-13).
- **Fonte:** o JSON do statusline (stdin), streaming do transcript `.jsonl` e a API de uso OAuth/limites (`limits[]`, `weekly_scoped`) com cache e backoff.
- **Features (widgets):**
  - **Block Timer / Block Reset Timer / Weekly Reset Timer**;
  - uso semanal por modelo (Sonnet, Opus, Fable);
  - **Session Cost Rate** (US$/h de tempo de API ou de sessão);
  - **Extra Usage Used** e **Extra Usage Daily Budget** (divide o saldo mensal pelos dias restantes, opcionalmente pulando fins de semana);
  - contexto em % e tokens (reseta após `/compact` via `compact_boundary.postTokens`);
  - **Compaction Counter** (auto/manual, tokens recuperados);
  - **Cache Hit Rate / Cache Read / Cache Write** e **Cache Timer** (estado HOT e contagem do TTL de 5 min/1 h do prompt cache);
  - status do serviço Claude (incidentes de 48 h);
  - Git, PR/CI e sandbox.
- **Diferencial:** os widgets mais criativos de **custo em tempo real por sessão** (cost rate, cache timer, budget diário).
- **O que aproveitar:**
  - **Cache Timer** ("seu cache expira em 3 min", o que evita reprocessar contexto caro);
  - **Daily Budget** a partir do limite mensal;
  - **Cost Rate**;
  - **Compaction Counter**;
  - **status do serviço** no painel.
- **Fraquezas:** só no terminal e uma sessão de cada vez; sem histórico nem agregação.

### 2.7 sniffly (chiphuyen/sniffly)

- **O que é:** dashboard web local de analytics dos logs do Claude Code, focado em "usar melhor".
- **Licença:** MIT. **Stars:** ~1,3k; parado desde 2025-08.
- **Fonte:** `.jsonl` local. Sobe um servidor em `localhost:8081`.
- **Features:**
  - padrões de uso;
  - **breakdown de erros** (onde o Claude Code erra: tool failures, interrupções);
  - histórico de mensagens/instruções navegável;
  - **dashboard compartilhável** (link público opcional).
- **Diferencial:** foca em **qualidade de uso**, não só em custo.
- **O que aproveitar:** a **taxonomia de erros** (tool falhou, usuário rejeitou, interrompeu) calculada a partir do transcript, e o conceito de "relatório compartilhável", que no console vira publicar um artefato privado.
- **Fraquezas:** abandonado; precisa de servidor e navegador separados.

### 2.8 claude-code-log (daaain/claude-code-log)

- **O que é:** converte os transcripts `.jsonl` em HTML, Markdown ou JSON navegável, com TUI e servidor de busca.
- **Licença:** MIT. **Stars:** ~1,2k; ativo (2026-10).
- **Fonte:** `.jsonl` local (beta para Codex e Antigravity).
- **Features:**
  - índice de projetos e sessões;
  - tokens por mensagem e por sessão;
  - filtros por tipo de mensagem;
  - timeline interativa;
  - **subagentes e forks (rewind) como ramos**;
  - **busca full-text** no arquivo inteiro (`serve`);
  - **watch mode**, em que a página da sessão cresce ao vivo;
  - export em Markdown com `--depth` para realimentar um LLM.
- **Diferencial:** é o melhor **parser de transcript** do ecossistema (lida com resumos assíncronos, subagentes, forks e compactação).
- **O que aproveitar:** referência de parsing (summaries, `isSidechain`, forks, compact), **busca full-text** como tool MCP (`search_sessions`) e o export "pronto para LLM" de uma sessão.
- **Fraquezas:** não é ferramenta de custo; não agrega por período.

### 2.9 ccflare / better-ccflare (snipeship/ccflare, tombii/better-ccflare)

- **O que é:** proxy local para Anthropic/OpenAI com balanceamento entre contas, histórico de requisições e analytics.
- **Licença:** MIT. **Stars:** ~1,05k (ccflare, push em 2026-04) e ~270 (better-ccflare, ativo em 2026-10).
- **Fonte:** **tráfego da API** (via `ANTHROPIC_BASE_URL`), o que dá os dados mais exatos por requisição, incluindo os headers de rate-limit.
- **Features:**
  - dashboard web e TUI;
  - histórico de requisições, logs e health;
  - **estado de rate limit por conta**;
  - **failover** de conta quando uma bate no limite.
- **Diferencial:** é o único com a **verdade do fio** (headers `anthropic-ratelimit-*`, latência real) e com controle ativo (roteamento).
- **O que aproveitar:** os headers de rate limit como fonte opcional de alta fidelidade e o conceito de **controle** (pausar ou rotear quando passar do orçamento), que se encaixa no "controle" do Ahrena Console.
- **Fraquezas:** intrusivo (mexe na rota da API); risco com os termos de uso de contas de assinatura; mais uma peça para operar.

---

## 3. Backfill a partir de `~/.claude/projects/*.jsonl`

### 3.1 Layout em disco (verificado neste Mac)

```
~/.claude/projects/<cwd-com-barras-trocadas-por-hífen>/
    <sessionId>.jsonl                         # transcript principal
    <sessionId>/subagents/agent-<id>.jsonl    # transcripts de subagentes (Agent tool)
    <sessionId>/tool-results/...              # saídas grandes de tools persistidas
```
- O nome da pasta é o cwd "achatado" e **não dá para reverter com segurança** (hífens ambíguos). Use o campo `cwd` dentro das linhas.
- Worktrees aparecem como projetos separados (`...--claude-worktrees-<nome>`). Vale agrupar pelo repositório raiz (via `cwd` + `git rev-parse`) ou pelo `gitBranch`.
- Há também transcripts de sessões do Desktop/Cowork em pastas `...Library-Application-Support-Claude-scratch-workspaces-...`.
- Retenção: o Claude Code apaga transcripts com mais de `cleanupPeriodDays` (padrão 30). **O backfill tem que copiar ou indexar antes disso.**

### 3.2 Tipos de linha (`type`) observados

| `type` | Para que serve no console |
|---|---|
| `assistant` | **Linha de custo.** `message.model`, `message.id`, `requestId`, `message.usage`, `timestamp`, `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain`, `effort`, `requestedModel`, `attributionSkill/Plugin/McpServer/McpTool`, `thinkingDurationMs`, `apiBlockIndex` |
| `user` | Prompt ou tool result. `toolUseResult` (stdout/stderr/interrupted do Bash, arquivo, patch...), `permissionMode`, `permissionDecision`, `toolDenialKind`, `promptId`, `promptSource`, `isCompactSummary`, `isMeta` |
| `system` | `subtype` (`compact_boundary` com `compactMetadata`, `stop_hook_summary` com `hookCount/hookErrors`...), `level` |
| `attachment` | Contexto injetado (`edited_text_file`, `skill_listing`, `invoked_skills`, `hook_additional_context`, `auto_mode`...) |
| **`cost-state`** | **Snapshot oficial do custo da sessão.** `totalCostUSD`, `totalAPIDuration(WithoutRetries)`, `totalToolDuration`, `totalDuration`, `totalLinesAdded`, `totalLinesRemoved`, `startTime`, `hasUnknownModelCost` e `modelUsage[modelo]` = {`inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`} |
| `pr-link` | `prNumber`, `prRepository`, `prUrl`: **PRs da sessão** (produtividade sem OTel) |
| `custom-title`, `agent-name`, `last-prompt` | Título, nome e último prompt da sessão (rótulos do painel) |
| `mode` | Modo de permissão |
| `bridge-session` | `ownerAccountUuid`, `ownerOrganizationUuid`: **a qual conta/org a sessão pertence** (permite separar as orgs e os clientes) |
| `file-history-snapshot/-delta` | Checkpoints de arquivo (rewind) |
| `queue-operation` | Mensagens enfileiradas |

### 3.3 `message.usage` (linhas `assistant`)

`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens` (TTL do cache, que tem preço diferente), `output_tokens_details.thinking_tokens`, `server_tool_use.web_search_requests/web_fetch_requests`, `service_tier`, `speed`, `inference_geo`, `iterations`, `fallback_credit`.

### 3.4 Armadilhas de backfill

1. **Deduplicação:** uma resposta com vários blocos de conteúdo vira **várias linhas `assistant` com o mesmo `message.id`/`requestId`** e o usage repetido (o `apiBlockIndex` indica o bloco). Some uma vez por (`message.id`, `requestId`). Sessões retomadas ou forkadas também copiam linhas antigas para o arquivo novo, então a deduplicação tem que ser global, não por arquivo.
2. **Subagentes:** o custo deles fica em `subagents/*.jsonl`. Some esses arquivos e marque `query_source=subagent` (ou `isSidechain`).
3. **Duas formas de custo:** recalcular a partir do usage com a tabela de preços (como o ccusage) **ou** usar o `cost-state.totalCostUSD` mais recente da sessão (valor do próprio Claude Code, com o preço que ele aplicou). Recomendo guardar os dois e mostrar a divergência; `hasUnknownModelCost` sinaliza um modelo sem preço.
4. **Preço por TTL de cache:** a escrita de 1 h custa mais que a de 5 min, e a separação `ephemeral_5m/1h` permite acertar isso.
5. **Fuso:** timestamps em ISO UTC. Agregar no fuso do usuário (o ccusage tem `--timezone`).
6. **Multi-org:** use `bridge-session.ownerOrganizationUuid` e `CLAUDE_CONFIG_DIR` para não misturar contas, a lição do Usage Monitor.
7. **Esquema muda a cada versão** (campo `version` em cada linha). O parser tem que ser tolerante e ignorar tipos desconhecidos.
8. **Produtividade sem OTel:** linhas (`cost-state.totalLinesAdded/Removed`), PRs (`pr-link`), aceitação/rejeição (as linhas `user` têm `permissionDecision` e `toolDenialKind`; os patches ficam em `toolUseResult`), duração de tools (`totalToolDuration`) e compactações (`compact_boundary`). Dá para reconstruir boa parte das métricas do OTel **retroativamente**.

---

## 4. Matriz de features

Legenda: ✓ tem · – não tem · ~ parcial. Colunas: **ccu** = ccusage · **CUM** = Claude-Code-Usage-Monitor · **OTel** = telemetria oficial · **Org** = Analytics API/dashboards · **G25255** = rockdarko · **COtel** = ColeMurray/claude-code-otel · **li0** = li0nel/claude-otel · **ccsl** = ccstatusline · **snf** = sniffly · **ccl** = claude-code-log · **flare** = ccflare.

| Feature | ccu | CUM | OTel | Org | G25255 | COtel | li0 | ccsl | snf | ccl | flare |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Lê `.jsonl` local (backfill) | ✓ | ✓ | – | – | – | – | – | ~ | ✓ | ✓ | – |
| Persistência além dos 30 dias | – | ✓ | ✓¹ | ✓ | ✓¹ | ✓¹ | ~ | – | – | ~ | ✓ |
| Relatório diário/mensal | ✓ | ✓ | ✓¹ | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | ✓ |
| Relatório por sessão | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | – |
| Janela de 5 h (blocos) | ✓ | ✓ | – | – | – | – | – | ✓ | – | – | ~ |
| Limite oficial (`rate_limits` 5 h/7 d) | – | ✓ | – | – | – | – | – | ✓ | – | – | ✓² |
| Previsão de limite/burn rate | ✓ | ✓ | – | – | – | ~ | – | ~ | – | – | – |
| Rótulo de procedência/confiança | – | ✓ | – | – | – | – | – | – | – | – | – |
| Por modelo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Tokens de cache separados | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Taxa de acerto e TTL do cache | – | – | ~ | – | ✓ | – | – | ✓ | – | – | – |
| Por projeto/repo | ✓ | ✓ | ~³ | – | ~³ | – | – | – | ✓ | ✓ | – |
| Por subagente/skill/plugin/MCP | – | – | ✓ | – | ✓ | – | – | – | – | ~ | – |
| Alertas/avisos | ~ | ✓ | ✓⁴ | – | ✓⁴ | ✓⁴ | ✓⁴ | ~ | – | – | – |
| Orçamento (budget diário/mensal) | – | ~ | – | – | – | – | – | ✓ | – | – | – |
| Multi-máquina/equipe | – | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ~ |
| Multi-conta sem misturar | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | ~ | – | – | ✓ |
| Linhas/commits/PRs | – | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – |
| Aceitação de edições | – | – | ✓ | ✓ | ✓ | – | – | – | – | – | – |
| PR atribuído (código mergeado) | – | – | – | ✓ | – | – | – | – | – | – | – |
| Erros e performance de tools/API | – | – | ✓ | – | – | ✓ | – | – | ✓ | – | ✓ |
| Busca/leitura de transcript | – | – | – | – | – | – | – | – | ✓ | ✓ | ✓ |
| Saída JSON/estado para outros apps | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | ✓ | ✓ |
| Multi-agente (Codex etc.) | ✓ | – | – | – | – | – | – | – | – | ~ | ✓ |
| Controle ativo (rotear/pausar) | – | – | – | – | – | – | – | – | – | – | ✓ |
| UI sem terminal (web/painel) | – | – | – | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| **Servidor MCP / dentro do Claude Desktop** | – | – | – | – | – | – | – | – | – | – | – |

Notas: ¹ depende do backend de armazenamento · ² via headers de rate limit da API · ³ precisa de `OTEL_METRICS_INCLUDE_REPOSITORY` ou do wrapper `git.repo` · ⁴ via alertas do backend (Grafana/Prometheus), não da ferramenta.

---

## 5. Top 10 ideias para roubar (ordem de valor)

1. **Backfill + warehouse próprio** (ccusage + Usage Monitor): no primeiro start, o servidor MCP indexa todo o `~/.claude/projects/**` (incluindo `subagents/`), deduplica por (`message.id`, `requestId`) e grava em SQLite local. Daí em diante segue os arquivos de forma incremental. O histórico sobrevive à limpeza de 30 dias. Sem isso o console nasce vazio.
2. **Limite oficial via statusline + rótulo de procedência** (Usage Monitor v4, ccstatusline): um hook de statusline mínimo grava `rate_limits.five_hour/seven_day/spend_limit` no warehouse. Todo número do console carrega `official | local_estimate | unknown`, e a estimativa local (blocos de 5 h, P90) só entra quando não há dado oficial.
3. **Ser o receptor OTLP local** (telemetria oficial + dashboards Grafana): o servidor MCP abre um receiver em `127.0.0.1:4318` e o console injeta as variáveis `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` via settings, o que dá tempo real com aceitação de edições, custo por skill/plugin/MCP e erros de API **sem Grafana**. Para frota (máquinas remotas via túnel), é o mesmo endpoint.
4. **Previsão de esgotamento com "pace"** (Usage Monitor, ccusage blocks): "no ritmo atual você bate o limite de 5 h às 15:40, 50 min antes do reset". Exposta como tool MCP (`forecast_limits`) e como alerta proativo no painel.
5. **Custo atribuído a subagente/skill/plugin/MCP e por repositório** (atributos OTel + `attributionSkill/Plugin/Mcp*` no `.jsonl`): responde "qual agente ou skill custa mais". Isso conversa direto com agentes headless de produção e com um desenho multi-provider.
6. **Produtividade retroativa a partir do transcript** (`cost-state.totalLinesAdded/Removed`, `pr-link`, `permissionDecision`/`toolDenialKind`): linhas, PRs e taxa de aceitação **sem precisar de OTel ligado antes**, completadas pelo OTel daqui para a frente e pelo rótulo `claude-code-assisted` no GitHub para impacto em código mergeado.
7. **Visão "Cache"** (ccstatusline, G25255): taxa de acerto, escrita 5 min vs. 1 h e um **Cache Timer** por sessão ativa ("cache esfria em 2 min"), que é a alavanca de custo mais acionável que existe.
8. **Separação por conta/org** (Usage Monitor; `bridge-session.ownerOrganizationUuid`): janelas e relatórios por org sem misturar, para quem trabalha em várias orgs e clientes ao mesmo tempo.
9. **Snapshot versionado como resource MCP** (Usage Monitor `--write-state`, ccusage `--json`): `console://usage/snapshot` e `usage_report(granularity, group_by, since, until)` com um contrato JSON estável, consumível pelo artefato, por outros agentes e por automações.
10. **Orçamento e preços próprios** (ccstatusline Daily Budget, ccusage pricing overrides): budget diário derivado de um teto mensal (pulando fins de semana, se quiser) e uma tabela de preço por modelo/provider sobrescrevível (Bedrock, preço negociado, modelos não-Anthropic), mostrando a divergência entre o custo recalculado e o `totalCostUSD` gravado.

Menções honrosas: taxonomia de erros do sniffly; busca full-text e export "pronto para LLM" do claude-code-log (`search_sessions`); status do serviço Claude (ccstatusline); controle ativo por proxy (ccflare), como opção futura para "pausar ao estourar orçamento".

---

## Fontes

- ccusage: https://github.com/ccusage/ccusage · https://ccusage.com/guide/blocks-reports
- Claude Code Usage Monitor: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
- Telemetria oficial: https://code.claude.com/docs/en/monitoring-usage
- Statusline (campos `rate_limits`, `cost`, `context_window`): https://code.claude.com/docs/en/statusline
- Analytics: https://code.claude.com/docs/en/analytics · https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api
- Grafana: https://github.com/rockdarko/claude-code-metrics-prometheus · https://grafana.com/grafana/dashboards/25255 · https://grafana.com/grafana/dashboards/25052 · https://github.com/li0nel/claude-otel · https://github.com/ColeMurray/claude-code-otel
- ccstatusline: https://github.com/sirmalloc/ccstatusline
- sniffly: https://github.com/chiphuyen/sniffly
- claude-code-log: https://github.com/daaain/claude-code-log
- ccflare: https://github.com/snipeship/ccflare · https://github.com/tombii/better-ccflare
