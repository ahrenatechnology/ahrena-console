# Interface do console (`/ui`)

A moldura do console ([#26](https://github.com/ahrenatechnology/ahrena-console/issues/26)), que o núcleo serve em `http://127.0.0.1:<porta>/ui`. É a janela do app desktop ([0005](../../../docs/decisoes/0005-app-desktop.md)) e, depois, o artefato. Página estática: sem build, sem dependências, módulos ES servidos como estão.

| Arquivo | O quê |
| --- | --- |
| `index.html` | A página: barra lateral, logo, "Ao vivo" e porta. Toda rota `/ui/...` devolve esta página |
| `app.js` | A moldura: monta a barra, roteia no cliente, liga o "Ao vivo" e abre a tela da rota |
| `telas.js` | **O registro das telas** (rota, item da barra, arquivo) |
| `ler.js` | A camada de leitura: `ler(rota)`. Por HTTP na janela; o artefato troca o transporte com `usarLeitor()`. E as escritas das Decisões, `escrever(rota, corpo)` (`usarEscritor()`) |
| `ao-vivo.js` | Long polling em `GET /api/mudancas?desde=<cursor>&espera=25` |
| `estados.js` | Os três estados de toda tela (C19): `carregando`, `vazio`, `erro`, e a `faixaDeErro` |
| `dom.js` | `el()`, `icone()` e `cabecalho()` |
| `moldura.css` | O estilo. Toda cor é variável da marca |
| `marca.css` | Gerado por `packages/marca` (não edite) |
| `decisoes.css` | O estilo das Decisões (C20 e C21). Toda classe é `dec-*`; `decisoes-comum.js` põe o `<link>` no `<head>` ao montar |
| `telas/` | As telas, uma por arquivo. O CSS das Decisões fica em `ui/decisoes.css`, na raiz |

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
- **Texto do núcleo entra por `textContent`** (`el()` já faz isso). Nada de `innerHTML` com dado.
- **Sem cor escrita à mão:** só variáveis de `marca.css`. O teste (`test/api/ui.test.ts`) recusa hex, `rgb()` e endereço externo.
- **Sem estilo inline** (`style="..."`): a política de conteúdo bloqueia. Use classe.
- **Classe com o prefixo da tela** (`dec-*` nas Decisões): o CSS de cada tela fica carregado quando se troca de tela, e uma classe repetida em dois arquivos desmonta a outra. Compartilhadas, só as da moldura e os selos (`.badge`, `.b-*`, `.mot`, `.leve`, `.p`).
- **Nada rola na horizontal** em 1100 nem em 1440 de janela: `min-width: 0` nos filhos de flex e grid, `overflow-wrap: anywhere` em título, branch, caminho e mono, `pre` com `white-space: pre-wrap`, sem `overflow-x: auto`.
