# Kanban do projeto

Item 5.3 do backlog. O console mostra os itens de um GitHub Project por Status e muda o Status no GitHub quando um card troca de raia. Por padrão, o Project é o do próprio Ahrena Console, o Project 3 da organização `ahrenatechnology`. Assim o console gerencia o próprio desenvolvimento.

## O que aparece

- **Raias:** uma por opção do campo Status, na ordem do Project. Itens sem Status ficam numa raia "Sem status", a primeira, como no GitHub.
- **Cards:** o mesmo tamanho dos cards das outras visões. Cada um mostra o tipo da issue, a raia, o número, o título, o pai (`↑ #6`) e há quanto tempo mudou. Embaixo ficam os botões `◂` e `▸`, que levam o card para a raia anterior ou a seguinte, e o link para a issue.
- **Layout:** abaixo de 150 colunas, as raias ficam uma embaixo da outra e os cards quebram linha. A partir de 150, as raias ficam lado a lado e também quebram linha se não couberem. O quadro nunca passa da largura do painel.
- **Limite:** cada raia mostra 8 cards. O botão `+N mais` mostra o resto.

## Como os dados chegam

O quadro segue a [decisão 0001](decisoes/0001-github-consulta-cache.md):

- O Project é lido numa consulta de custo 1 a cada 100 itens, e de novo a cada 2 min. "Atualizar agora" relê na hora, com intervalo mínimo de 30 s.
- Mover um card faz uma única mutação no GitHub. O núcleo atualiza o cache com o item que a mutação devolve e não relê o Project. Quem moveu vê a mudança na hora. Os outros veem em até 2 min.
- Se o GitHub limitar as chamadas ou cair, o quadro continua aparecendo com o último dado lido, e um aviso diz o motivo.

## Configuração

- **Qual Project:** no núcleo de teste, a variável `AHRENA_CONSOLE_PROJECT=dono/número`. O padrão é `ahrenatechnology/3`. No núcleo, use `createGithubProject({ project: { owner, number } })` (ver o [README do núcleo](../packages/nucleo/README.md#kanban-de-um-project)).
- **Permissão:** o token do `gh` precisa do escopo `project` para ler e para mover. Sem ele, o painel mostra o erro com o comando que resolve:

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
