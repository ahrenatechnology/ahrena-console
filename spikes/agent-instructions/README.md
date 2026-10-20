# agent-instructions

Spike #183: o que um agente herda ao trabalhar num repositório. A partir da lista de caminhos e de uma função `read(path)`, devolve:

- os arquivos de instrução (`CLAUDE.md`, `.claude/CLAUDE.md` e `AGENTS.md`, da raiz e das subpastas), cada um com a árvore de `@imports` resolvida (achado, fora do repositório, não existe, ciclo, fundo demais) e quem o importa;
- o que `.claude/` traz: regras com `paths`, skills, agentes, comandos, hooks (sem o comando), plugins habilitados e marketplaces;
- os servidores de `.mcp.json`;
- `empty: true` quando não há nada.

A mesma função serve para o disco e para o GitHub: só muda o `read`. O estudo está em [docs/repo-instructions-install-adrs-study.md](../../docs/repo-instructions-install-adrs-study.md).

| Arquivo | O quê |
| --- | --- |
| `instructions.mjs` | A leitura, os imports, `hooksOf`, `pluginsOf` e a busca transversal, sem dependências |
| `instructions.test.mjs` | Testes contra um repositório falso em memória |

```bash
node --test spikes/agent-instructions/
```
