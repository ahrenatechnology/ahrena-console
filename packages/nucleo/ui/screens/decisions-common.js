// O que a página Decisões (C21) e a aba Decisões do Detalhe (C20) têm em comum (issue 103): o card de uma
// decisão, as pílulas, o "há X min", o Confirmar e o Descartar, o alternador e o diálogo do
// "Promover a registro".
//
// Tudo o que vem do núcleo é conteúdo não confiável: entra por `textContent` (`el()`), nunca como HTML.
// As escritas passam por `escrever()` (api.js); nada aqui chama `fetch`.

import { el, icon } from '../dom.js';
import { write } from '../api.js';

// ---------- Estilo ----------

let cssCarregado = false;
/** As duas telas usam o mesmo `ui/decisions.css` (na raiz, como o das outras telas); a primeira que abrir o põe no `<head>`. */
export function carregarCssDasDecisoes() {
  if (cssCarregado || typeof document === 'undefined' || document.querySelector('link[data-screen="decisions"]')) return;
  cssCarregado = true;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/decisions.css', 'data-screen': 'decisions' }));
}

// ---------- Rótulos (funções puras) ----------

const TIPOS = {
  sugerida: { rotulo: 'Sugerida', icone: 'suggested' },
  correcao: { rotulo: 'Correção sua', icone: 'continued' },
  permissao: { rotulo: 'Permissão', icone: 'permission' },
  pergunta: { rotulo: 'Pergunta', icone: 'question' },
  plano: { rotulo: 'Plano', icone: 'plan' },
};

/** A pílula de tipo: "Sugerida", "Correção sua", "Permissão", "Pergunta", "Plano". */
export const rotuloDoTipo = (origem) => TIPOS[origem]?.rotulo ?? 'Decisão';
export const iconeDoTipo = (origem) => TIPOS[origem]?.icone ?? 'decision';

/** Quem decidiu, como o card escreve. */
export function quemDecidiu(d) {
  if (d.origem === 'sugerida') return 'agente propôs';
  if (d.origem === 'correcao') return 'você corrigiu';
  if (d.origem === 'plano') return 'você aprovou';
  return d.decididaPor === 'agente' ? 'agente' : 'você';
}

const ESTADOS = { vigente: 'Vigente', a_confirmar: 'A confirmar', substituida: 'Substituída', descartada: 'Descartada' };
export const rotuloDoEstado = (estado) => ESTADOS[estado] ?? estado;

const ESCOPOS = { sessao: 'sessão', familia: 'família', branch: 'branch' };
const DE_ONDE = { mae: 'da sessão mãe', familia: 'de outra sessão da família', branch: 'de outra sessão do branch' };

/** "escopo: família · da sessão mãe". A origem só aparece quando a decisão não é desta sessão. */
export function rotuloDoEscopo(d) {
  const de = DE_ONDE[d.sessao];
  return `escopo: ${ESCOPOS[d.escopo] ?? d.escopo}${de ? ` · ${de}` : ''}`;
}

