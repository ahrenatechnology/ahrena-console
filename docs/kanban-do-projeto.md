# Kanban do projeto

Item 5.3 do backlog. O console mostra os itens de um GitHub Project por Status e muda o Status no GitHub quando um card troca de raia. Não há Project padrão: cada um escolhe o seu. Sem configuração, a tela explica como escolher. O próprio Ahrena Console usa o Project 3 da organização `ahrenatechnology` para gerenciar o próprio desenvolvimento.

## O que aparece

- **Raias:** uma por opção do campo Status, na ordem do Project. Itens sem Status ficam numa raia "Sem status", a primeira, como no GitHub.
- **Cards:** o mesmo tamanho dos cards das outras visões. Cada um mostra o tipo da issue, a raia, o número, o título, o pai (`↑ #6`) e há quanto tempo mudou. Embaixo ficam os botões `◂` e `▸`, que levam o card para a raia anterior ou a seguinte, e o link para a issue.
- **Layout:** abaixo de 150 colunas, as raias ficam uma embaixo da outra e os cards quebram linha. A partir de 150, as raias ficam lado a lado e também quebram linha se não couberem. O quadro nunca passa da largura do painel.
- **Limite:** cada raia mostra 8 cards. O botão `+N mais` mostra o resto.

## Como os dados chegam

O quadro segue a [decisão 0001](decisoes/0001-github-consulta-cache.md):

- O Project é lido numa consulta a cada 100 itens, e de novo a cada 2 min. A mesma consulta traz, por card, o marco (milestone), o resumo das sub-issues e o PR que fecha a issue, com o CI do último commit e o review. O custo estimado é de ~3 pontos por página (1 sem o PR). "Atualizar agora" relê na hora, com intervalo mínimo de 30 s.
- Mover um card faz uma única mutação no GitHub. O núcleo atualiza o cache com o item que a mutação devolve e não relê o Project. Quem moveu vê a mudança na hora. Os outros veem em até 2 min.
- Se o GitHub limitar as chamadas ou cair, o quadro continua aparecendo com o último dado lido, e um aviso diz o motivo.

## Configuração

