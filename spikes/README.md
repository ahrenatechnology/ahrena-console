# Testes de validação

Protótipos descartáveis das validações da 0.0.1. Os resultados estão em [docs/validacoes-0.0.1.md](../docs/validacoes-0.0.1.md). Nada aqui é o código do produto.

| Pasta | O quê |
| --- | --- |
| [nucleo-teste](nucleo-teste/) | Núcleo mínimo: API HTTP, servidor MCP (HTTP e stdio) e uma MCP App |
| [painel-teste](painel-teste/) | Plugin do Claude Code com o painel lateral (mod) e os testes de UI |
| [artefato-teste](artefato-teste/) | Página do artefato que lê o núcleo via `host:ahrena-console` |
| [extensao-teste](extensao-teste/) | Manifesto e script para empacotar o núcleo como extensão `.mcpb` |
| [github-consulta](github-consulta/) | Custo das consultas ao GitHub e prova do cache (spike #40) |
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
