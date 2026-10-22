# Wireframes

Wireframes de todas as telas da 0.0.1, para aprovação antes de construir:

- **Painel lateral** (mod do Claude Code, decisão [0004](../decisoes/0004-painel-da-sessao.md)): P0 a P13, em 38 e 121 colunas, com as decisões da sessão (P9 e P10) e o grafo da sessão com os subagentes (P11 a P13, issue #146), e a sessão numa máquina sem conexão (P14, issue #278).
- **App de bandeja** (Tauri, decisão [0005](../decisoes/0005-app-desktop.md)): A1 a A5, e A6 e A7 com o bloco Máquinas (decisão [0008](../decisoes/0008-machine-telemetry-and-dev-console.md)), e A8 com o Reconectar da máquina remota (issue #244, decisão 0012), e A9 e A10 com as nuvens e a conexão da Workstation (issues #277 e #278, decisão 0013).
- **Console** (artefato, que também é a janela do app): C1 a C23 e C51 a C53, com Feed, Analytics, Workflows (grafo de agentes e o laço dev/review), Agent Config, Rodar agente, Decisões (C20 e C21), Repositórios (C22 e C23), as máquinas (C24 Esta máquina, C25 Workstation, C26 sem conexão) o Dev Console (C27) e as ADRs dos repositórios (C28 a C31, issue #174) e as instruções dos agentes de cada repositório (C32 e C33, issue #183), o fluxo para instalar o Ahrena Framework num repositório por PR (C34 a C37, issue #184) as decisões de produto, PDR (C38), com o [estudo](../repo-instructions-install-adrs-study.md), a conexão com o GitHub sem o `gh` (C39 a C44, issue #241, decisão [0011](../decisoes/0011-github-device-flow-keychain.md)): a seção Conexões em Controle, o código do device flow, o estado conectado, o "Conectar ao GitHub" nas telas e a escolha do Project no Kanban do projeto, e Reconectar a Workstation pelo comando do machines.json (C50, issue #244), e a aba Entregas do Analytics, com o ritmo de entrega de cada repositório e projeto ao lado do esforço do Claude (C54 a C56, issue #266), e o botão que leva à própria sessão, no Claude Desktop ou num terminal que a retoma, no Detalhe, no Mural, em Sessões e no Dashboard (C70 e C71), as contas de nuvem em Conexões, com o catálogo de conectores, os perfis da AWS e o estado da sessão SSO (C57 a C61, issue #277), os perfis de nuvem de cada máquina, com o login da Workstation por código (C66 e C67, issue #277), e a conexão da Workstation como conexão de primeira classe, com onde ela roda, o túnel, a sessão de nuvem e o motivo da queda (C62 a C65, issue #278), as duas pela decisão [0013](../decisoes/0013-cloud-connectors-and-machine-connection.md), e Ferramentas, as CLIs, os servidores MCP, as plataformas e os containers desta máquina e da Workstation, com instalar e atualizar pelo catálogo do núcleo (C72 a C76, issue #280, decisão [0014](../decisoes/0014-dev-tools-command-catalog.md)). A caixa para mandar mensagem a uma sessão viva pelo Detalhe (C51), os estados da entrega (C52) e quando ela não dá (C53) são da issue #61. As telas novas aparecem em 1100 px, a largura da janela do app, e em 1440 px. A separação entre "Precisa de você" (a sessão trava) e "Ociosa" (a vez é sua), da issue #245, muda o Dashboard, Mural, Sessões, Detalhe (Conversa e Linha do tempo), Feed, os dois Kanbans, Dev Console, Workstation, a bandeja (A1 a A8), as notificações e a legenda do painel (P0); essas telas do console aparecem em 1100 px.

A referência é o Claude Code Agent Monitor. Cada tela diz o que veio dele e onde diverge.

É um artefato do claude.ai versionado aqui ([artifact.json](artifact.json)), no formato das skills `versioning-artifacts` e `publishing-artifacts`. O link oficial só é publicado depois do merge.

| Arquivo | O que é |
| --- | --- |
| [index.html](index.html) | A página. Segue o contrato do Artifact: sem `<html>` nem `<head>`, CSS embutido e só scripts de CDN permitida (ícones Lucide). |
| [montar.mjs](montar.mjs) | Copia `packages/marca/gerado/marca.css` para dentro da página. Com `--checar`, falha se a cópia estiver velha. Nenhuma cor é escrita à mão. |
| [capturar.mjs](capturar.mjs) | Gera um PNG por tela em [capturas/](capturas/), abrindo a página em `?captura=<id>` num Chromium headless já instalado. A URL base pode levar `?theme=light&width=1100` (só a coluna daquela largura, nas telas que marcam `data-w`); `AHRENA_CONSOLE_CDP_PORT` troca a porta 9333 quando outra captura já a usa. |

Para ver no navegador, sirva a página com o mesmo esqueleto que o Artifact põe na publicação (um `<!doctype html>` em volta) e abra em `http://127.0.0.1:<porta>/`. `?captura=<id>` mostra só uma tela e `?theme=light` força o tema claro (o antigo `?tema=light` continua aceito).

```bash
node docs/wireframes/montar.mjs --checar
```

Os dados são sintéticos, com o vocabulário do simulador (`packages/nucleo/src/simulador`).
