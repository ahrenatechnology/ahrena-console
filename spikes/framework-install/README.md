# framework-install

Spike #184: o que instalar o Ahrena Framework num repositório escreve, e como o PR é aberto sem tocar no branch padrão. O estudo está em [docs/repo-instructions-install-adrs-study.md](../../docs/repo-instructions-install-adrs-study.md).

| Arquivo | O quê |
| --- | --- |
| `catalog.mjs` | Gera `catalog.json` a partir de um checkout do framework: os plugins do marketplace e as regras de cada um (enunciado e se é hook ou julgamento) |
| `catalog.json` | O retrato do framework usado nos testes |
| `plan.mjs` | Detecta o que o repositório tem e sugere os plugins; monta o plano por plataforma (`.claude/settings.json`, `CLAUDE.md`, `AGENTS.md`, `.codex/config.toml`, `.cursor/rules`), mescla por marcadores, recusa JSON inválido e gera o diff |
| `pr.mjs` | Abre o PR por uma porta de quatro escritas: branch novo, um commit e o PR. Idempotente, e nunca escreve no padrão |
| `plan.test.mjs` | Testes do plano e do PR contra um GitHub falso; nenhum PR real é aberto |

```bash
node --test spikes/framework-install/
```

```bash
node spikes/framework-install/catalog.mjs ~/caminho/do/ahrena-framework > spikes/framework-install/catalog.json
```
