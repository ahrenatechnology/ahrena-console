# Interface do console (`/ui`)

A moldura do console ([#26](https://github.com/ahrenatechnology/ahrena-console/issues/26)), que o núcleo serve em `http://127.0.0.1:<porta>/ui`. É a janela do app desktop ([0005](../../../docs/decisoes/0005-app-desktop.md)) e, depois, o artefato. Página estática: sem build, sem dependências, módulos ES servidos como estão.

| Arquivo | O quê |
| --- | --- |
| `index.html` | A página: barra lateral, logo, "Ao vivo" e porta. Toda rota `/ui/...` devolve esta página |
| `app.js` | A moldura: monta a barra, roteia no cliente, liga o "Ao vivo" e abre a tela da rota |
| `screens.js` | **O registro das telas** (`route`, `item`, `file`) e a troca das URLs antigas pelas novas (`legacyUrl`) |
| `api.js` | A camada de leitura, `read(route)`, e de escrita: `write(route, body)` (POST JSON na `/api/`) e `openInDesktop(local)`. Por HTTP na janela; o artefato troca o transporte com `useReader()`, `useWriter()` e `useOpener()` |
| `live.js` | Long polling em `GET /api/changes?since=<cursor>&wait=25` |
| `states.js` | Os três estados de toda tela (C19): `loading`, `empty`, `error`, e a `errorBand` |
| `dom.js` | `el()`, `icon()` e `header()` |
| `shell.css` | O estilo da moldura. Toda cor é variável da marca |
| `brand.css` | Gerado por `packages/marca` (não edite) |
| `dashboard.css` | O estilo do Dashboard; a tela carrega o próprio arquivo, para não disputar `shell.css` |
| `wall.css` | O estilo do Mural ao vivo; a tela carrega o próprio arquivo (classes `wall-`), para não disputar `shell.css` |
| `sessions.css` | O estilo da tela Sessões, que a própria tela carrega: o estilo de uma tela fica num arquivo dela, fora do `shell.css` |
| `screens/` | As telas, uma por arquivo. `agent-config.js` é a Agent Config (C16 e C17, #63). `dashboard.js` (C1, #27) lê `GET /api/dashboard` e `GET /api/attention`; `wall.js` (C2, #34) lê `GET /api/wall`, com o filtro Todas/Esperando/Ativas no cliente; `sessions.js` (C3, #28) lê `GET /api/sessions`; `history.js` (C15, #33) lê `GET /api/history`; `repos.js` (C22) lê `GET /api/repos`; `repo.js` (C23) lê `GET /api/repos/<dono>/<repo>?period=`. O CSS de uma tela fica ao lado dela (`screens/session-detail.css`) ou em `ui/` (`dashboard.css`, `wall.css`, `sessions.css`, `history.css`, `repos.css`), carregado pela própria tela |
| `screens/session-detail.js` | O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes, Conversa e Linha do tempo, sobre `GET /api/sessions/<id>…` (`src/api/detalhe.ts`). Uma aba nova é uma linha no registro `TABS_LIST` e um módulo `screens/session-detail-<tab>.js` que exporta `create(ctx, base, { head, setLabel })` (o contrato está no começo do `TABS_LIST`) |
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

2. Em `screens.js`, aponte o `file` da entrada: `file: '/ui/screens/<name>.js'`. Uma tela nova ganha uma entrada com `id`, `route`, `title`, `icon` e, se aparece na barra, `item: { label, icon, section }`. Id, rota, nome de arquivo e classes em inglês (decisão 0009); o texto da tela em pt-BR. `section` é o bloco da barra, um id de `SECTIONS` em `screens.js`: `main` (as telas do dia a dia, sem título), `machines` (Máquinas) ou `control` (Controle), na ordem do C24. Dentro do bloco, o item sai na posição da entrada no registro; um bloco sem item não aparece. Uma tela fora da barra usa `highlights` para dizer qual item fica aceso (o Detalhe acende Sessões).

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

## O `ctx` da tela

| Campo | O quê |
| --- | --- |
| `params` | Os `:parametros` da rota (`{ id }` no Detalhe), já validados |
| `read(route)` | A camada de leitura, já com o `signal` da tela: sair da tela cancela o pedido |
| `write(route, body)` | A camada de escrita (POST com JSON), com o mesmo `signal`. Só para tela que muda algo (o Kanban do projeto move cards; a Agent Config grava um `SKILL.md` em `POST /api/agent-config/skill`) |
| `signal` | O `AbortSignal` que dispara quando a pessoa sai da tela |
| `onChange(f)` | `f(changes)` a cada novidade do long polling (`{ type, key, sessionId, accountId, seq }`) |
| `onRestart(f)` | `f()` quando a tela tem de reler tudo: núcleo reiniciado, cursor velho ou a conexão voltou |
| `liveState()` | `'connecting'`, `'live'` ou `'offline'` |
| `counter(id, n)` | O número no item da barra (o "4" do Dashboard); `0` esconde |
| `title(text)` | O título da janela (`Ahrena Console · <text>`) |
| `navigate(route)` | Troca de tela sem recarregar; a rota pode levar query (`/ui/agent-config?tab=skills`). Links `<a href="/ui/...">` já fazem isso sozinhos, com a query |

## Regras

- **Só 127.0.0.1.** A política de conteúdo do núcleo (`src/api/ui.ts`) bloqueia scripts, estilos, fontes e `fetch` de fora. Por isso a fonte é a do sistema quando a Poppins não está instalada.
- **Toda leitura passa por `read()`, toda escrita por `write()`** (ou `openInDesktop()`), nunca por `fetch` direto: é o que deixa a mesma página rodar no artefato.
- **As escritas com o `Origin` da página** são só três: o "Abrir no Claude Desktop" (`POST /open/<local_…>`), o mover card do Kanban do projeto e o `POST /api/agent-config/skill` da Agent Config.
- **Texto do núcleo entra por `textContent`** (`el()` já faz isso). Nada de `innerHTML` com dado.
- **Sem cor escrita à mão:** só variáveis de `brand.css`. O teste (`test/api/ui.test.ts`) recusa hex, `rgb()` e endereço externo.
- **Sem estilo inline** (`style="..."`): a política de conteúdo bloqueia. Use classe. Largura que vem de dado (uma barra de progresso) sai de `<progress value max>` estilizado, como no Mural.
- **Classe com o prefixo da tela** (`dec-*` nas Decisões): o CSS de cada tela fica carregado quando se troca de tela, e uma classe repetida em dois arquivos desmonta a outra. Compartilhadas, só as da moldura e os selos (`.badge`, `.b-*`, `.reason`, `.soft`, `.p`).
- **Nada rola na horizontal** em 1100 nem em 1440 de janela: `min-width: 0` nos filhos de flex e grid, `overflow-wrap: anywhere` em título, branch, caminho e mono, `pre` com `white-space: pre-wrap`, sem `overflow-x: auto`.
- Exceção: nos Repositórios, a largura das barras que vem de dado entra por variável CSS via CSSOM (`el.style.setProperty('--w', …)`), nunca por atributo `style` no HTML.

## As URLs antigas

As URLs da /ui eram em pt-BR até a decisão 0009 (issue 173). As antigas continuam abrindo: antes de rotear, a moldura troca a URL antiga pela nova com `history.replaceState` (`legacyUrl` em `screens.js`), e o núcleo serve `/ui/telas/<arquivo>` como `/ui/screens/<arquivo>`. Os alias saem no PR final da migração.

| Antiga | Nova |
| --- | --- |
| `/ui/sessoes`, `/ui/sessoes/<id>` | `/ui/sessions`, `/ui/sessions/<id>` |
| `/ui/sessoes?busca=&ordem=&sentido=&pagina=` | `/ui/sessions?search=&order=&direction=&page=` |
| `/ui/sessoes/<id>#agentes`, `#conversa`, `#tempo`, `#decisoes` | `/ui/sessions/<id>#agents`, `#conversation`, `#timeline`, `#decisions` |
| `/ui/historico` | `/ui/history` |
| `/ui/mural` | `/ui/wall` |
| `/ui/projeto` | `/ui/project` |
| `/ui/decisoes` | `/ui/decisions` |
| `/ui/analytics/custo` | `/ui/analytics/cost` |
| `/ui/kanban?visao=agentes` | `/ui/kanban?view=agents` |
| `/ui/repos/<dono>/<repo>?periodo=1a` | `/ui/repos/<owner>/<repo>?period=1y` |
| `/ui/telas/<arquivo>` | `/ui/screens/<arquivo>` |
