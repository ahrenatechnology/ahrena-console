# Ahrena Console

Console para ver e controlar as sessões e os agentes do Claude Code, de dentro do Claude Desktop.

**Versão 0.0.1, em concepção.** Ainda não tem código: este repositório começa pelo benchmark e pelas decisões.

## Premissas

- **MCP first.** Tudo que o console sabe e faz passa por um servidor MCP. O Claude consulta e age por ele na conversa.
- **Dentro do Claude Desktop.** A interface principal abre no próprio app: artefato, painel ou UI inline. Nada de depender de terminal ou TUI.
- **Standalone é opcional.** Pode existir uma interface web separada, mas ela não é o centro.
- **Projeto novo.** Podium e Claude Code Agent Monitor são referências de ideias, não base de código.
- **Interface e marca.** Visual na linha do Claude Code Agent Monitor, com a marca da Ahrena (a mesma do The Forward Deployed Engineer). Detalhes em [docs/design.md](docs/design.md).

## Em aberto

- Onde roda: só local, só nuvem, ou híbrido (agente local em cada máquina mais um hub para time e clientes).
- Escopo da 0.0.1: uso interno da Ahrena ou já com clientes.
- Se os agentes headless de produção entram na 0.0.1.

## Benchmark

Em [docs/benchmark/](docs/benchmark/):

| Arquivo | Frente |
| --- | --- |
| [00-agent-monitor.md](docs/benchmark/00-agent-monitor.md) | Claude Code Agent Monitor, a referência principal |
| [01-dashboards.md](docs/benchmark/01-dashboards.md) | Dashboards de sessões do Claude Code (Podium, agents-observe e outros) |
| [02-custo-uso.md](docs/benchmark/02-custo-uso.md) | Custo, uso, limites e telemetria (ccusage, OTel, Grafana) |
| [03-orquestradores.md](docs/benchmark/03-orquestradores.md) | Orquestradores de agentes em paralelo (Vibe Kanban, Conductor e outros) |
| [04-llm-ops.md](docs/benchmark/04-llm-ops.md) | Plataformas de LLM e agent ops (Langfuse, Phoenix, Laminar e outros) |
| [05-mcp-ui.md](docs/benchmark/05-mcp-ui.md) | Como entregar UI e dados via MCP dentro do Claude Desktop (MCP Apps, artefatos, mods) |

## Licença

[Apache-2.0](LICENSE). Copyright 2026 Ahrena.
