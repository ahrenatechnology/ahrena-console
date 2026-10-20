// A tela Sessões (C3, #28): a tabela das sessões com busca, filtro por diretório, ordenação, as
// pílulas de status e 10 por página. Filtro, ordem e página vão para o servidor (`GET /api/sessions`,
// src/api/sessoes.ts) e ficam na query da URL, para o Voltar do Detalhe cair no mesmo lugar.
// A linha leva ao Detalhe, `/ui/sessions/<id>`.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';

export const PILULAS = [
  ['todas', 'Todas'],
  ['ativas', 'Ativas'],
  ['esperando', 'Esperando'],
  ['concluidas', 'Concluídas'],
  ['erro', 'Erro'],
  ['abandonadas', 'Abandonadas'],
];

// O rótulo da ordem diz também o sentido: o ⇅ ao lado inverte.
const ORDENS = {
  atividade: { desc: 'Atividade: recente', asc: 'Atividade: antiga' },
  duracao: { desc: 'Duração: maior', asc: 'Duração: menor' },
  custo: { desc: 'Custo: maior', asc: 'Custo: menor' },
};

export const STATUS = {
  active: 'Ativa',
  waiting: 'Esperando você',
  completed: 'Concluída',
  error: 'Com erro',
  abandoned: 'Abandonada',
};

// Os motivos da espera, como no wireframe: os dois primeiros travam a sessão (urgentes).
export const MOTIVOS = {
  notification: { rotulo: 'Pede permissão', icone: 'permission', urgente: true },
  interrupted: { rotulo: 'Interrompida', icone: 'interrupted', urgente: true },
  stop: { rotulo: 'Sua vez', icone: 'your-turn', urgente: false },
  session_start: { rotulo: 'No prompt', icone: 'no-prompt', urgente: false },
};

const PADRAO = { status: 'todas', search: '', dir: '', order: 'atividade', direction: 'desc', page: 1 };

/** The screen state from the query (`?status=esperando&page=2`); what is not valid falls back to the default. */
export function estadoDaQuery(query) {
  const p = new URLSearchParams(query);
  const pagina = Number(p.get('page'));
  return {
    status: PILULAS.some(([v]) => v === p.get('status')) ? p.get('status') : PADRAO.status,
    search: (p.get('search') ?? '').slice(0, 200),
    dir: (p.get('dir') ?? '').startsWith('/') ? p.get('dir') : '',
    order: p.get('order') in ORDENS ? p.get('order') : PADRAO.order,
    direction: p.get('direction') === 'asc' ? 'asc' : 'desc',
    page: Number.isInteger(pagina) && pagina > 1 ? pagina : 1,
  };
}

/** A query do estado, só com o que difere do padrão (`''` quando é tudo padrão). */
export function queryDoEstado(estado) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(estado)) if (v !== PADRAO[k] && v !== '') p.set(k, String(v));
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** A rota da API para o estado: sempre com status, ordem, sentido e página. */
export function rotaDaLista(estado) {
  const p = new URLSearchParams({ status: estado.status, order: estado.order, direction: estado.direction, page: String(estado.page) });
  if (estado.search.trim()) p.set('search', estado.search.trim());
  if (estado.dir) p.set('dir', estado.dir);
  return `/api/sessions?${p}`;
}

/** "agora", "há 2 min", "há 1 h", "há 3 d". */
export function idade(iso, agora = Date.now()) {
  const min = Math.floor((agora - Date.parse(iso)) / 60_000);
  if (!(min >= 1)) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / (60 * 24))} d`;
}

/** "< 1 min", "12 min", "3 h 10", "2 d 4 h". */
export function duracao(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** "~US$ 1,84", ou "sem preço" quando o uso não tem preço. */
export function custo(usd) {
  if (usd === null || usd === undefined) return 'sem preço';
  return `~US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "1–10 de 12"; "0 de 0" sem nada. */
export function faixa({ total, pagina, porPagina }) {
  if (!total) return '0 de 0';
  const de = (pagina - 1) * porPagina + 1;
  return `${de}–${Math.min(total, pagina * porPagina)} de ${total}`;
}

