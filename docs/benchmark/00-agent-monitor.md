# Claude Code Agent Monitor (CCAM) — hoangsonww/Claude-Code-Agent-Monitor

MIT · ~1.084 stars · v2.3.0 · Node ≥ 22.22, Express + React 19/Vite + better-sqlite3 · commit a06db03 (2026-10-09)

## Coleta
- Hooks do Claude Code instalados em `~/.claude/settings.json` (PreToolUse, PostToolUse, Stop, SubagentStop, Notification, SessionStart, SessionEnd, UserPromptSubmit) → `scripts/hook-handler.js` → `POST /api/hooks/event` (fire-and-forget, fan-out para dashboards vivos, porta 4820).
- Codex (hooks próprios + ingestão de rollouts) e Cursor (state DB + transcripts) como provedores de primeira classe.
- Backfill: `scripts/import-history.js` lê `~/.claude/projects/*.jsonl`; roda sozinho no boot; também via API (`/api/import/rescan`, `/scan-path`, `/upload` zip/tar).
- Tokens/custo: re-parse incremental do transcript JSONL a cada hook (inclui subagentes).
- Máquinas remotas: pull via SSH/scp ou push em `POST /api/hooks/ingest-batch`.
- Sem ingestão OTLP; exporta Prometheus (`/api/metrics`) + stack Grafana opcional.
- Browser via WebSocket.

## Armazenamento (SQLite WAL)
sessions · agents (main/subagent, parent_agent_id, current_tool) · events (tool calls são eventos) · token_usage (sessão × modelo × tier, baseline de compactação) · pricing (Claude/GPT/Cursor) · alert_rules/alert_events · webhook_targets/deliveries · push_subscriptions · workflows · remote_sources · dashboard_runs.

## UI
Dashboard · Kanban · Sessions + SessionDetail (conversa renderizada) · Activity Feed · Analytics (custo/tokens) · Workflows (DAG, delegação, concorrência) · CcConfig (explorador/editor de skills, hooks, MCP, memória com backup) · Run (lança/retoma Claude Code e Codex) · Settings · Web Push, alertas, webhooks.

## MCP
103 tools tipadas em 16 domínios; chama a REST em loopback; guardas de política para mutações; stdio, Streamable HTTP (8819) e REPL. Só dados — sem `ui://`/MCP Apps.

## Plugins ccam-*
analytics, config, cost-guard, dashboard, devtools, insights, integrations, platform, productivity (standup/relatórios), quality (SLOs), reports, runner, sessions (busca/timeline/replay), workflows.

## Outras superfícies
Statusline independente (bash/python) · app Electron com servidor embutido (bandeja, DMG/NSIS) · extensão VS Code (webview + sidebar).

## Multi-usuário
Não tem (sem user_id). Tokens estáticos opcionais. "Time" = um dashboard agregando máquinas por SSH/push; deploy Docker/Helm/Terraform.

## Fraquezas
Node 22.22 + módulo nativo; hooks com caminho absoluto do checkout; arquivos monolíticos (hooks.js ~110 KB, db.js com migrações inline); possível bug nos hooks dos plugins (POST sem hook_type, depende de jq); custo por re-parse pesado; superfície enorme para um autor só; segurança assume loopback.
