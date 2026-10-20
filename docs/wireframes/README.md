# Wireframes

Wireframes de todas as telas da 0.0.1, para aprovação antes de construir:

- **Painel lateral** (mod do Claude Code, decisão [0004](../decisoes/0004-painel-da-sessao.md)): P0 a P13, em 38 e 121 colunas, com as decisões da sessão (P9 e P10) e o grafo da sessão com os subagentes (P11 a P13, issue #146).
- **App de bandeja** (Tauri, decisão [0005](../decisoes/0005-app-desktop.md)): A1 a A5, e A6 e A7 com o bloco Máquinas (decisão [0008](../decisoes/0008-machine-telemetry-and-dev-console.md)).
- **Console** (artefato, que também é a janela do app): C1 a C23, com Feed, Analytics, Workflows (grafo de agentes e o laço dev/review), Agent Config, Rodar agente, Decisões (C20 e C21), Repositórios (C22 e C23), as máquinas (C24 Esta máquina, C25 Workstation, C26 sem conexão) o Dev Console (C27) e as ADRs dos repositórios (C28 a C31, issue #174) e as instruções dos agentes de cada repositório (C32 e C33, issue #183), o fluxo para instalar o Ahrena Framework num repositório por PR (C34 a C37, issue #184) as decisões de produto, PDR (C38), com o [estudo](../repo-instructions-install-adrs-study.md), e as sessões de todas as máquinas com o filtro de máquina (C45 Sessões, C46 Mural e Kanban, C47 Dashboard, Feed e Histórico, C48 Workstation sem conexão nas listas, C49 detalhe de uma sessão remota, issue #243). As telas novas aparecem em 1100 px, a largura da janela do app, e em 1440 px.

A referência é o Claude Code Agent Monitor. Cada tela diz o que veio dele e onde diverge.

É um artefato do claude.ai versionado aqui ([artifact.json](artifact.json)), no formato das skills `versioning-artifacts` e `publishing-artifacts`. O link oficial só é publicado depois do merge.

| Arquivo | O que é |
| --- | --- |
| [index.html](index.html) | A página. Segue o contrato do Artifact: sem `<html>` nem `<head>`, CSS embutido e só scripts de CDN permitida (ícones Lucide). |
| [montar.mjs](montar.mjs) | Copia `packages/marca/gerado/marca.css` para dentro da página. Com `--checar`, falha se a cópia estiver velha. Nenhuma cor é escrita à mão. |
| [capturar.mjs](capturar.mjs) | Gera um PNG por tela em [capturas/](capturas/), abrindo a página em `?captura=<id>` num Chromium headless já instalado. |

Para ver no navegador, sirva a página com o mesmo esqueleto que o Artifact põe na publicação (um `<!doctype html>` em volta) e abra em `http://127.0.0.1:<porta>/`. `?captura=<id>` mostra só uma tela e `?tema=light` força o tema claro.

```bash
node docs/wireframes/montar.mjs --checar
```

Os dados são sintéticos, com o vocabulário do simulador (`packages/nucleo/src/simulador`).
