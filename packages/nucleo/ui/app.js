// A moldura do console (#26): barra lateral, roteamento no cliente, "Ao vivo" e a área da tela.
// As telas se registram em screens.js; o contrato de uma tela está no README.md.

import { escrever, ler } from './api.js';
import { iniciarAoVivo } from './live.js';
import { cabecalho, el, icone } from './dom.js';
import { erro, vazio } from './states.js';
import { findScreen, legacyUrl, sidebarSections } from './screens.js';

const nav = document.getElementById('nav');
const area = document.getElementById('conteudo');
const cartaoAoVivo = document.getElementById('ao-vivo');
const porta = document.getElementById('porta');

porta.textContent = location.host;

// ---------- Barra lateral ----------

// Um bloco por seção (C1, C24): as telas do dia a dia sem título, depois Máquinas e Controle.
const itens = new Map();
for (const section of sidebarSections()) {
  const titleId = section.label ? `cc-nav-title-${section.id}` : null;
  const group = el(
    'div',
    { class: 'cc-nav-section', 'data-section': section.id, role: titleId && 'group', 'aria-labelledby': titleId },
    titleId && el('div', { class: 'cc-nav-title olhinho', id: titleId }, section.label),
  );
  for (const tela of section.items) {
    const q = el('span', { class: 'q', hidden: true });
    const a = el('a', { class: 'cc-nav', href: tela.route, 'data-tela': tela.id }, icone(tela.item.icon), el('span', {}, tela.item.label), q);
    itens.set(tela.id, { a, q });
    group.append(a);
  }
  nav.append(group);
}

function acender(id) {
  for (const [k, { a }] of itens) {
    a.classList.toggle('on', k === id);
    if (k === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function contador(id, n) {
  const item = itens.get(id);
  if (!item) return;
  item.q.hidden = !n;
  item.q.textContent = n ? String(n) : '';
}

// ---------- Ao vivo ----------

let versao = null;
let estadoAoVivo = { estado: 'conectando', erro: null, proximaTentativa: null };
const ouvintes = { mudar: new Set(), reiniciar: new Set() };

// O primeiro `reiniciar` é o da conexão: a tela acabou de ler, não precisa reler. Depois dele (ou
// depois de uma queda), todo `reiniciar` faz a tela reler.
let conectou = false;
function reiniciar() {
  lerVersao();
  if (!conectou) return void (conectou = true);
  if (telaComErro) return abrir();
  for (const f of ouvintes.reiniciar) f();
}

async function lerVersao() {
  try {
    versao = (await ler('/api/overview')).versao ?? null;
  } catch {}
  desenharAoVivo();
}

const ROTULOS = { conectando: 'Conectando', 'ao-vivo': 'Ao vivo', 'sem-conexao': 'Sem conexão' };

function desenharAoVivo() {
  const { estado, erro: e, proximaTentativa } = estadoAoVivo;
  const segundos = proximaTentativa ? Math.max(1, Math.round((proximaTentativa - Date.now()) / 1000)) : null;
  cartaoAoVivo.dataset.estado = estado;
  cartaoAoVivo.title = estado === 'sem-conexao' ? `${e?.message ?? 'O núcleo não respondeu'}. Tentando de novo${segundos ? ` em ${segundos} s` : ''}.` : '';
  cartaoAoVivo.replaceChildren(
    icone(estado === 'sem-conexao' ? 'sem-conexao' : 'ao-vivo'),
    el('b', {}, ROTULOS[estado]),
    el('span', { class: 'versao mono' }, versao ? `v${versao}` : ''),
  );
  for (const p of document.querySelectorAll('[data-ao-vivo]')) {
    p.dataset.estado = estado;
    p.textContent = ROTULOS[estado];
  }
}

iniciarAoVivo({
  ler,
  aoEstado(novo) {
    // Depois de uma queda, a próxima resposta relê tudo, mesmo que seja a primeira.
    if (novo.estado === 'sem-conexao') conectou = true;
    estadoAoVivo = novo;
    desenharAoVivo();
  },
  aoReiniciar: reiniciar,
  aoMudar(mudancas) {
    for (const f of ouvintes.mudar) f(mudancas);
  },
});

// ---------- Roteamento ----------

let saida = null;
let telaComErro = false;

// `rota` may carry the query (`/ui/agent-config?tab=skills`): it stays in the URL for the screen to read.
function navegar(rota) {
  if (rota !== location.pathname + location.search) history.pushState(null, '', rota);
  abrir();
}

async function abrir() {
  saida?.abort();
  const sair = new AbortController();
  saida = sair;
  telaComErro = false;
  // An old URL (`/ui/sessoes/<id>`) becomes the new one, in place, before routing.
  const nova = legacyUrl(location);
  if (nova) history.replaceState(history.state, '', nova);
  const achada = findScreen(location.pathname);
  if (!achada) {
    acender(null);
    document.title = 'Ahrena Console';
    area.replaceChildren(vazio({ titulo: 'Página não encontrada', texto: `Nada em ${location.pathname}.`, acao: { rotulo: 'Ir para o Dashboard', aoClicar: () => navegar('/ui') } }));
    return;
  }
  const { screen: tela, params } = achada;
  acender(tela.item ? tela.id : tela.highlights);
  document.title = `Ahrena Console · ${tela.title}`;
  if (!tela.file) {
    area.replaceChildren(
      cabecalho({ icone: tela.icon, titulo: tela.title, sub: tela.sub ?? params.id ?? null }),
      vazio({ titulo: 'Esta tela ainda não existe', texto: 'Ela chega na próxima versão do console.' }),
    );
    desenharAoVivo();
    return;
  }
  const ctx = {
    params,
    ler: (rota, opcoes) => ler(rota, { signal: sair.signal, ...opcoes }),
    escrever: (rota, corpo, opcoes) => escrever(rota, corpo, { signal: sair.signal, ...opcoes }),
    sinal: sair.signal,
    navegar,
    contador,
    titulo: (texto) => (document.title = `Ahrena Console · ${texto}`),
    aoMudar: (f) => (ouvintes.mudar.add(f), sair.signal.addEventListener('abort', () => ouvintes.mudar.delete(f))),
    aoReiniciar: (f) => (ouvintes.reiniciar.add(f), sair.signal.addEventListener('abort', () => ouvintes.reiniciar.delete(f))),
    aoVivo: () => estadoAoVivo.estado,
  };
  try {
    const modulo = await import(tela.file);
    if (sair.signal.aborted) return;
    area.replaceChildren();
    const limpar = await modulo.montar(area, ctx);
    if (typeof limpar === 'function') sair.signal.addEventListener('abort', limpar);
    desenharAoVivo();
  } catch (e) {
    if (sair.signal.aborted || e?.name === 'AbortError') return;
    telaComErro = true;
    area.replaceChildren(erro({ titulo: 'A tela não abriu', texto: e?.message ?? String(e), tentar: () => abrir() }));
  }
}

// Links internos (`/ui...`) trocam de tela sem recarregar a página.
document.addEventListener('click', (ev) => {
  const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
  if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !(url.pathname === '/ui' || url.pathname.startsWith('/ui/'))) return;
  ev.preventDefault();
  navegar(url.pathname + url.search);
});
addEventListener('popstate', abrir);

abrir();