/** O id curto da linha: os 8 primeiros de um UUID; o id inteiro nos outros casos. */
export function idCurto(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

// As colunas, na ordem; a classe dá a largura de cada uma (sessions.css).
export const COLUNAS = [
  ['c-session', 'Sessão'],
  ['c-status', 'Status'],
  ['c-activity', 'Última atividade'],
  ['c-duration', 'Duração'],
  ['c-agents', 'Agentes'],
  ['c-cost', 'Custo'],
  ['c-dir', 'Diretório'],
  ['c-arrow', ''],
];

const COR = /^#[0-9a-f]{3,8}$/i;
const ultimoPedaco = (cwd) => cwd.replace(/\/+$/, '').split('/').pop() || cwd;

function seletor(rotulo, opcoes, valor, aoMudar) {
  const s = el('select', { class: 'field-sel', 'aria-label': rotulo });
  for (const [v, texto] of opcoes) s.append(el('option', { value: v, selected: v === valor }, texto));
  s.addEventListener('change', () => aoMudar(s.value));
  return el('label', { class: 'field' }, s, icon('open-list'));
}

function selo(status, motivo) {
  const m = motivo ? MOTIVOS[motivo] : null;
  return [
    el('span', { class: `badge b-${status}` }, el('span', { class: 'p' }), STATUS[status] ?? status),
    m ? el('span', { class: m.urgente ? 'reason' : 'reason soft' }, icon(m.icone), m.rotulo) : null,
  ];
}

function conta(c) {
  if (!c) return null;
  const ponto = el('i', { class: 'account-dot' });
  if (COR.test(c.cor)) ponto.style.setProperty('--cor-da-conta', c.cor);
  return el('span', { class: 'account' }, ponto, c.rotulo);
}

export async function mount(area, ctx) {
  // O estilo da tela, uma vez por página.
  if (!document.querySelector('link[data-screen="sessions"]')) {
    document.head.append(el('link', { rel: 'stylesheet', href: '/ui/sessions.css', 'data-screen': 'sessions' }));
  }

  let estado = estadoDaQuery(location.search);
  let ultima = null;
  let pedido = 0;

  const cab = header({
    icon: 'sessions',
    title: 'Sessões',
    sub: '…',
    actions: [el('button', { type: 'button', class: 'btn', onClick: () => read() }, icon('refresh'), 'Atualizar')],
  });
  const sub = cab.querySelector('.sub');

  // ---------- filtros ----------
  const busca = el('input', { type: 'search', placeholder: 'Buscar sessões…', 'aria-label': 'Buscar sessões', value: estado.search, maxlength: 200 });
  let esperaDaBusca = null;
  busca.addEventListener('input', () => {
    clearTimeout(esperaDaBusca);
    esperaDaBusca = setTimeout(() => mudar({ search: busca.value, page: 1 }), 250);
  });
  const campoBusca = el('label', { class: 'field search' }, icon('search'), busca);
  const lugarDoDir = el('span', { class: 'dir-slot' });
  const lugarDaOrdem = el('span', { class: 'order-slot' });
  const inverter = el('button', { type: 'button', class: 'field square', 'aria-label': 'Inverter a ordem', title: 'Inverter a ordem', onClick: () => mudar({ direction: estado.direction === 'desc' ? 'asc' : 'desc', page: 1 }) }, icon('invert'));
  const pilulas = el('div', { class: 'seg', role: 'group', 'aria-label': 'Status' });
  for (const [v, rotulo] of PILULAS) pilulas.append(el('button', { type: 'button', 'data-status': v, onClick: () => mudar({ status: v, page: 1 }) }, rotulo));
  const filtros = el('div', { class: 'card filters' }, campoBusca, lugarDoDir, lugarDaOrdem, inverter, pilulas);

  const corpo = el('div', { class: 'sessions-body' }, loading({ label: 'Carregando as sessões' }));
  area.replaceChildren(cab, filtros, corpo);

  function desenharFiltros(diretorios) {
    const dirs = estado.dir && !diretorios.includes(estado.dir) ? [...diretorios, estado.dir] : diretorios;
    lugarDoDir.replaceChildren(seletor('Diretório', [['', 'Todos os projetos'], ...dirs.map((d) => [d, ultimoPedaco(d)])], estado.dir, (dir) => mudar({ dir, page: 1 })));
    lugarDaOrdem.replaceChildren(seletor('Ordenar por', Object.entries(ORDENS).map(([v, r]) => [v, r[estado.direction]]), estado.order, (ordem) => mudar({ order: ordem, page: 1 })));
    for (const b of pilulas.children) b.setAttribute('aria-pressed', String(b.dataset.status === estado.status));
  }

  function mudar(parcial) {
    estado = { ...estado, ...parcial };
    history.replaceState(null, '', `${location.pathname}${queryDoEstado(estado)}`);
    read();
  }

  // ---------- tabela ----------
  function linha(s) {
    const destino = `/ui/sessions/${encodeURIComponent(s.id)}`;
    const tr = el(
      'tr',
      { class: 'session-row' },
      el('td', { class: 'nm' }, el('a', { href: destino, title: s.titulo }, el('b', {}, s.titulo)), el('small', {}, el('span', { class: 'mono' }, idCurto(s.id)), conta(s.conta))),
      el('td', { class: 'st' }, ...selo(s.status, s.motivo)),
      el('td', { class: 'c-muted', title: new Date(s.ultimaAtividade).toLocaleString('pt-BR') }, idade(s.ultimaAtividade)),
      // Os dois pedaços não quebram por dentro: na coluna estreita, o tempo desce para a linha de baixo.
      el('td', { class: 'mono dur' }, s.rodando ? el('span', { class: 'c-active' }, 'rodando ·') : null, s.rodando ? ' ' : null, el('span', {}, duracao(s.duracaoMs))),
      el('td', { class: 'mono' }, String(s.agentes)),
      el('td', { class: 'mono' }, custo(s.custoUsd)),
      // Corta no começo (o fim do caminho é o que distingue): o LRM mantém a barra inicial no lugar.
      el('td', { class: 'dir', title: s.cwd ?? '' }, s.cwd ? `\u200e${s.cwd}\u200e` : '—'),
      el('td', { class: 'c-muted arrow' }, icon('chevron-right')),
    );
    tr.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('a')) return;
      ctx.navigate(destino);
    });
    return tr;
  }

  function tabela(lista) {
    return el(
      'div',
      { class: 'card' },
      el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ...COLUNAS.map(([classe, c]) => el('th', { scope: 'col', class: classe }, c)))), el('tbody', {}, ...lista.itens.map(linha))),
    );
  }

  function rodape(lista) {
    return el(
      'div',
      { class: 'sessions-footer' },
      el('span', {}, faixa(lista)),
      el(
        'span',
        { class: 'pages' },
        el('button', { type: 'button', class: 'btn outline', disabled: lista.pagina <= 1, onClick: () => mudar({ page: lista.pagina - 1 }) }, 'Anterior'),
        el('button', { type: 'button', class: 'btn outline', disabled: lista.pagina >= lista.paginas, onClick: () => mudar({ page: lista.pagina + 1 }) }, 'Próxima'),
      ),
    );
  }

  function desenhar(lista) {
    sub.textContent = lista.registradas === 1 ? '1 sessão registrada' : `${lista.registradas} sessões registradas`;
    // A página pedida pode ter sumido (a lista encolheu): fica a que o núcleo devolveu.
    if (lista.pagina !== estado.page) {
      estado = { ...estado, page: lista.pagina };
      history.replaceState(null, '', `${location.pathname}${queryDoEstado(estado)}`);
    }
    desenharFiltros(lista.diretorios);
    if (lista.itens.length) return corpo.replaceChildren(tabela(lista), rodape(lista));
    const filtrando = estado.status !== 'todas' || estado.search.trim() || estado.dir;
    corpo.replaceChildren(
      filtrando
        ? empty({ title: 'Nenhuma sessão com esses filtros', text: 'Mude a busca, o diretório ou o status.', action: { label: 'Limpar os filtros', onClick: () => ((busca.value = ''), mudar({ status: 'todas', search: '', dir: '', page: 1 })) } })
        : empty({ icon: 'sessions', title: 'Nenhuma sessão ainda', text: 'As sessões do Claude Code desta máquina aparecem aqui assim que o núcleo as vê.' }),
    );
  }

  async function read() {
    const meu = ++pedido;
    try {
      const lista = await ctx.read(rotaDaLista(estado));
      if (meu !== pedido) return;
      ultima = lista;
      desenhar(lista);
    } catch (e) {
      if (e?.name === 'AbortError' || meu !== pedido) return;
      // Com uma lista na tela, ela fica e a faixa avisa; sem lista, o erro ocupa o lugar.
      if (ultima) {
        corpo.querySelector('.error-band')?.remove();
        corpo.prepend(errorBand({ title: 'Não deu para atualizar.', text: e.message, action: { label: 'Tentar de novo', onClick: () => read() } }));
      } else corpo.replaceChildren(error({ text: e.message, retry: () => read() }));
    }
  }

  // Ao vivo: qualquer mudança de sessão relê a página atual, no máximo uma vez por segundo.
  let esperaAoVivo = null;
  ctx.onChange(() => {
    if (esperaAoVivo) return;
    esperaAoVivo = setTimeout(() => {
      esperaAoVivo = null;
      read();
    }, 1000);
  });
  ctx.onRestart(() => read());

  desenharFiltros([]);
  await read();
  return () => {
    clearTimeout(esperaDaBusca);
    clearTimeout(esperaAoVivo);
  };
}
