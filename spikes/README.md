# Testes de validação

Protótipos descartáveis das validações da 0.0.1. Os resultados estão em [docs/validacoes-0.0.1.md](../docs/validacoes-0.0.1.md). Nada aqui é o código do produto.

| Pasta | O quê |
| --- | --- |
| [nucleo-teste](nucleo-teste/) | Núcleo mínimo: API HTTP, servidor MCP (HTTP e stdio) e uma MCP App |
| [painel-teste](painel-teste/) | Plugin do Claude Code com o painel lateral (mod) e os testes de UI |
| [artefato-teste](artefato-teste/) | Página do artefato que lê o núcleo via `host:ahrena-console` |
| [extensao-teste](extensao-teste/) | Manifesto e script para empacotar o núcleo como extensão `.mcpb` |
| [resposta-teste](resposta-teste/) | Spike #58: o plugin consulta o núcleo antes de abrir o diálogo de permissão, pergunta ou plano ([decisão 0003](../docs/decisoes/0003-responder-sessao.md)) |
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