/** "agora", "há 14 min", "há 3 h", "ontem", "há 4 d". */
export function haQuanto(iso, agora = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.floor((agora - t) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  if (h < 48) return 'ontem';
  return `há ${Math.floor(h / 24)} d`;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACOES = new Set(['confirmar', 'descartar', 'promover']);
/** The action of the screen → the segment of the English route. */
const SEGMENTO = { confirmar: 'confirm', descartar: 'dismiss', promover: 'promote' };
/** Scope and grouping values of the screen → the English values of the API. */
export const VALOR_DA_API = { sessao: 'session', familia: 'family', branch: 'branch' };

/** O pedido de uma escrita: a rota e o corpo JSON. Id ou ação estranhos são recusados aqui. */
export function pedidoDaAcao(id, acao, corpo) {
  if (!ID.test(String(id))) throw new Error(`id de decisão inválido: ${id}`);
  if (!ACOES.has(acao)) throw new Error(`ação desconhecida: ${acao}`);
  if (typeof corpo?.sessao !== 'string' || !ID.test(corpo.sessao)) throw new Error('a escrita precisa da sessão');
  return { rota: `/api/decisions/${id}/${SEGMENTO[acao]}`, corpo };
}

/**
 * O rascunho (`{ sessao }`) e a gravação (`{ sessao, confirmar: true, caminho, hash }`) do Promover.
 * O `hash` é o do rascunho que a pessoa leu: se o registro mudou desde então, a API recusa (409).
 */
export function pedidoDePromover(id, sessao, gravar = null) {
  if (!gravar) return pedidoDaAcao(id, 'promover', { sessao });
  return pedidoDaAcao(id, 'promover', { sessao, confirmar: true, caminho: gravar.caminho, ...(gravar.hash ? { hash: gravar.hash } : {}) });
}

/** O "Ver na conversa" só vira link quando é uma rota da própria interface. */
export const linkDaConversa = (d) => (typeof d.conversa === 'string' && /^\/ui\/sessions\/[A-Za-z0-9_.:%-]{1,200}$/.test(d.conversa) ? d.conversa : null);

// ---------- Peças ----------

// The class of each decision state (the API value stays as it comes): `dec-e-<state>`.
const STATE_CLASS = { a_confirmar: 'to-confirm', vigente: 'current', descartada: 'dismissed', substituida: 'superseded' };
export const stateClass = (estado) => `dec-e-${STATE_CLASS[estado] ?? estado}`;

export function pilulaDeEstado(estado) {
  return el('span', { class: `dec-pill ${stateClass(estado)}` }, rotuloDoEstado(estado));
}

/** Alternador em segmentos (Sessão/Família/Branch, Todas/Vigentes/A confirmar). */
export function alternador({ rotulo, opcoes, atual, aoTrocar }) {
  const grupo = el('div', { class: 'dec-seg', role: 'group', 'aria-label': rotulo });
  const desenhar = (valor) => {
    grupo.replaceChildren(
      ...opcoes.map(([v, r]) =>
        el('button', { type: 'button', class: v === valor ? 'dec-on' : null, 'aria-pressed': v === valor ? 'true' : 'false', onClick: () => v !== valor && (desenhar(v), aoTrocar(v)) }, r),
      ),
    );
  };
  desenhar(atual);
  return grupo;
}

/** O campo de busca, com espera: só chama `aoBuscar` quando a pessoa para de digitar. */
export function campoDeBusca({ placeholder, aoBuscar, espera = 250 }) {
  const campo = el('input', { type: 'search', placeholder, 'aria-label': 'Buscar nas decisões', maxlength: '200', autocomplete: 'off' });
  let t = null;
  campo.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => aoBuscar(campo.value.trim()), espera);
  });
  return el('label', { class: 'dec-search' }, icon('search'), campo);
}

/**
 * O card de uma decisão. `sessao` é a sessão em nome de quem a escrita vai (na página, a dona da
 * decisão; na aba, a sessão aberta). `aoMudar()` é chamado depois de uma escrita que deu certo.
 */
export function cartaoDeDecisao(d, { sessao = d.sessionId, aoMudar = () => {}, agora = Date.now() } = {}) {
  const aviso = el('span', { class: 'dec-notice', role: 'status' });
  const rastro = [
    d.nao?.length ? `Descartado: ${d.nao.join('; ')}` : null,
    d.substituidaPor ? ['substituída por ', el('b', {}, d.substituidaPor)] : d.substitui ? ['substitui ', el('b', {}, d.substitui)] : null,
  ].filter(Boolean);

  const acoes = el('div', { class: 'dec-actions' });
  if (d.estado === 'a_confirmar') {
    const confirmar = el('button', { type: 'button', class: 'btn filled' }, 'Confirmar');
    const descartar = el('button', { type: 'button', class: 'btn outline' }, 'Descartar');
    const agir = (acao) => async () => {
      confirmar.disabled = descartar.disabled = true;
      aviso.textContent = '';
      try {
        const { rota, corpo } = pedidoDaAcao(d.id, acao, { sessao });
        await write(rota, corpo);
        aoMudar();
      } catch (e) {
        aviso.textContent = e.message;
        confirmar.disabled = descartar.disabled = false;
      }
    };
    confirmar.addEventListener('click', agir('confirmar'));
    descartar.addEventListener('click', agir('descartar'));
    acoes.append(confirmar, descartar);
  } else {
    const conversa = linkDaConversa(d);
    if (conversa) acoes.append(el('a', { class: 'dec-link', href: conversa }, 'Ver na conversa'));
    if (d.estado === 'vigente') {
      if (d.promovidaPara) acoes.append(el('span', { class: 'dec-promoted mono', title: d.promovidaPara }, icon('promote'), 'Promovida'));
      else acoes.append(el('button', { type: 'button', class: 'dec-link', onClick: () => abrirPromover(d, sessao, { aoGravar: aoMudar }) }, 'Promover a registro'));
    }
  }

  return el(
    'article',
    { class: `card dec-card ${stateClass(d.estado)}`, 'data-decision': d.id },
    el('span', { class: 'dec-ico' }, icon(iconeDoTipo(d.origem))),
    el('div', { class: 'dec-l1' }, el('span', { class: 'mono dec-label' }, d.rotulo), el('b', { class: 'dec-title', title: d.titulo }, d.titulo), pilulaDeEstado(d.estado)),
    el('time', { class: 'dec-when', datetime: d.decididaEm, title: new Date(d.decididaEm).toLocaleString('pt-BR') }, haQuanto(d.decididaEm, agora)),
    el('div', { class: 'dec-l2' }, ...rastro.flatMap((r, i) => (i ? [' · ', r] : [r]))),
    el('div', { class: 'dec-l3' }, el('span', { class: 'dec-type' }, rotuloDoTipo(d.origem)), el('span', {}, quemDecidiu(d)), el('span', {}, rotuloDoEscopo(d)), aviso),
    acoes,
  );
}