- **Qual Project:** o escolhido na própria tela do Kanban do projeto (#241, [decisão 0011](decisoes/0011-github-device-flow-keychain.md) §7), guardado nas preferências da instalação. `AHRENA_CONSOLE_PROJECT=dono/número`, quando definida, vence a escolha, com um aviso na tela. Não há Project padrão. No núcleo, use `createGithubProject({ project: { owner, number } })` (ver o [README do núcleo](../packages/nucleo/README.md#kanban-de-um-project)).
- **Permissão:** a credencial precisa do escopo `project` para ler e para mover. Com a conexão do próprio console (a padrão), ela já é pedida; se faltar, a tela manda reconectar o GitHub em Conexões. Só quem escolheu a fonte `gh` (`AHRENA_CONSOLE_GITHUB_SOURCE=gh`) vê o comando:

  ```bash
  gh auth refresh -s project
  ```

## Como testar no painel

1. Suba o núcleo de teste:

   ```bash
   cd spikes/nucleo-teste && npm ci && node server.mjs
   ```

2. Com o painel de teste instalado ([spikes/painel-teste](../spikes/painel-teste/)), rode `/reload-plugins` e abra a aba **Kanban**.
3. Clique em `▸` num card para levá-lo à raia seguinte. Confira a mudança no Project do GitHub e depois devolva o card com `◂`.

Sem o painel, as mesmas rotas respondem direto do núcleo de teste: `GET /api/kanban` devolve o quadro, e `POST /api/kanban/move`, com `{ "itemId": "...", "optionId": "..." }`, move um card.

## No núcleo (#80, wireframe C11)

A API local do núcleo (`npm run api`, em `packages/nucleo`) serve o mesmo quadro para a interface em `/ui`, com as chaves em inglês e os textos de tela em pt-BR ([src/api/project.ts](../packages/nucleo/src/api/project.ts)):

| Rota | O quê |
| --- | --- |
| `GET /api/project` | O quadro: `project`, `lanes` (cada uma com os `cards`), `milestones`, `total`, `fetchedAt`, `stale`, `reason` e `source` (`github` ou `demo`). `?refresh=1` é o botão Atualizar (mínimo de 30 s) |
| `POST /api/project/move` | `{ "itemId": "PVTI_…", "optionId": "<raia>" }`. Devolve `{ board, moved: { itemId, from, to } }`. Desfazer é outro mover com a raia `from` |

Cada card traz o tipo da issue, número, título, marco, sub-issues (`done`/`total`), o PR (`number`, `ci`: `ok`/`failed`/`running`, `review`: `approved`/`changes-requested`/`pending`) e a raia (`laneId`).

Os erros têm o corpo `{ "error": "...", "code": "..." }`:

| Status | `code` | Quando |
| --- | --- | --- |
| 400 | `invalid` | Corpo ou ids fora do padrão |
| 401 | `no-scope` | A credencial não tem o escopo `project` (o corpo traz `"scope": "project"`). Na conexão do console, a mensagem manda reconectar em Conexões; na fonte `gh`, o corpo traz também `"command": "gh auth refresh -s project"` |
| 409 | `github-not-connected` | O GitHub não está conectado (corpo `{ "error": "github-not-connected" }`, sem `code`); nada sai para o GitHub |
| 404 | `unknown-item` | O item não está no Project |
| 422 | `unknown-lane` | A opção não existe no campo Status |
| 429 | `rate-limited` | O GitHub limitou e não há cache; com `Retry-After` |
| 502 | `github-down` / `github-refused` | O GitHub falhou sem nada no cache (GET), ou recusou a mutação (mover) |
| 503 | `off` | O núcleo subiu com `--no-github` |
| 503 | `no-project` | Nenhum Project escolhido |

Com o GitHub fora e o quadro no cache, o GET responde 200 com `stale: true` e o `reason`.

**Origem.** Como as outras rotas, o núcleo recusa `Host` que não seja `127.0.0.1:<porta>` ou `localhost:<porta>` ([decisão 0003](decisoes/0003-responder-sessao.md)). O mover é a única escrita que aceita `Origin`, e só o da própria `/ui` (`http://<Host>`). Pede ainda `Content-Type: application/json` (415 sem ele) e corpo de até 4096 bytes (413).

**Configuração.** O Project é o escolhido na tela (`GET /api/project/options` lista os que a conta enxerga; `POST /api/project/selection` guarda a escolha). `AHRENA_CONSOLE_PROJECT=dono/número` vence a escolha quando definida. A credencial é a da conexão do console com o GitHub (#241), e o cache fica no banco do núcleo. Sem Project escolhido, as rotas respondem 503 `no-project` e a tela lista os Projects para escolher. `--no-github` desliga o quadro (503 `off`). O quadro diz de onde veio o Project em `selection.from` (`env`, `settings` ou `demo`) e traz `envOverride` quando a variável vence.

**Demo.** A `--demo` traz um GitHub falso com o quadro do wireframe C11: o Project "Ahrena Console", as raias Backlog, Ready, In Progress, In Review e Done, e os 11 cards. Mover funciona em memória, até o processo sair:

```bash
cd packages/nucleo
npm run api -- --demo --scenario p4 --port 4794
curl -s http://127.0.0.1:4794/api/project
curl -s -X POST -H 'content-type: application/json' \
  -d '{"itemId":"PVTI_simulado80","optionId":"e4f5a6b7"}' http://127.0.0.1:4794/api/project/move
```

Os testes ([test/api/project.test.ts](../packages/nucleo/test/api/project.test.ts)) usam a leitura gravada do Project e um GitHub falso: nunca chamam a API real nem movem cards de verdade.
