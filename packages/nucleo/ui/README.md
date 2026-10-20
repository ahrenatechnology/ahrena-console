# Interface do console (`/ui`)

A moldura do console ([#26](https://github.com/ahrenatechnology/ahrena-console/issues/26)), que o núcleo serve em `http://127.0.0.1:<porta>/ui`. É a janela do app desktop ([0005](../../../docs/decisoes/0005-app-desktop.md)) e, depois, o artefato. Página estática: sem build, sem dependências, módulos ES servidos como estão.

| Arquivo | O quê |
| --- | --- |
| `index.html` | A página: barra lateral, logo, "Ao vivo" e porta. Toda rota `/ui/...` devolve esta página |
| `app.js` | A moldura: monta a barra, roteia no cliente, liga o "Ao vivo" e abre a tela da rota |
| `telas.js` | **O registro das telas** (rota, item da barra, arquivo) |
| `ler.js` | A camada de leitura, `ler(rota)`, e de escrita: `escrever(rota, corpo)` (POST JSON na `/api/`) e `abrirNoDesktop(local)`. Por HTTP na janela; o artefato troca o transporte com `usarLeitor()`, `usarEscritor()` e `usarAbridor()` |
| `ao-vivo.js` | Long polling em `GET /api/mudancas?desde=<cursor>&espera=25` |
| `estados.js` | Os três estados de toda tela (C19): `carregando`, `vazio`, `erro`, e a `faixaDeErro` |
| `dom.js` | `el()`, `icone()` e `cabecalho()` |
| `moldura.css` | O estilo. Toda cor é variável da marca |
| `marca.css` | Gerado por `packages/marca` (não edite) |
| `dashboard.css` | O estilo do Dashboard; a tela carrega o próprio arquivo, para não disputar `moldura.css` |
| `mural.css` | O estilo do Mural ao vivo; a tela carrega o próprio arquivo (classes `mural-`), para não disputar `moldura.css` |
| `sessoes.css` | O estilo da tela Sessões, que a própria tela carrega: o estilo de uma tela fica num arquivo dela, fora do `moldura.css` |
| `telas/` | As telas, uma por arquivo. `dashboard.js` (C1, #27) lê `GET /api/dashboard` e `GET /api/atencao`; `mural.js` (C2, #34) lê `GET /api/mural`, com o filtro Todas/Esperando/Ativas no cliente; `sessoes.js` (C3, #28) lê `GET /api/sessoes`; `repos.js` (C22) lê `GET /api/repos`; `repo.js` (C23) lê `GET /api/repos/<dono>/<repo>?periodo=`. O CSS de uma tela fica ao lado dela (`telas/detalhe.css`) ou em `ui/` (`dashboard.css`, `mural.css`, `sessoes.css`, `repos.css`), carregado pela própria tela |
| `telas/detalhe.js` | O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes, Conversa e Linha do tempo, sobre `GET /api/sessoes/<id>…` (`src/api/detalhe.ts`). Uma aba nova é uma linha no registro `ABAS` e um módulo `telas/detalhe-<aba>.js` que exporta `criar(ctx, base, { cabeca, rotular })` (o contrato está no começo do `ABAS`) |
| `analytics.css` | O estilo da tela Analytics, carregado por `<link>` pela própria tela |
| `repos.css` | O estilo das telas Repositórios e Repositório (classes `repo-`), carregado por `<link>` pela própria tela |
| `repos-formato.js` | Formatos, filtros, escalas e o que as telas de repositórios mostram, sem DOM (o teste importa direto) |

## As telas

| Tela | Rota | Lê | Arquivo |
| --- | --- | --- | --- |
| Analytics · Visão geral (C12) | `/ui/analytics` | `GET /api/analytics?fuso=` | `telas/analytics.js` |
| Analytics · Custo (C13) | `/ui/analytics/custo` | `GET /api/analytics/custo?dias=7\|30\|90&fuso=` | `telas/analytics.js` |
| Repositórios (C22) | `/ui/repos` | `GET /api/repos` | `telas/repos.js` |
| Repositório (C23) | `/ui/repos/:dono/:repo` | `GET /api/repos/<dono>/<repo>?periodo=30d\|90d\|1a` | `telas/repo.js` |

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
- **A única escrita é o "Abrir no Claude Desktop"** (`abrirNoDesktop()` de `ler.js`): `POST /abrir/<local_…>`, o único POST que o núcleo aceita com o `Origin` da página.
- **Texto do núcleo entra por `textContent`** (`el()` já faz isso). Nada de `innerHTML` com dado.
- **Sem cor escrita à mão:** só variáveis de `marca.css`. O teste (`test/api/ui.test.ts`) recusa hex, `rgb()` e endereço externo.
- **Sem estilo inline** (`style="..."`): a política de conteúdo bloqueia. Use classe. Largura que vem de dado (uma barra de progresso) sai de `<progress value max>` estilizado, como no Mural.
- Exceção: nos Repositórios, a largura das barras que vem de dado entra por variável CSS via CSSOM (`el.style.setProperty('--w', …)`), nunca por atributo `style` no HTML.
