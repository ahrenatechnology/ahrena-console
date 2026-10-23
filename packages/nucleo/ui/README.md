# Interface do console (`/ui`)

A moldura do console ([#26](https://github.com/ahrenatechnology/ahrena-console/issues/26)), que o núcleo serve em `http://127.0.0.1:<porta>/ui`. É a janela do app desktop ([0005](../../../docs/decisoes/0005-app-desktop.md)) e, depois, o artefato. Página estática: sem build, sem dependências, módulos ES servidos como estão.

| Arquivo | O quê |
| --- | --- |
| `index.html` | A página: barra lateral, logo, "Ao vivo" e porta. Toda rota `/ui/...` devolve esta página |
| `app.js` | A moldura: monta a barra, roteia no cliente, liga o "Ao vivo" e abre a tela da rota |
| `screens.js` | **O registro das telas** (`route`, `item`, `file`) |
| `api.js` | A camada de leitura, `read(route)`, e de escrita: `write(route, body)` (POST JSON na `/api/`, ou DELETE com `{ method: 'DELETE' }`). Por HTTP na janela; o artefato troca o transporte com `useReader()` e `useWriter()` |
| `open-action.js` | Abrir a sessão onde ela roda ([#285](https://github.com/ahrenatechnology/ahrena-console/issues/285), C70 e C71): a mesma ação no cabeçalho do Detalhe, no pé do card do Mural, na linha de Sessões e no "precisam de você" do Dashboard. O alvo vem do núcleo (`open.target`: Claude Desktop, terminal, terminal já rodando, outra máquina ou nada); o clique é `write('/api/sessions/<uuid>/open', {})`, e ao lado do botão aparecem "Abrindo…", o sucesso (some em 4 s) ou o erro do núcleo com "Copiar comando" |
| `open-action.css` | O estilo dessa ação (classes `open-`), carregado uma vez pelo `index.html` |
| `machine-filter.js` | As sessões de todas as máquinas ([#243](https://github.com/ahrenatechnology/ahrena-console/issues/243), C45 a C49): o filtro "Máquina" (Todas · Esta máquina · uma por remota, pelo `label`), o rótulo do item remoto (`machineTag`, só o ícone com o nome na dica onde o card é estreito), o aviso neutro de remota sem conexão (`downNotice`, C48; nunca a `errorBand`), as chaves `máquina:id` (`itemKey`) e o link do Detalhe remoto (`sessionHref(id, machine)`, `/ui/sessions/<id>?machine=<id>`). A parte sem DOM vem antes da linha "DOM" (o teste importa direto). Ver "O parâmetro `?machine=`" abaixo |
| `machine-filter.css` | O estilo do filtro, do rótulo e do aviso (classes `mf-`), carregado uma vez pelo `index.html`, como o `open-action.css` |
| `live.js` | Long polling em `GET /api/changes?since=<cursor>&wait=25` |
| `states.js` | Os três estados de toda tela (C19): `loading`, `empty`, `error`, e a `errorBand` |
| `dom.js` | `el()`, `icon()` e `header()` |
| `shell.css` | O estilo da moldura. Toda cor é variável da marca |
| `github-connect.js` | A conexão com o GitHub em toda tela (issue 241): o vazio "Conectar ao GitHub" (C42, `connectEmptyFor(tela, ctx.navigate)`), que toda tela que lê o GitHub mostra quando a rota responde 409 `{ error: "github-not-connected" }` e cujo botão abre `/ui/connections?start=1` (Conexões já pedindo o código); o pé da barra (`createGithubFooter`: "GitHub · conectar", "esperando", "<login> · conectado"); `connectionChanged(changes)`, a mudança `connections` de `/api/changes` que faz as telas relerem; e as frases em pt-BR dos códigos da conexão. As classes `ghc-*` e `cc-gh*` ficam no `shell.css` |
| `attention.js` | O vocabulário da atenção (#245), o mesmo em toda tela: "Precisa de você" (`attention.level` `blocked`, amarelo, com o motivo em chip forte: Pede permissão, Pergunta, Plano para aprovar, Decisão pedida; a de erro mantém a pílula vermelha "Com erro") e "Ociosa" (`idle`, neutra, ponto vazado, motivo em chip leve: Sua vez, Interrompida, No prompt). As classes `attention-*` ficam no `shell.css` |
| `brand.css` | Gerado por `packages/marca` (não edite) |
| `dashboard.css` | O estilo do Dashboard; a tela carrega o próprio arquivo, para não disputar `shell.css` |
| `wall.css` | O estilo do Mural ao vivo; a tela carrega o próprio arquivo (classes `wall-`), para não disputar `shell.css` |
| `sessions.css` | O estilo da tela Sessões, que a própria tela carrega: o estilo de uma tela fica num arquivo dela, fora do `shell.css` |
| `screens/` | As telas, uma por arquivo. `agent-config.js` é a Agent Config (C16 e C17, #63). `dashboard.js` (C1, #27) lê `GET /api/dashboard` e `GET /api/attention`; `wall.js` (C2, #34) lê `GET /api/wall`, com o filtro Todas / Precisam de você / Ociosas / Ativas no cliente (#245); `sessions.js` (C3, #28) lê `GET /api/sessions`, com o filtro e a ordem na query da URL (`?status=blocked&order=cost`; `blocked` e `idle` são as pílulas "Precisam de você" e "Ociosas", #245; um favorito antigo com `waiting`, `esperando` ou `custo` ainda abre, `waiting` e `esperando` em `blocked`); `history.js` (C15, #33) lê `GET /api/history`; `workflows.js` (C14, #96) lê `GET /api/workflows?filter=&node=`, com o filtro e o nó no estado da tela; `repos.js` (C22) lê `GET /api/repos`; `repo.js` (C23) lê `GET /api/repos/<dono>/<repo>?period=`. O CSS de uma tela fica ao lado dela (`screens/session-detail.css`) ou em `ui/` (`dashboard.css`, `wall.css`, `sessions.css`, `history.css`, `repos.css`), carregado pela própria tela |
| `screens/session-detail.js` | O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes, Conversa e Linha do tempo, sobre `GET /api/sessions/<id>…` (`src/api/session-detail.ts`). Uma aba nova é uma linha no registro `TABS_LIST` e um módulo `screens/session-detail-<tab>.js` que exporta `create(ctx, base, { head, setLabel })` (o contrato está no começo do `TABS_LIST`) |
| `screens/kanban.js` | O Kanban ([#31](https://github.com/ahrenatechnology/ahrena-console/issues/31)): sessões ou agentes em colunas por status, só leitura, em `/ui/kanban` (`?view=agents` para os agentes) |
| `kanban.css` | O estilo do Kanban, carregado pela tela só enquanto ela está aberta |
| `analytics.css` | O estilo da tela Analytics, carregado por `<link>` pela própria tela |
| `repos.css` | O estilo das telas Repositórios e Repositório (classes `repo-`), carregado por `<link>` pela própria tela |
| `repos-format.js` | Formatos, filtros, escalas e o que as telas de repositórios mostram, sem DOM (o teste importa direto) |
| `agent-config.css` | O estilo próprio da Agent Config (classes `ac-`), posto no `<head>` pela tela (`link[data-screen="agent-config"]`) |

## As telas

| Tela | Rota | Lê | Arquivo |
| --- | --- | --- | --- |
| Analytics · Visão geral (C12) | `/ui/analytics` | `GET /api/analytics?tz=` | `screens/analytics.js` |
| Analytics · Custo (C13) | `/ui/analytics/cost` | `GET /api/analytics/cost?days=7\|30\|90&tz=` | `screens/analytics.js` |
| Repositórios (C22) | `/ui/repos` | `GET /api/repos` | `screens/repos.js` |
| Repositório (C23) | `/ui/repos/:owner/:repo` | `GET /api/repos/<dono>/<repo>?period=30d\|90d\|1y` | `screens/repo.js` |
| Esta máquina (C24) | `/ui/machines/local` | `GET /api/telemetry?machine=local&hours=1\|12`, `GET /api/machines`, `GET /api/attention` | `screens/machine.js` |
| Máquina remota (C25, C26) | `/ui/machines/:id` | o mesmo, com `machine=<id>`; e a telemetria daqui para a coluna "No Mac" | `screens/machine.js` |
| Conexões (C39 a C41, C44) | `/ui/connections` (`?start=1` começa o device flow) | `GET /api/connections`; escreve `POST /api/connections/github/start`, `cancel`, `disconnect` e `source` | `screens/connections.js` e `screens/connections.css` (classes `conn-`) |
| Conexões, o catálogo (C57, C60, C61) | `/ui/connections` | com as rotas de nuvem no núcleo: `GET /api/connectors`, `GET /api/connections`, `GET /api/machines` e `GET /api/machines/<id>/connectors` de cada remota (a cada 30 s); sem elas (404), o detalhe do GitHub, como antes | `screens/connections.js` → `screens/cloud-connections.js` (`tryCatalog`) |
| Conexões · GitHub (C39 a C44) | `/ui/connections/github` | o mesmo detalhe do GitHub, aberto pelo card do catálogo | `screens/connections.js` |
| Conexões · AWS (C58, C59, C60) | `/ui/connections/aws` (`?machine=<id>` para uma remota) | `GET /api/connectors` ou `GET /api/machines/<id>/connectors`; escreve `POST` e `DELETE` `.../aws/sessions/<nome>/login` (Entrar e Cancelar) | `screens/cloud-connections.js`, `screens/cloud-parts.js`, `screens/cloud-format.js` e `screens/clouds.css` (classes `cl-`) |
| Dev Console (C27) | `/ui/dev-console` (`?context=<id>`, `?tab=merge-queue`) | `GET /api/dev-console` e `GET /api/dev-console?context=<id>` | `screens/dev-console.js` e `screens/dev-console.css` (classes `dev-`) |

O Kanban do projeto (issue 241): sem Project escolhido (503 `no-project`), a tela mostra a lista de `GET /api/project/options` para escolher (C43), e o quadro ganha "Trocar de Project" no cabeçalho; a escolha vai por `POST /api/project/selection`. Com `AHRENA_CONSOLE_PROJECT` definida, a faixa diz isso e a escolha não se edita. O seletor fica em `screens/project-picker.js` e `screens/project-picker.css` (classes `pp-`).

A conexão da máquina remota (issue 278, decisão 0013, C62 a C65): a tela de uma remota monta, de `screens/machine-connection.js` (o que dizer em `screens/machine-connection-format.js`, sem DOM; o estilo em `screens/machine-connection.css`, classes `mc-`), o card "Conexão" (o trio Túnel / Sessão AWS / Núcleo de lá, as portas do túnel, os comandos do `machines.json`, Reconectar e Parar o túnel) e o card "Onde roda" (provedor, tipo, região e id, lidos pelo núcleo de lá em `current.placement`), com a faixa de cima: o motivo da queda em palavras simples e a ação certa (SSO expirado: "Entrar na AWS e subir o túnel" e "Só entrar", que é o login da issue 277 da sessão deste Mac, no navegador), o andamento do job (etapas e tempo contra o limite, com Cancelar), a confirmação de Parar, "Parada por você" e o aviso de 15 min antes de a sessão expirar. Escreve `POST /api/machines/<id>/connection/start|stop|reconnect|login-and-start` e `DELETE /api/machines/<id>/connection`, só com o id. O gancho em `machine.js` é `machineConnection(ctx, id, …)`, `take(...)` a cada leitura e `view(...)` a cada pintura; um núcleo sem `connection` deixa a tela como era, e uma máquina só com o `reconnect` mantém o Reconectar da C50 e ganha o card que ensina o `connection`. Relê na mudança `alert` `<id>:connection`; os relógios andam aqui. Na barra, a remota parada por você fica com o ponto cinza ("Parada por você").

Os perfis de nuvem (issue 277, C66 e C67): as duas telas de máquina montam o card "Perfis de nuvem" de `screens/cloud-profiles.js` (`cloudProfiles(ctx, id)` uma vez e `card.node(label)` a cada pintura). Esta máquina relê na mudança `connector`; uma remota é lida a cada 30 s (3 s enquanto um login roda lá), e o login de lá é por código, mostrado aqui. Um núcleo sem as rotas esconde o card. A barra põe em Conexões o ponto do pior conector (`readConnectors` em `nav.js`).

As máquinas (issue 178, decisão 0008): as duas rotas abrem a mesma tela, `screens/machine.js`, com o que cada cartão mostra em `screens/machine-format.js` (sem DOM; o teste importa direto) e o estilo em `screens/machine.css` (classes `tm-`). Um grupo `null` da leitura não vira cartão; o que uma remota manda com outro formato é descartado campo a campo, sem derrubar a tela. A tela só mostra: nenhum botão sobe, derruba ou encaminha túnel ("Tentar agora" só relê). Relê a cada 30 s (amostra nova não publica mudança) e na hora quando chega um `alert` desta máquina ou um `<id>:machine-unreachable`.

**Os itens das remotas na barra.** O registro é estático, e as remotas vêm do `machines.json`, que só o núcleo lê. Por isso a barra (`nav.js`, `createNav`) lê `GET /api/machines` (ao conectar, a cada `alert` em `/api/changes` e a cada 60 s) e se redesenha com `sidebarSections([...SCREENS, ...machineItems(list)])`: cada remota vira um item do bloco Máquinas, depois de "Esta máquina", com o ponto do estado (`.cc-nav-dot`, em `shell.css`, com `role="img"` e o estado por extenso no `aria-label`). Os contadores e o item aceso sobrevivem ao redesenho. Sem remota, só "Esta máquina". A rota `/ui/machines/:id` acende o item da máquina aberta por `highlights(params)`, que pode ser uma função (`litItem` em `screens.js`).

**O que fica de fora do wireframe, e por quê.** A telemetria v1 (`src/telemetry/model.ts`) não traz estes dados, e a tela não inventa:

- Stacks Docker: sem as colunas CPU e "Sessão dona". A leitura tem, por stack, só containers rodando e parados e as portas publicadas; nem a CPU por stack nem a pasta de onde ela subiu.
- Processos do Claude: sem a linha "Núcleo do console". A leitura agrupa só o CLI e o Claude Desktop; o núcleo aparece, se aparecer, entre "Os que mais usam CPU".
- "De quem" das portas: só o que a leitura permite dizer: o núcleo do console (a porta desta janela, ou a do outro lado do túnel), o túnel (`túnel para <destino>`), quem segura uma porta do túnel e a stack Docker que publica a porta. Sem "sistema" para a 22 (a leitura não diz o dono do processo) e sem agrupar as portas de stacks diferentes em "3 stacks": cada stack fica na linha dela.
- "O que é, lido do núcleo de lá", no túnel: o núcleo da remota (a porta do `machines.json`) e, quando a leitura da remota está à mão, o processo que escuta lá; sem o projeto ("vite · catalogo-exemplo").
- O cartão Sessões conta os itens da `/api/attention` daquela máquina, com quantos "precisam de você": a API não dá o total de sessões vivas por máquina.
- Versão diferente: compara a versão da telemetria (v1), não a do núcleo (0.0.1 contra 0.0.2).
- Rede: a interface da rota padrão, sem o tipo ("Wi-Fi").

O Analytics tem duas abas, que são a mesma tela: em `screens.js`, a entrada `analytics` (item da barra) e a `analytics-tab` (`/ui/analytics/:tab`, acende Analytics). A tela lê `ctx.params.tab`: só `cost` é aba; outra coisa mostra "Aba não encontrada". As abas são `<a href>`, então trocar de aba não recarrega a página. O fuso vai sempre o do navegador. O uso da tela está em [docs/analytics.md](../../../docs/analytics.md).
| `decisions.css` | O estilo das Decisões (C20 e C21). Toda classe é `dec-*`; `decisions-common.js` põe o `<link>` no `<head>` ao montar |

## Registrar uma tela

1. Crie `ui/screens/<name>.js` exportando `mount(area, ctx)`:

   ```js
   import { header } from '../dom.js';
   import { loading, empty, error } from '../states.js';

   export async function mount(area, ctx) {
     const head = header({ icon: 'sessions', title: 'Sessões', sub: '…' });
     area.replaceChildren(head, loading());
     async function draw() {
       try {
         const data = await ctx.read('/api/...');
         area.replaceChildren(head, data.length ? list(data) : empty({ title: 'Nenhuma sessão ainda', text: '…' }));
       } catch (e) {
         if (e.name === 'AbortError') return;
         area.replaceChildren(head, error({ text: e.message, retry: draw }));
       }
     }
     ctx.onRestart(draw);
     ctx.onChange((changes) => { /* relê o que mudou */ });
     await draw();
     return () => { /* limpeza ao sair da tela, se precisar */ };
   }
   ```

2. Em `screens.js`, aponte o `file` da entrada: `file: '/ui/screens/<name>.js'`. Uma tela nova ganha uma entrada com `id`, `route`, `title`, `icon` e, se aparece na barra, `item: { label, icon, section }`. Id, rota, nome de arquivo e classes em inglês (decisão 0009); o texto da tela em pt-BR. `section` é o bloco da barra, um id de `SECTIONS` em `screens.js`: `main` (as telas do dia a dia, sem título), `delivery` (Entrega: Repositórios, Kanban do projeto, Dev Console), `decisions` (Decisões: Das sessões; depois ADR e PDR), `machines` (Máquinas) ou `control` (Controle), nessa ordem. Dentro do bloco, o item sai na posição da entrada no registro; um bloco sem item não aparece. Uma tela fora da barra usa `highlights` para dizer qual item fica aceso (o Detalhe acende Sessões).

3. Um ícone novo entra em `ICONS` (`dom.js`), com nome em inglês, copiado do Lucide, com `currentColor`.

Item da barra só para tela que existe: nada de placeholder para as telas que não estão na versão.

## O CSS de uma tela

O que é de uma tela só fica num arquivo dela, `ui/<name>.css`, e não em `shell.css`. A tela o põe no `<head>` ao montar, marcado com `data-screen`, sem duplicar, e o tira quando a pessoa sai:

```js
function attachSheet() {
  const already = document.head.querySelector('link[data-screen="kanban"]');
  if (already) return already;
  const link = el('link', { rel: 'stylesheet', href: '/ui/kanban.css', 'data-screen': 'kanban' });
  document.head.append(link);
  return link;
}

const sheet = attachSheet();
ctx.signal.addEventListener('abort', () => sheet.remove());
```

A limpeza vai no `ctx.signal`, e não só na função que `mount` devolve, para valer mesmo quando a pessoa sai antes da primeira leitura voltar. O núcleo já serve `/ui/<nome>.css` e `/ui/screens/<nome>.js`, e as regras abaixo valem para eles também (`test/api/ui-kanban.test.ts` confere as do Kanban).

## Parâmetros na URL

Uma tela pode ler a query (`location.search`), como o Kanban lê `?view=`. A moldura a preserva ao navegar por `ctx.navigate` ou por link. Para trocar a query sem sair da tela, use `history.replaceState`: a tela continua montada e relê o que precisar.

## O parâmetro `?machine=` (issue 243)

Sessões, Mural ao vivo, Kanban (as duas visões), Feed, Histórico e Dashboard leem a rota da lista sempre com `machine` (`all` por padrão, `local` ou o id de uma remota de `/api/machines`), por `createMachineFilter(ctx, { onChange, reread, onLayout })` de `machine-filter.js`:

- **Na URL:** a escolha fica em `?machine=` (Todas não aparece), trocada por `history.replaceState` junto com os outros parâmetros da tela (`?status=`, `?view=`…), que continuam valendo. A última escolha também fica na memória da página, então um link entre as seis telas (a barra, "Ver em Sessões", o Voltar do Detalhe) abre na mesma máquina, e a tela a escreve na URL para o recarregar manter.
- **Sem remota** (`machines` só com `local`): nada aparece, nem filtro, nem rótulo, nem aviso. As telas ficam como antes.
- **Onde fica:** em Sessões, na barra de filtros, numa linha com as pílulas de status (em 1100 dobra em duas: máquina e status); nas outras, numa linha logo abaixo do cabeçalho (`parts()`).
- **Os números:** as pílulas de Sessões contam a máquina escolhida (o núcleo já conta). Com Todas, o subtítulo de Sessões e os cards Sessões e Agentes ativos do Dashboard dizem quanto é da remota, por `byMachine` ("· 3 na Workstation"). O "precisam de você" (`/api/attention`, que já junta as máquinas) é filtrado no cliente pela escolha.
- **O rótulo:** só no item remoto, com o ícone `server` e o nome; no card do Kanban e no "precisam de você" e na atividade recente do Dashboard, só o ícone, com o nome em `title` e `aria-label`. No Mural divide a linha do projeto (o projeto encurta); no Feed abre o caminho (Workstation › projeto › sessão › agente); o card de agente do Kanban não leva rótulo.
- **Remota sem conexão (C48):** o núcleo tira os itens dela; a tela mostra o aviso neutro "<nome> sem conexão desde HH:MM (há N min). As sessões de lá voltam quando ela responder." com "Ver a <nome>" para `/ui/machines/<id>`, e o segmento dela fica cinza com `wifi-off`. Com ela escolhida, a lista fica vazia com o mesmo aviso. Nunca a faixa vermelha.
- **Ao vivo:** `/api/changes` só conta o que muda nesta máquina, então, enquanto há remota, a tela relê a cada 30 s e logo depois de um `alert` ou de um `<id>:machine-unreachable`; os timers param no `ctx.signal`.
- **As chaves:** ids de sessão e de evento se repetem entre máquinas, então mapas, conjuntos, dedup, linha aberta e `data-key` usam `máquina:id`. O Feed insere os eventos por `createdAt` (a página mais antiga com várias máquinas e a máquina que volta no ao vivo não vêm em ordem global).
- **Escolha que o núcleo não conhece** (400 `machine: …`, a remota saiu do `machines.json`): a tela volta para Todas.

**O Detalhe de uma sessão remota (C49):** `/ui/sessions/<id>?machine=<id>`. O cabeçalho e todas as abas leem com `?machine=<id>` (`remoteDetailContext` em `screens/session-detail.js`). O cabeçalho ganha o chip da máquina e a linha "Lida do núcleo da <nome>, pelo túnel · há N s". O "Abrir…" é o caso "outra máquina" do C70 (desligado), a caixa "Mandar mensagem" fica desligada com o motivo, e Confirmar, Descartar e "Promover a registro" das Decisões ficam desligados: são escritas deste núcleo. Nenhuma escrita sai para uma sessão remota. Com a remota fora do ar (503 `machine-unreachable`), o Detalhe guarda o que já mostrava e põe o aviso neutro no topo; sem nada lido ainda, o aviso é o estado. Uma sessão local mantém as URLs de antes.

## O `ctx` da tela

| Campo | O quê |
| --- | --- |
| `params` | Os `:parametros` da rota (`{ id }` no Detalhe), já validados |
| `read(route)` | A camada de leitura, já com o `signal` da tela: sair da tela cancela o pedido |
| `write(route, body)` | A camada de escrita (POST com JSON, ou DELETE com `{ method: 'DELETE' }`), com o mesmo `signal`. Só para tela que muda algo (o Kanban do projeto move cards; a Agent Config grava um `SKILL.md` em `POST /api/agent-config/skill`) |
| `signal` | O `AbortSignal` que dispara quando a pessoa sai da tela |
| `onChange(f)` | `f(changes)` a cada novidade do long polling (`{ type, key, sessionId, accountId, seq }`) |
| `onRestart(f)` | `f()` quando a tela tem de reler tudo: núcleo reiniciado, cursor velho ou a conexão voltou |
| `liveState()` | `'connecting'`, `'live'` ou `'offline'` |
| `counter(id, n)` | O número no item da barra (o "4" do Dashboard); `0` esconde |
| `title(text)` | O título da janela (`Ahrena Console · <text>`) |
| `navigate(route)` | Troca de tela sem recarregar; a rota pode levar query (`/ui/agent-config?tab=skills`). Links `<a href="/ui/...">` já fazem isso sozinhos, com a query |

## Regras

- **Só 127.0.0.1.** A política de conteúdo do núcleo (`src/api/ui.ts`) bloqueia scripts, estilos, fontes e `fetch` de fora. Por isso a fonte é a do sistema quando a Poppins não está instalada.
- **Toda leitura passa por `read()`, toda escrita por `write()`**, nunca por `fetch` direto: é o que deixa a mesma página rodar no artefato.
- **As escritas com o `Origin` da página**: o abrir a sessão onde ela roda (`POST /api/sessions/<uuid>/open`, com o caminho exato), o mover card do Kanban do projeto, o `POST /api/agent-config/skill` da Agent Config e, da issue 241, as quatro da conexão com o GitHub (`/api/connections/github/…`) e a escolha do Project (`POST /api/project/selection`), estas só da própria `/ui`.
- **Texto do núcleo entra por `textContent`** (`el()` já faz isso). Nada de `innerHTML` com dado.
- **Sem cor escrita à mão:** só variáveis de `brand.css`. O teste (`test/api/ui.test.ts`) recusa hex, `rgb()` e endereço externo.
- **Sem estilo inline** (`style="..."`): a política de conteúdo bloqueia. Use classe. Largura que vem de dado (uma barra de progresso) sai de `<progress value max>` estilizado, como no Mural.
- **Classe com o prefixo da tela** (`dec-*` nas Decisões): o CSS de cada tela fica carregado quando se troca de tela, e uma classe repetida em dois arquivos desmonta a outra. Compartilhadas, só as da moldura e os selos (`.badge`, `.b-*`, `.reason`, `.soft`, `.p`).
- **Nada rola na horizontal** em 1100 nem em 1440 de janela: `min-width: 0` nos filhos de flex e grid, `overflow-wrap: anywhere` em título, branch, caminho e mono, `pre` com `white-space: pre-wrap`, sem `overflow-x: auto`.
- **Cards na mesma linha têm a mesma altura** ([#255](https://github.com/ahrenatechnology/ahrena-console/issues/255)). O `shell.css` estica todo `.card` da tela até a altura da linha do grid (`:where(.cc-main) .card { align-self: stretch }`), mesmo num grid com `align-items: start`; o conteúdo fica em cima, e um card que é coluna flex pode dar a sobra a uma parte (o gráfico das máquinas cresce) ou mandar o rodapé para baixo com `margin-top: auto`. Quando um card é muito mais curto que o vizinho (um card pequeno ao lado de uma tabela longa), os curtos empilham num `.card-column` ao lado do longo, na ordem do wireframe, e o último cresce até o fim da linha; a tabela longa vai para uma linha só dela. Fora da regra: as raias de quadro (Kanban, Kanban do projeto, Dev Console) e os itens de uma lista. O teste (`test/api/ui.test.ts`) recusa um CSS de tela que tire um card da altura da linha.
- Exceção: nos Repositórios, a largura das barras que vem de dado entra por variável CSS via CSSOM (`el.style.setProperty('--w', …)`), nunca por atributo `style` no HTML.

## As URLs antigas

As URLs da /ui eram em pt-BR até a decisão 0009 (issue 173) e ficaram abrindo como alias até a fase 6. Agora uma URL antiga (`/ui/sessoes/<id>`, `/ui/telas/<arquivo>`) é uma URL desconhecida: a moldura mostra "Página não encontrada", e um arquivo antigo dá 404.
