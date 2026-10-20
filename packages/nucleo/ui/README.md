# Interface do console (`/ui`)

A moldura do console ([#26](https://github.com/ahrenatechnology/ahrena-console/issues/26)), que o núcleo serve em `http://127.0.0.1:<porta>/ui`. É a janela do app desktop ([0005](../../../docs/decisoes/0005-app-desktop.md)) e, depois, o artefato. Página estática: sem build, sem dependências, módulos ES servidos como estão.

| Arquivo | O quê |
| --- | --- |
| `index.html` | A página: barra lateral, logo, "Ao vivo" e porta. Toda rota `/ui/...` devolve esta página |
| `app.js` | A moldura: monta a barra, roteia no cliente, liga o "Ao vivo" e abre a tela da rota |
| `telas.js` | **O registro das telas** (rota, item da barra, arquivo) |
| `ler.js` | A camada de leitura, `ler(rota)`, e de escrita: `escrever(rota, corpo)` (POST JSON na `/api/`) e `abrirNoDesktop(local)`. Por HTTP na janela; o artefato troca o transporte com `usarLeitor()`, `usarEscritor()` e `usarAbridor()` |
| `ao-vivo.js` | Long polling em `GET /api/changes?since=<cursor>&wait=25` |
| `estados.js` | Os três estados de toda tela (C19): `carregando`, `vazio`, `erro`, e a `faixaDeErro` |
| `dom.js` | `el()`, `icone()` e `cabecalho()` |
| `moldura.css` | O estilo. Toda cor é variável da marca |
| `marca.css` | Gerado por `packages/marca` (não edite) |
| `dashboard.css` | O estilo do Dashboard; a tela carrega o próprio arquivo, para não disputar `moldura.css` |
| `mural.css` | O estilo do Mural ao vivo; a tela carrega o próprio arquivo (classes `mural-`), para não disputar `moldura.css` |
| `sessoes.css` | O estilo da tela Sessões, que a própria tela carrega: o estilo de uma tela fica num arquivo dela, fora do `moldura.css` |
| `telas/` | As telas, uma por arquivo. `dashboard.js` (C1, #27) lê `GET /api/dashboard` e `GET /api/attention`; `mural.js` (C2, #34) lê `GET /api/wall`, com o filtro Todas/Esperando/Ativas no cliente; `sessoes.js` (C3, #28) lê `GET /api/sessions`; `historico.js` (C15, #33) lê `GET /api/history`. O CSS de uma tela fica ao lado dela (`telas/detalhe.css`) ou em `ui/` (`dashboard.css`, `mural.css`, `sessoes.css`, `historico.css`), carregado pela própria tela |
| `telas/detalhe.js` | O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes, Conversa e Linha do tempo, sobre `GET /api/sessions/<id>…` (`src/api/detalhe.ts`). Uma aba nova é uma linha no registro `ABAS` e um módulo `telas/detalhe-<aba>.js` que exporta `criar(ctx, base, { cabeca, rotular })` (o contrato está no começo do `ABAS`) |
| `telas/kanban.js` | O Kanban ([#31](https://github.com/ahrenatechnology/ahrena-console/issues/31)): sessões ou agentes em colunas por status, só leitura, em `/ui/kanban` (`?visao=agentes` para os agentes) |
| `kanban.css` | O estilo do Kanban, carregado pela tela só enquanto ela está aberta |
| `analytics.css` | O estilo da tela Analytics, carregado por `<link>` pela própria tela |

## As telas

| Tela | Rota | Lê | Arquivo |
| --- | --- | --- | --- |
| Analytics · Visão geral (C12) | `/ui/analytics` | `GET /api/analytics?tz=` | `telas/analytics.js` |
| Analytics · Custo (C13) | `/ui/analytics/custo` | `GET /api/analytics/cost?days=7\|30\|90&tz=` | `telas/analytics.js` |

O Analytics tem duas abas, que são a mesma tela: em `telas.js`, a entrada `analytics` (item da barra) e a `analytics-aba` (`/ui/analytics/:aba`, acende Analytics). A tela lê `ctx.params.aba`: só `custo` é aba; outra coisa mostra "Aba não encontrada". As abas são `<a href>`, então trocar de aba não recarrega a página. O fuso vai sempre o do navegador. O uso da tela está em [docs/analytics.md](../../../docs/analytics.md).

## Registrar uma tela

1. Crie `ui/telas/<nome>.js` exportando `montar(area, ctx)`:

   ```js
   import { cabecalho } from '../dom.js';
   import { carregando, vazio, erro } from '../estados.js';

   export async function montar(area, ctx) {
     const cab = cabecalho({ icone: 'sessoes', titulo: 'Sessões', sub: '…' });
     area.replaceChildren(cab, carregando());
     async function desenhar() {
       try {
         const dados = await ctx.ler('/api/...');
         area.replaceChildren(cab, dados.length ? lista(dados) : vazio({ titulo: 'Nenhuma sessão ainda', texto: '…' }));
       } catch (e) {
         if (e.name === 'AbortError') return;
         area.replaceChildren(cab, erro({ texto: e.message, tentar: desenhar }));
       }
     }
     ctx.aoReiniciar(desenhar);
     ctx.aoMudar((mudancas) => { /* relê o que mudou */ });
     await desenhar();
     return () => { /* limpeza ao sair da tela, se precisar */ };
   }
   ```

2. Em `telas.js`, aponte o `arquivo` da entrada: `arquivo: '/ui/telas/<nome>.js'`. Uma tela nova ganha uma entrada com `rota`, `titulo`, `icone` e, se aparece na barra, `item: { rotulo, icone }`. Uma tela fora da barra usa `acende` para dizer qual item fica aceso (o Detalhe acende Sessões).

3. Um ícone novo entra em `ICONES` (`dom.js`), copiado do Lucide, com `currentColor`.

Item da barra só para tela que existe: nada de placeholder para as telas que não estão na versão.

## O CSS de uma tela

O que é de uma tela só fica num arquivo dela, `ui/<nome>.css`, e não em `moldura.css`. A tela o põe no `<head>` ao montar, marcado com `data-tela`, sem duplicar, e o tira quando a pessoa sai:

```js
function ligarFolha() {
  const ja = document.head.querySelector('link[data-tela="kanban"]');
  if (ja) return ja;
  const link = el('link', { rel: 'stylesheet', href: '/ui/kanban.css', 'data-tela': 'kanban' });
  document.head.append(link);
  return link;
}

const folha = ligarFolha();
ctx.sinal.addEventListener('abort', () => folha.remove());
```

A limpeza vai no `ctx.sinal`, e não só na função que `montar` devolve, para valer mesmo quando a pessoa sai antes da primeira leitura voltar. O núcleo já serve `/ui/<nome>.css` e `/ui/telas/<nome>.js`, e as regras abaixo valem para eles também (`test/api/ui-kanban.test.ts` confere as do Kanban).

## Parâmetros na URL

Uma tela pode ler a query (`location.search`), como o Kanban lê `?visao=`. A moldura a preserva ao navegar por `ctx.navegar` ou por link. Para trocar a query sem sair da tela, use `history.replaceState`: a tela continua montada e relê o que precisar.

## O `ctx` da tela

| Campo | O quê |
| --- | --- |
| `params` | Os `:parametros` da rota (`{ id }` no Detalhe), já validados |
| `ler(rota)` | A camada de leitura, já com o `signal` da tela: sair da tela cancela o pedido |
| `escrever(rota, corpo)` | A camada de escrita (POST com JSON), com o mesmo `signal`. Só para tela que muda algo (o Kanban do projeto move cards) |
| `sinal` | O `AbortSignal` que dispara quando a pessoa sai da tela |
| `aoMudar(f)` | `f(mudancas)` a cada novidade do long polling (`{ tipo, chave, sessionId, accountId }`) |
| `aoReiniciar(f)` | `f()` quando a tela tem de reler tudo: núcleo reiniciado, cursor velho ou a conexão voltou |
| `aoVivo()` | `'conectando'`, `'ao-vivo'` ou `'sem-conexao'` |
| `contador(id, n)` | O número no item da barra (o "4" do Dashboard); `0` esconde |
| `titulo(texto)` | O título da janela (`Ahrena Console · <texto>`) |
| `navegar(rota)` | Troca de tela sem recarregar. Links `<a href="/ui/...">` já fazem isso sozinhos |

## Regras

- **Só 127.0.0.1.** A política de conteúdo do núcleo (`src/api/ui.ts`) bloqueia scripts, estilos, fontes e `fetch` de fora. Por isso a fonte é a do sistema quando a Poppins não está instalada.
- **Toda leitura passa por `ler()`**, nunca por `fetch` direto: é o que deixa a mesma página rodar no artefato.
- **A única escrita é o "Abrir no Claude Desktop"** (`abrirNoDesktop()` de `ler.js`): `POST /open/<local_…>`, o único POST que o núcleo aceita com o `Origin` da página.
- **Texto do núcleo entra por `textContent`** (`el()` já faz isso). Nada de `innerHTML` com dado.
- **Sem cor escrita à mão:** só variáveis de `marca.css`. O teste (`test/api/ui.test.ts`) recusa hex, `rgb()` e endereço externo.
- **Sem estilo inline** (`style="..."`): a política de conteúdo bloqueia. Use classe. Largura que vem de dado (uma barra de progresso) sai de `<progress value max>` estilizado, como no Mural.
