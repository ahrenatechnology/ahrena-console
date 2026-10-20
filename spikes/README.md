# Testes de validação

Protótipos descartáveis das validações da 0.0.1. Os resultados estão em [docs/validacoes-0.0.1.md](../docs/validacoes-0.0.1.md). Nada aqui é o código do produto.

| Pasta | O quê |
| --- | --- |
| [nucleo-teste](nucleo-teste/) | Núcleo mínimo: API HTTP, servidor MCP (HTTP e stdio) e uma MCP App |
| [painel-teste](painel-teste/) | Plugin do Claude Code com o painel lateral (mod) e os testes de UI |
| [artefato-teste](artefato-teste/) | Página do artefato que lê o núcleo via `host:ahrena-console` |
| [extensao-teste](extensao-teste/) | Manifesto e script para empacotar o núcleo como extensão `.mcpb` |
| [github-consulta](github-consulta/) | Custo das consultas ao GitHub e prova do cache (spike #40) |
| [resposta-teste](resposta-teste/) | Spike #58: o plugin consulta o núcleo antes de abrir o diálogo de permissão, pergunta ou plano ([decisão 0003](../docs/decisoes/0003-responder-sessao.md)) |
| [app-desktop](app-desktop/) | Spike #82: app Tauri na bandeja que adota ou sobe o núcleo ([decisão 0005](../docs/decisoes/0005-app-desktop.md)) |
| [multiplas-contas](multiplas-contas/) | Spike #106: duas pastas de configuração do Claude Code ao mesmo tempo, com contas sintéticas, e a medição das contas no disco ([decisão 0006](../docs/decisoes/0006-multiplas-contas.md)) |
| [chat-delegacao](chat-delegacao/) | Spike #120: o console conversa em `stream-json` com sessões reais do Claude Code, novas ou retomadas pelo id, por conta, e entrega prompt a uma sessão aberta noutro processo ([decisão 0007](../docs/decisoes/0007-chat-e-delegacao.md)) |
| [adr-extractor](adr-extractor/) | Spike #174: extrai status, data, seções e ligações das ADRs (MADR, Nygard, Y-statement e livres em pt-BR), testado contra `docs/decisoes` ([estudo](../docs/repo-adrs-and-instructions-study.md)) |
| [agent-instructions](agent-instructions/) | Spike #183: lê o que um agente herda de um repositório (CLAUDE.md e AGENTS.md com os `@imports`, e `.claude/`), sobre um `read(path)` que serve ao disco e ao GitHub ([estudo](../docs/repo-adrs-and-instructions-study.md)) |
| [.claude-plugin](.claude-plugin/) | Marketplace local para instalar o painel |

## Rodar

```bash
cd spikes/nucleo-teste && npm ci && node server.mjs
```

```bash
claude plugin marketplace add ./spikes && claude plugin install ahrena-console-painel@ahrena-console-testes
```

Depois, numa sessão do Claude Code: `/console`.

```bash
sh spikes/extensao-teste/empacotar.sh
```

Gera `spikes/extensao-teste/ahrena-console.mcpb`, que se instala com dois cliques no Claude Desktop.
