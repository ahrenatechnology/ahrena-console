# Ahrena Console: painel lateral

Plugin do Claude Code com o painel da sessão (`/console`), construído sobre os [wireframes aprovados](../../docs/wireframes/) (P0 a P13) e as decisões [0004](../../docs/decisoes/0004-painel-da-sessao.md) e [0006](../../docs/decisoes/0006-multiplas-contas.md). Cobre as issues #35 (4.1), #36 (4.2), #37 (4.3), #116 (4.8) e #102 (decisões).

O painel olha a sessão em que está aberto:

- **Esta sessão:** status com motivo e tempo, modelo, turno (a linha do modelo nunca corta: sem caber, "Opus 5.5" vira "Opus", depois "turno 262" vira "t262" e, por último, ela quebra), o que ela faz agora e, quando ela espera por você, a faixa com a pergunta, a permissão ou o erro inteiros (P1 a P6);
- **Contexto e custo:** contexto usado, custo estimado com a curva da sessão, tokens e processos em background;
- **Trabalho:** a issue e o PR achados pelo branch, com sub-issues, CI com contagem ("CI ✓ 6/6", "CI ✕ 2 falhas", "CI … 3/7") e review;
- **Plano, subagentes e sessões filhas:** o que roda dentro dela (P4). O card Plano é o do P1: o anel com o % à esquerda e, à direita, "✓ N feitas", o passo atual em negrito e "○ próximo · +N". O "N/M ›" do cabeçalho abre o detalhe, com os passos do plano atual e os anteriores com ✓ (concluído) ou ◐ (abandonado), o resumo e a duração (#131);
- **Decisões, uma linha (pnDec do P1):** "⊸ N decisões registradas", com quantas estão a confirmar; sem nenhuma, "nenhuma decisão registrada ainda", sem botão; "Ver" abre os cards de cada decisão (origem, há quanto tempo, o que se decidiu, o que foi descartado, o estado e quem decidiu), com o escopo trocado entre Sessão, Família e Branch. A sugerida tem Confirmar e Descartar; a substituída aparece riscada e aponta a nova (P9). Depois de um `/clear`, uma faixa diz quantas decisões da sessão anterior continuam valendo (P10);
- **Uma decisão inteira (#131):** clicar no título de um card abre o detalhe, com a escolha completa, o que foi descartado, o contexto, quem decidiu, quando, a origem e "ver na conversa". Ali ficam o Confirmar, o Descartar, o **Ajustar** (a sua versão, ou um comentário, gravada como "correção sua" no lugar da sugerida) e o **Desfazer** da última ação. Depois de Confirmar, Descartar ou Ajustar, "Desfazer" fica à vista por 10 s também na lista;
- **Subagentes e sessões filhas (#131, P1):** em Subagentes, "N ativos" no cabeçalho, a barra por estado (ativo laranja, concluído verde, erro vermelho) e até 3 linhas (os ativos primeiro, depois os concluídos mais recentes), o tipo em negrito, "· descrição" e o tempo. O pé abre o grafo da sessão: "ver o grafo ›" com todos no card, "+N · E com erro · grafo ›" com mais (P11). Em Sessões filhas, a contagem no cabeçalho e até 3 linhas, "nome … tempo": as que trabalham primeiro, depois as que precisam de você, com "Precisa" em âmbar à direita, e as ociosas, com "Ociosa" em cinza (#245); embaixo, "ver todas as N ›". A lista completa diz o que cada filha que trabalha está fazendo ("pensando", "rodando Bash"). As filhas arquivadas no Claude Desktop contam no cabeçalho ("15 · 9 arquivadas") e vêm por último; na lista completa, cada uma tem "Desarquivar", que pede à sessão do painel para chamar `unarchive_session` (a pessoa aprova). O botão só aparece com a sessão ociosa; no meio de um turno, "aguarde o turno" (#145). A sessão que está no índice do Claude Desktop tem o nome como botão que abre a conversa dela direto: no macOS, o núcleo roda `open claude://claude.ai/epitaxy/<local_…>` (`POST /open/<local_…>`). Fora do macOS fica o link de reserva, que passa pelo navegador (`GET /open/<local_…>` redireciona; o `Link` do mod só leva `https:` ou `http://localhost`). Também em "precisam de você" e no "Ir para a sessão". Sessão só de terminal fica sem link;
- **O grafo da sessão (#146, P12 e P13):** no lugar dos cards, a sessão na raiz e cada subagente pendurado em quem o disparou (o trilho ├ ╰), com o glifo do estado, o tipo e a descrição; à direita, a barra de quando rodou na régua da sessão (barras sobrepostas rodaram em paralelo) e a duração; no largo, também o estado e o minuto em que começou. Com mais de 10 subagentes, por onda (o que um mesmo turno da sessão disparou): a onda com ativos abre, a só de concluídos recolhe numa linha com a contagem e a faixa no tempo, e ▸/▾ abre e fecha; o com erro e o ativo nunca somem. Aninhados com linha até o 2º nível; abaixo, "+N" na linha de cima. O Select troca entre Todos e Ativos e erros, e a tela pagina pela altura (‹ 1/2 ›), sem cortar uma linha. O núcleo manda, de cada subagente, o `pai` e a `onda`; sem a onda, o painel agrupa pela sobreposição no tempo;
- **O que pede atenção, no topo (0.0.21, decisão do Fernando, desvio do P1):** logo abaixo de "ESTA SESSÃO" e antes dos cards vêm a pergunta da sessão, "N precisam de você", "N PRs aguardando sua aprovação" e as decisões a confirmar. Depois dos cards ficam só os neutros: "N decisões registradas" e, sem ninguém bloqueado, "ninguém mais precisa de você". Sem nada pendente, o topo não ganha faixa;
- **Os seis cards do P1, sempre (0.0.19):** todo card tem a mesma altura fixa (34 colunas e 9 linhas, a que o Contexto pede no Desktop), e os seis aparecem sempre, inteiros e no lugar deles; a altura que sobra fica vazia embaixo, e a que falta o corpo do pane rola. Dentro do card, cada linha é uma só, com reticências, como no P1; o inteiro fica no detalhe. O tempo das listas fica numa coluna fixa, em minutos (sem segundos, que redesenhariam o painel a cada tick); as faixas de baixo quebram em vez de cortar, e a última mensagem aparece sem o markdown cru. Toda tela que toma o lugar da sessão tem "← voltar" em cima e embaixo;
- **O encaixe pelo próprio mod (0.0.32):** o Desktop deixou de encurtar o `wrap="truncate-end"` (a última mensagem quebrava em quatro linhas e vazava do card). Agora o mod mede, em colunas, cada texto de uma linha e o encurta com reticências antes de desenhar ([hooks/fit.ts](hooks/fit.ts)). O título do card Esta sessão nunca corta: quebra em até 2 linhas e, com 2, a última mensagem sai para o card não crescer; mais longo que isso, encurta por palavra inteira. O teste-guarda (`tests/fit.test.tsx`) desenha os cenários, o caso real e textos longos nas duas larguras e em cada estado, e confere a largura de cada texto e a altura de cada card;
- **Compactar (0.0.9):** fora do cabeçalho do card, que diz "estimativa", como no P1. Até 79%, o rótulo "CONTEXTO ›" do tile abre a confirmação; a partir de 80%, o "Compactar agora" toma o lugar do tile Background, e a grade 2×2 fica. Pede confirmação, compacta só esta sessão (`$.session.compact()`, o mesmo do `/compact`), mostra "compactando…" até terminar e diz o resultado, ou o motivo quando o engine recusa (no meio de um turno);
- **A pergunta desta sessão no topo (#140):** quando o turno termina com a caixa de próximo passo do Desktop (`wrap_up` com `ask`) ou com um AskUserQuestion, a pergunta aparece no topo, inteira e em destaque. Na caixa de próximo passo, cada resposta com mensagem é um botão que a manda ao chat (`$.prompt.submit`, como a pessoa); as ações do app (commit, criar PR) e o AskUserQuestion se respondem no chat ("responder no chat ↓"). O mod captura a pergunta direto do engine (`tool.call`), sem passar pelo núcleo. Ela fica no `$.state` (sobrevive a reload) e só sai quando a pessoa responde (um prompt dela, no Desktop, no terminal ou pelo celular, ou o clique no botão); uma mensagem automática (outra sessão, notificação, gatilho, plugin) não a tira;
- **Um redesenho só quando a tela muda (0.0.14):** cada redesenho troca os handles dos botões, e um clique com o handle antigo se perde. O polling compara o desenho, não os dados: o que muda nos dados sem mudar a tela não redesenha; o que troca os botões redesenha na hora; números e textos, no máximo a cada 15 s;
- **Rodapé:** "plugin 0.0.35 · api 0.0.1 (<commit>)", com o commit do código que a API carregou. Se a pasta da API já está em outro commit, uma segunda linha pede para reiniciar a API;
- **De fora, uma linha:** "N precisam de você", somando todas as contas, com a divisão por conta ao passar o mouse; "Ver" abre a lista, só a família ou a máquina inteira (P7);
- **Sua vez × precisa de você × PRs (#140):** "N precisam de você" conta só as sessões bloqueadas até você agir: permissão, pergunta com opções, plano para aprovar, decisão pedida no fechamento do turno e erro. A sua vez no bate-bola (o turno acabou, Esc, sessão nova) aparece ao lado em cor neutra, "M na sua vez", sem somar; na tela "Ver", fica num grupo à parte. Com zero, "○ ninguém mais precisa de você" em cor neutra e sem "Ver" (P1). Os PRs abertos pelas sessões que aguardam aprovação (review pendente no GitHub) têm um indicador próprio, em laranja, "N PRs aguardando sua aprovação" (no estreito, "N PRs p/ aprovar"), com a lista de links;
- **Precisa de você × Ociosa (0.0.35, #245, P0, P2, P3, P6 e P10):** o antigo "Esperando você" virou dois estados, como no núcleo, na /ui e na bandeja. **Precisa de você** (`blocked`: pede permissão, pergunta, plano para aprovar, decisão pedida, erro) fica em amarelo, com o card tingido e o chip do motivo forte; **Ociosa** (`idle`: sua vez, interrompida, no prompt) fica neutra, "○ Ociosa" e o chip leve, sem amarelo. O mod lê o `attention` da sessão que o núcleo manda; de um núcleo antigo, sem o campo, deduz do estado e do motivo. A linha de status diz "◐ Precisa de você" ou "◌ Ociosa · No prompt". A faixa e a contagem de "precisam de você" contam só as `blocked` (ou `needs`, do núcleo anterior); as ociosas ficam ao lado, "M na sua vez", sem somar;
- **Sem o núcleo:** a última leitura, o aviso e uma nova tentativa a cada 5 s (P8);
- **O núcleo pelo registro (0.0.34, #221):** sem porta fixa. O mod lê o registro de instâncias (`~/.ahrena-console/instances/*.json`, ou `$AHRENA_CONSOLE_HOME/instances`), fica com as entradas cujo núcleo responde `/api/overview` com o mesmo pid e prefere o da própria instalação (`dev`, a do checkout e do marketplace); sem ele, o vivo que subiu primeiro. Quando o núcleo para de responder (reiniciou em outra porta), o próximo tick procura de novo. Sem nenhum vivo, tenta `127.0.0.1:4720`, como antes: na transição (decisão 0010, item 7), é ali que ouvem os núcleos publicados antes do registro, como o app 0.0.1, e o painel funciona com eles. O mod só lê o registro, nunca grava nem apaga.

A conta da sessão aparece ao lado de "ESTA SESSÃO", com o rótulo e a cor que você der a ela.

## Instalar

O plugin é por pasta de configuração (decisão 0006): instale em cada `CLAUDE_CONFIG_DIR` que usar.

No Claude Code:

```
/plugin marketplace add ahrenatechnology/ahrena-console
```

```
/plugin install ahrena-console@ahrena-console
```

Depois, `/reload-plugins` e `/console`. Para atualizar, `/plugin marketplace update ahrena-console`.

Pelo terminal, o mesmo em dois passos (para testar um branch, acrescente `@<branch>` ao repositório):

```bash
claude plugin marketplace add ahrenatechnology/ahrena-console
```

```bash
claude plugin install ahrena-console@ahrena-console
```

O painel de teste (`ahrena-console-painel`, em `spikes/`) também registra `/console`. Desligue-o antes, para os dois não disputarem o comando:

```bash
claude plugin disable ahrena-console-painel@ahrena-console-testes
```

Além do painel, o plugin leva os hooks que mandam os eventos da sessão ao núcleo ([forward.mjs](hooks/forward.mjs), o mesmo de `packages/nucleo/src/ingest/hooks/plugin`). Desde a 0.0.33, cada evento vai, ao mesmo tempo, para todos os núcleos vivos do registro de instâncias (`~/.ahrena-console/instances/`, [decisão 0010](../../docs/decisoes/0010-core-per-installation.md), item 4), e, na transição, também para a 4720, onde ouvem os núcleos publicados antes do registro (o app 0.0.1), sem repetir um núcleo do registro que já esteja nela; `AHRENA_CONSOLE_URL` ou `AHRENA_CONSOLE_PORT` mandam para um núcleo só. Eles não atrapalham nada: sem núcleo vivo, desistem calados; com um núcleo que não responde, desistem em 800 ms e registram a falha, com a porta, em `~/.ahrena-console/hooks.log`.

## Subir o núcleo

O painel acha a API local do núcleo pelo registro de instâncias (sem nenhum, `127.0.0.1:4720`). Com Node 24 ou mais novo:

```bash
cd packages/nucleo && npm run api
```

Ela importa o histórico de `~/.claude/projects`, segue os transcripts, recebe os hooks, roda a máquina de estados e responde ao painel. O banco fica em `~/.ahrena-console/nucleo.sqlite`. O GitHub usa o token do `gh`. `npm run api -- --help` lista as opções (outra porta, sem GitHub, sem histórico).

Um núcleo por instalação, em porta aleatória ([decisão 0010](../../docs/decisoes/0010-core-per-installation.md)): o do app desktop, o deste checkout (`dev`) e o da extensão convivem, cada um registrado em `~/.ahrena-console/instances/`, e o painel acha o vivo por lá. `npm run core -- status|start|stop` mostra, sobe em segundo plano e para o núcleo deste checkout ([src/owner](../../packages/nucleo/src/owner/README.md)).

Para ver o painel com dados de exemplo, sem tocar em nada real, a demonstração serve um dos cenários dos wireframes a qualquer sessão que abrir o painel:

```bash
cd packages/nucleo && npm run api -- --demo --scenario p4
```

Se a porta já tem um núcleo, a demonstração não sobe e não o adota: ela falha e pede outra porta (`--port 4730`).

Os cenários vão de `p1` a `p7` (P8 é o núcleo desligado), mais o `p9`, com as decisões da sessão e da sessão mãe, e o `p12` e o `p13`, com o grafo dos subagentes simples e caótico. São do simulador: projetos sob `/simulacao`, repositório `exemplo/simulacao`, contas `equipe` e `cliente-exemplo`.

### Porta

Uma porta fixa: `npm run api -- --port 4730`. O painel acha o núcleo pelo registro; para fixar uma porta, a opção `port` do plugin (no `/config`, ou em `pluginConfigs` do `settings.json`). Uma porta maior que 0 escrita ali vale mais que o registro; `0`, o padrão desde a 0.0.34, é achar pelo registro. A opção antiga `porta` (até a 0.0.30) é ignorada desde a 0.0.34: o `settings.json` de quem veio daquelas versões guarda nela o padrão de então, `4720`, e não uma escolha.

### Rótulo e cor das contas

O rótulo e a cor são os da conta no núcleo (`ClaudeAccount.label` e `color`). Sem eles, valem os de `~/.ahrena-console/contas.json`, com a chave `<accountUuid>/<organizationUuid>` e a cor em hex; sem nada, "conta 1", "conta 2", com as cores da marca:

```json
{ "<accountUuid>/<organizationUuid>": { "rotulo": "cliente", "cor": "#1baf7a" } }
```

O painel nunca mostra o id. Vale a fonte de menor ordem da decisão 0006 entre a conta gravada na sessão, o ambiente da própria sessão (`CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID`, que o painel lê e manda) e o índice do Claude Desktop, quando a sessão está numa pasta conta/org só. Sem fonte, a sessão fica em "sem conta", nunca na conta de outra.

## Consumo

Regra da issue #81 e da decisão 0004:

- o painel só consulta com ele aberto e à vista; fechado, atrás de outra aba ou com a sessão encerrada, não pede nada;
- a cada 5 s, um pedido só: `GET /api/panel/<esta sessão>`. Nunca a frota. Com as decisões abertas, o mesmo pedido leva `decisions=<scope>` e traz a lista; Confirmar e Descartar são um `POST /api/decisions/<id>/confirm` (ou `/dismiss`) cada, só no clique;
- o núcleo responde do banco e de caches em memória: lê só os eventos novos da sessão, recalcula o custo no máximo a cada 30 s, conta "precisam de você" por índice uma vez a cada 4 s para todos os painéis, confere o índice do Desktop a cada 30 s e nunca espera o GitHub no caminho do pedido.

Os números medidos estão no PR que trouxe o painel e saem de `node scripts/medir-carga.mjs --rota painel`.

## Onde difere dos wireframes

O que os elementos nativos do mod, ou o que ainda não existe, não deixam ficar igual:

| No wireframe | No painel | Por quê |
| --- | --- | --- |
| Faixa "N decisões da sessão anterior" (P10) | Só aparece quando o núcleo manda | A reinjeição depois do `/clear` é da #100; a faixa acende com ela, e "desligar a injeção" ainda não age |
| "ver na conversa" | Rola a conversa até a chamada que originou a decisão; de outra sessão, diz onde ela está | O mod não abre outra sessão no Claude Desktop |
| `CI ✓ 6/6`, `CI … 3/7` | `CI ✓`, `CI … rodando`, `CI ✕ falhou` | O núcleo lê o estado agregado das checagens (decisão 0001), não a contagem |
| "Ir para a sessão" abre a outra sessão | Copia o nome e diz que ela está na barra lateral | O mod não troca de sessão no Claude Desktop |
| "ver a árvore no artefato ›" | Não aparece | O artefato com a árvore (épico #4) ainda não tem link estável |
| Conta da sessão | "◆ rótulo" ao lado de "ESTA SESSÃO" | Os wireframes são de antes da decisão 0006 |
| Cores do tema claro | Paleta do tema escuro | O mod não sabe o tema do app; os tokens são de `packages/marca` |

## Testes

```bash
claude plugin test plugins/ahrena-console
```

Os cenários dos testes (`tests/scenarios.ts`) são a resposta da API (`GET /api/panel`) para cada cenário do simulador; para regravar depois de mudar a API:

```bash
cd packages/nucleo && node test/api/record-panel-scenarios.ts > ../../plugins/ahrena-console/tests/scenarios.ts
```

## Arquivos

| Arquivo | O quê |
| --- | --- |
| [hooks/register.tsx](hooks/register.tsx) | `/console`, o polling com o painel aberto, a leitura do ambiente e as ações |
| [hooks/render.tsx](hooks/render.tsx) | As telas P1 a P13 com os elementos nativos do mod |
| [hooks/graph.ts](hooks/graph.ts) | A montagem do grafo da sessão (#146): árvore, ondas, recolhidas, filtro e páginas, sem desenho |
| [hooks/format.ts](hooks/format.ts) | Tempo, modelo, tokens, custo, status e motivos |
| [hooks/fit.ts](hooks/fit.ts) | O encaixe: a medida em colunas de cada elemento, o encurtamento dos textos de uma linha e a altura dos cards (0.0.32) |
| [hooks/discover.ts](hooks/discover.ts) | O núcleo pelo registro de instâncias: as entradas válidas, a conferência do pid em `/api/overview` e a ordem (a instalação `dev`, depois a mais antiga) (0.0.34) |
| [hooks/height.ts](hooks/height.ts) | A altura dos cards e da grade, em linhas do corpo |
| [hooks/brand.ts](hooks/brand.ts) | Cores da marca, gerado por `packages/marca` |
| [hooks/forward.mjs](hooks/forward.mjs) | O encaminhador dos hooks para o núcleo |
| [types/index.d.ts](types/index.d.ts) | O contrato da API e o estado do painel |
