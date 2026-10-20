// A tela Sessões (C3, #28): a tabela das sessões com busca, filtro por diretório, ordenação, as
// pílulas de status e 10 por página. Filtro, ordem e página vão para o servidor (`GET /api/sessoes`,
// src/api/sessoes.ts) e ficam na query da URL, para o Voltar do Detalhe cair no mesmo lugar.
// A linha leva ao Detalhe, `/ui/sessoes/<id>`.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

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
  notification: { rotulo: 'Pede permissão', icone: 'permissao', urgente: true },
  interrupted: { rotulo: 'Interrompida', icone: 'interrompida', urgente: true },
  stop: { rotulo: 'Sua vez', icone: 'sua-vez', urgente: false },
  session_start: { rotulo: 'No prompt', icone: 'no-prompt', urgente: false },
};

const PADRAO = { status: 'todas', busca: '', dir: '', ordem: 'atividade', sentido: 'desc', pagina: 1 };

/** O estado da tela a partir da query (`?status=esperando&pagina=2`); o que não vale cai no padrão. */
export function estadoDaQuery(query) {
  const p = new URLSearchParams(query);
  const pagina = Number(p.get('pagina'));
  return {
    status: PILULAS.some(([v]) => v === p.get('status')) ? p.get('status') : PADRAO.status,
    busca: (p.get('busca') ?? '').slice(0, 200),
    dir: (p.get('dir') ?? '').startsWith('/') ? p.get('dir') : '',
    ordem: p.get('ordem') in ORDENS ? p.get('ordem') : PADRAO.ordem,
    sentido: p.get('sentido') === 'asc' ? 'asc' : 'desc',
    pagina: Number.isInteger(pagina) && pagina > 1 ? pagina : 1,
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
  const p = new URLSearchParams({ status: estado.status, ordem: estado.ordem, sentido: estado.sentido, pagina: String(estado.pagina) });
  if (estado.busca.trim()) p.set('busca', estado.busca.trim());
  if (estado.dir) p.set('dir', estado.dir);
  return `/api/sessoes?${p}`;
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

// As colunas, na ordem; a classe dá a largura de cada uma (sessoes.css).
export const COLUNAS = [
  ['c-sessao', 'Sessão'],
  ['c-status', 'Status'],
  ['c-atividade', 'Última atividade'],
  ['c-duracao', 'Duração'],
  ['c-agentes', 'Agentes'],
  ['c-custo', 'Custo'],
  ['c-dir', 'Diretório'],
  ['c-seta', ''],
];

const COR = /^#[0-9a-f]{3,8}$/i;
const ultimoPedaco = (cwd) => cwd.replace(/\/+$/, '').split('/').pop() || cwd;

function seletor(rotulo, opcoes, valor, aoMudar) {
  const s = el('select', { class: 'campo-sel', 'aria-label': rotulo });
  for (const [v, texto] of opcoes) s.append(el('option', { value: v, selected: v === valor }, texto));
  s.addEventListener('change', () => aoMudar(s.value));
  return el('label', { class: 'campo' }, s, icone('abrir-lista'));
}

function selo(status, motivo) {
  const m = motivo ? MOTIVOS[motivo] : null;
  return [
    el('span', { class: `badge b-${status}` }, el('span', { class: 'p' }), STATUS[status] ?? status),
    m ? el('span', { class: m.urgente ? 'mot' : 'mot leve' }, icone(m.icone), m.rotulo) : null,
  ];
}

function conta(c) {
  if (!c) return null;
  const ponto = el('i', { class: 'ponto-conta' });
  if (COR.test(c.cor)) ponto.style.setProperty('--cor-da-conta', c.cor);
  return el('span', { class: 'conta' }, ponto, c.rotulo);
}

export async function montar(area, ctx) {
  // O estilo da tela, uma vez por página.
  if (!document.querySelector('link[data-tela="sessoes"]')) {
    document.head.append(el('link', { rel: 'stylesheet', href: '/ui/sessoes.css', 'data-tela': 'sessoes' }));
  }

  let estado = estadoDaQuery(location.search);
  let ultima = null;
  let pedido = 0;

  const cab = cabecalho({
    icone: 'sessoes',
    titulo: 'Sessões',
    sub: '…',
    acoes: [el('button', { type: 'button', class: 'btn', aoClicar: () => ler() }, icone('atualizar'), 'Atualizar')],
  });
  const sub = cab.querySelector('.sub');

  // ---------- filtros ----------
  const busca = el('input', { type: 'search', placeholder: 'Buscar sessões…', 'aria-label': 'Buscar sessões', value: estado.busca, maxlength: 200 });
  let esperaDaBusca = null;
  busca.addEventListener('input', () => {
    clearTimeout(esperaDaBusca);
    esperaDaBusca = setTimeout(() => mudar({ busca: busca.value, pagina: 1 }), 250);
  });
  const campoBusca = el('label', { class: 'campo busca' }, icone('buscar'), busca);
  const lugarDoDir = el('span', { class: 'lugar-dir' });
  const lugarDaOrdem = el('span', { class: 'lugar-ordem' });
  const inverter = el('button', { type: 'button', class: 'campo quadrado', 'aria-label': 'Inverter a ordem', title: 'Inverter a ordem', aoClicar: () => mudar({ sentido: estado.sentido === 'desc' ? 'asc' : 'desc', pagina: 1 }) }, icone('inverter'));
  const pilulas = el('div', { class: 'seg', role: 'group', 'aria-label': 'Status' });
  for (const [v, rotulo] of PILULAS) pilulas.append(el('button', { type: 'button', 'data-status': v, aoClicar: () => mudar({ status: v, pagina: 1 }) }, rotulo));
  const filtros = el('div', { class: 'cartao filtros' }, campoBusca, lugarDoDir, lugarDaOrdem, inverter, pilulas);

  const corpo = el('div', { class: 'corpo-sessoes' }, carregando({ rotulo: 'Carregando as sessões' }));
  area.replaceChildren(cab, filtros, corpo);

  function desenharFiltros(diretorios) {
    const dirs = estado.dir && !diretorios.includes(estado.dir) ? [...diretorios, estado.dir] : diretorios;
    lugarDoDir.replaceChildren(seletor('Diretório', [['', 'Todos os projetos'], ...dirs.map((d) => [d, ultimoPedaco(d)])], estado.dir, (dir) => mudar({ dir, pagina: 1 })));
    lugarDaOrdem.replaceChildren(seletor('Ordenar por', Object.entries(ORDENS).map(([v, r]) => [v, r[estado.sentido]]), estado.ordem, (ordem) => mudar({ ordem, pagina: 1 })));
    for (const b of pilulas.children) b.setAttribute('aria-pressed', String(b.dataset.status === estado.status));
  }

  function mudar(parcial) {
    estado = { ...estado, ...parcial };
    history.replaceState(null, '', `${location.pathname}${queryDoEstado(estado)}`);
    ler();
  }

  // ---------- tabela ----------
  function linha(s) {
    const destino = `/ui/sessoes/${encodeURIComponent(s.id)}`;
    const tr = el(
      'tr',
      { class: 'linha' },
      el('td', { class: 'nm' }, el('a', { href: destino, title: s.titulo }, el('b', {}, s.titulo)), el('small', {}, el('span', { class: 'mono' }, idCurto(s.id)), conta(s.conta))),
      el('td', { class: 'st' }, ...selo(s.status, s.motivo)),
      el('td', { class: 'c-muted', title: new Date(s.ultimaAtividade).toLocaleString('pt-BR') }, idade(s.ultimaAtividade)),
      // Os dois pedaços não quebram por dentro: na coluna estreita, o tempo desce para a linha de baixo.
      el('td', { class: 'mono dur' }, s.rodando ? el('span', { class: 'c-active' }, 'rodando ·') : null, s.rodando ? ' ' : null, el('span', {}, duracao(s.duracaoMs))),
      el('td', { class: 'mono' }, String(s.agentes)),
      el('td', { class: 'mono' }, custo(s.custoUsd)),
      // Corta no começo (o fim do caminho é o que distingue): o LRM mantém a barra inicial no lugar.
      el('td', { class: 'dir', title: s.cwd ?? '' }, s.cwd ? `\u200e${s.cwd}\u200e` : '—'),
      el('td', { class: 'c-muted seta' }, icone('chevron-direita')),
    );
    tr.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('a')) return;
      ctx.navegar(destino);
    });
    return tr;
  }

  function tabela(lista) {
    return el(
      'div',
      { class: 'cartao' },
      el('table', { class: 'tabela' }, el('thead', {}, el('tr', {}, ...COLUNAS.map(([classe, c]) => el('th', { scope: 'col', class: classe }, c)))), el('tbody', {}, ...lista.itens.map(linha))),
    );
  }

  function rodape(lista) {
    return el(
      'div',
      { class: 'rodape-sessoes' },
      el('span', {}, faixa(lista)),
      el(
        'span',
        { class: 'paginas' },
        el('button', { type: 'button', class: 'btn contorno', disabled: lista.pagina <= 1, aoClicar: () => mudar({ pagina: lista.pagina - 1 }) }, 'Anterior'),
        el('button', { type: 'button', class: 'btn contorno', disabled: lista.pagina >= lista.paginas, aoClicar: () => mudar({ pagina: lista.pagina + 1 }) }, 'Próxima'),
      ),
    );
  }

  function desenhar(lista) {
    sub.textContent = lista.registradas === 1 ? '1 sessão registrada' : `${lista.registradas} sessões registradas`;
    // A página pedida pode ter sumido (a lista encolheu): fica a que o núcleo devolveu.
    if (lista.pagina !== estado.pagina) {
      estado = { ...estado, pagina: lista.pagina };
      history.replaceState(null, '', `${location.pathname}${queryDoEstado(estado)}`);
    }
    desenharFiltros(lista.diretorios);
    if (lista.itens.length) return corpo.replaceChildren(tabela(lista), rodape(lista));
    const filtrando = estado.status !== 'todas' || estado.busca.trim() || estado.dir;
    corpo.replaceChildren(
      filtrando
        ? vazio({ titulo: 'Nenhuma sessão com esses filtros', texto: 'Mude a busca, o diretório ou o status.', acao: { rotulo: 'Limpar os filtros', aoClicar: () => ((busca.value = ''), mudar({ status: 'todas', busca: '', dir: '', pagina: 1 })) } })
        : vazio({ icone: 'sessoes', titulo: 'Nenhuma sessão ainda', texto: 'As sessões do Claude Code desta máquina aparecem aqui assim que o núcleo as vê.' }),
    );
  }

  async function ler() {
    const meu = ++pedido;
    try {
      const lista = await ctx.ler(rotaDaLista(estado));
      if (meu !== pedido) return;
      ultima = lista;
      desenhar(lista);
    } catch (e) {
      if (e?.name === 'AbortError' || meu !== pedido) return;
      // Com uma lista na tela, ela fica e a faixa avisa; sem lista, o erro ocupa o lugar.
      if (ultima) {
        corpo.querySelector('.faixa-erro')?.remove();
        corpo.prepend(faixaDeErro({ titulo: 'Não deu para atualizar.', texto: e.message, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }));
      } else corpo.replaceChildren(erro({ texto: e.message, tentar: () => ler() }));
    }
  }

  // Ao vivo: qualquer mudança de sessão relê a página atual, no máximo uma vez por segundo.
  let esperaAoVivo = null;
  ctx.aoMudar(() => {
    if (esperaAoVivo) return;
    esperaAoVivo = setTimeout(() => {
      esperaAoVivo = null;
      ler();
    }, 1000);
  });
  ctx.aoReiniciar(() => ler());

  desenharFiltros([]);
  await ler();
  return () => {
    clearTimeout(esperaDaBusca);
    clearTimeout(esperaAoVivo);
  };
}