// ---------- Promover a registro ----------

/**
 * O rascunho do registro: lê `POST …/promover { sessao }` (nada é gravado), mostra o markdown e o
 * caminho, e só grava com a confirmação explícita (a caixa "Confirmo" e o botão).
 */
export function abrirPromover(d, sessao, { aoGravar = () => {} } = {}) {
  const corpo = el('div', { class: 'dec-dlg-body' }, el('p', { class: 'dec-dlg-note' }, 'Gerando o rascunho…'));
  const fechar = el('button', { type: 'button', class: 'btn outline', value: 'fechar' }, 'Fechar');
  const dialogo = el(
    'dialog',
    { class: 'dec-dlg', 'aria-label': `Promover ${d.rotulo} a registro` },
    el('header', {}, icon('promote'), el('h2', {}, `Promover ${d.rotulo} a registro de decisão`)),
    corpo,
    el('footer', {}, fechar),
  );
  fechar.addEventListener('click', () => dialogo.close());
  dialogo.addEventListener('close', () => dialogo.remove());
  document.body.append(dialogo);
  dialogo.showModal();

  (async () => {
    let rascunho;
    try {
      const { rota, corpo: pedido } = pedidoDePromover(d.id, sessao);
      rascunho = (await write(rota, pedido)).rascunho;
    } catch (e) {
      corpo.replaceChildren(el('p', { class: 'dec-error', role: 'alert' }, `Não deu para gerar o rascunho: ${e.message}`));
      return;
    }
    const aviso = el('p', { class: 'dec-dlg-note', role: 'status' });
    const copiar = el('button', { type: 'button', class: 'btn outline' }, icon('copy'), 'Copiar');
    copiar.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rascunho.markdown);
        aviso.textContent = 'Copiado.';
      } catch {
        aviso.textContent = 'Não deu para copiar.';
      }
    });
    const pode = !!rascunho.podeGravar;
    const confirmo = el('input', { type: 'checkbox', disabled: !pode });
    const gravar = el('button', { type: 'button', class: 'btn filled dec-save', disabled: true, title: pode ? null : rascunho.motivo ?? 'Não dá para gravar daqui' }, `Gravar em ${rascunho.caminho}`);
    confirmo.addEventListener('change', () => (gravar.disabled = !confirmo.checked));
    gravar.addEventListener('click', async () => {
      if (!confirmo.checked) return;
      gravar.disabled = confirmo.disabled = true;
      aviso.textContent = 'Gravando…';
      try {
        const { rota, corpo: pedido } = pedidoDePromover(d.id, sessao, { caminho: rascunho.caminho, hash: rascunho.hash });
        const r = await write(rota, pedido);
        aviso.textContent = `Gravado em ${r.caminho ?? rascunho.caminho}.`;
        gravar.hidden = true;
        aoGravar(r);
      } catch (e) {
        aviso.textContent = `Não gravou: ${e.message}`;
        confirmo.disabled = false;
        confirmo.checked = false;
      }
    });
    corpo.replaceChildren(
      el('div', { class: 'dec-dlg-path' }, el('span', { class: 'eyebrow' }, 'Rascunho'), el('span', { class: 'mono' }, rascunho.caminho), rascunho.repo ? el('span', { class: 'mono dec-repo' }, `em ${rascunho.repo}`) : null),
      el('pre', { class: 'mono dec-md' }, rascunho.markdown),
      el('div', { class: 'dec-dlg-actions' }, copiar),
      el(
        'div',
        { class: 'dec-dlg-save' },
        el('label', { class: pode ? null : 'dec-off' }, confirmo, el('span', {}, pode ? `Confirmo: gravar ${rascunho.caminho} no repositório.` : `Não dá para gravar: ${rascunho.motivo ?? 'sem motivo informado'}.`)),
        gravar,
      ),
      aviso,
    );
  })();
  return dialogo;
}
