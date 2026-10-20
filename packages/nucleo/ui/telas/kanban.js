// Kanban (#31, C9 e C10 do wireframe): as sessões, ou os agentes, em colunas por status. Só leitura.
//
// - A visão vem da query (`/ui/kanban?visao=agentes`; sem ela, sessões). Trocar a visão troca a URL
//   com `history.replaceState`, sem recarregar, e relê.
// - `GET /api/kanban?visao=<v>` traz todas as colunas na página 1; "mostrar mais" pede
//   `&coluna=<id>&pagina=<n>` e acrescenta os itens no fim da coluna.
// - Ao vivo: uma mudança de sessão relê o quadro (com um respiro de 400 ms, para juntar rajadas);
//   reiniciar relê. A releitura volta cada coluna à página 1.
// - O estilo está em `ui/kanban.css`, que a tela põe no <head> ao montar e tira ao sair.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

// ---------- Funções puras (testadas em test/api/ui-kanban.test.ts) ----------

export const VISOES = ['sessoes', 'agentes'];

/** A visão pedida na query; qualquer outra coisa é `sessoes`. */
export function visaoDaUrl(search) {
  const v = new URLSearchParams(search ?? '').get('visao');
  return VISOES.includes(v) ? v : 'sessoes';
}

/** A query da URL do navegador para uma visão: sessões é o padrão e não aparece. */
export function queryDaVisao(visao) {
  return visao === 'agentes' ? '?visao=agentes' : '';
}

/** A rota da API: o quadro todo, ou uma página de uma coluna. */
export function rotaDoKanban(visao, coluna = null, pagina = null) {
  const q = new URLSearchParams({ visao });
  if (coluna) {
    q.set('coluna', coluna);
    q.set('pagina', String(pagina ?? 1));
  }
  return `/api/kanban?${q}`;
}

/** Duração legível: "40 s", "12 min", "3 h 10", "2 h". */
export function formatarDuracao(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h} h ${String(resto).padStart(2, '0')}` : `${h} h`;
}

const REAIS = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Custo estimado: "~US$ 1,84"; sem custo, `null` (a linha some). */
export function formatarCusto(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
  return `~US$ ${REAIS.format(usd)}`;
}

/** Os 8 primeiros caracteres do id. */
export function idCurto(id) {
  return String(id ?? '').slice(0, 8);
}

/** "1 agente", "3 agentes". */
export function rotuloAgentes(n) {
  const k = Number.isFinite(n) ? n : 0;
  return `${k} agente${k === 1 ? '' : 's'}`;
}

/** O motivo da espera: rótulo, ícone e se é urgente (peso maior no selo). */
const MOTIVOS = {
  notification: { rotulo: 'Pede permissão', icone: 'permissao', urgente: true },
  interrupted: { rotulo: 'Interrompida', icone: 'interrompida', urgente: true },
  stop: { rotulo: 'Sua vez', icone: 'sua-vez', urgente: false },
  session_start: { rotulo: 'Sua vez', icone: 'sua-vez', urgente: false },
};

export function motivo(m) {
  return MOTIVOS[m] ?? null;
}

export function rotuloMotivo(m) {
  return MOTIVOS[m]?.rotulo ?? null;
}

/** Status da sessão ou do agente → a cor (classe) e o rótulo do selo. O agente "working" é ativo. */
const STATUS = {
  active: { cor: 'active', rotulo: 'Ativa' },
  working: { cor: 'active', rotulo: 'Ativa' },
  waiting: { cor: 'waiting', rotulo: 'Esperando você' },
  completed: { cor: 'completed', rotulo: 'Concluída' },
  error: { cor: 'error', rotulo: 'Com erro' },
  abandoned: { cor: 'abandoned', rotulo: 'Abandonada' },
};

export function status(st) {
  return STATUS[st] ?? { cor: 'abandoned', rotulo: String(st ?? '—') };
}

/** A cor da coluna, pelo id dela (as duas visões). */
const COR_DA_COLUNA = {
  ativa: 'active',
  trabalhando: 'active',
  esperando: 'waiting',
  concluida: 'completed',
  concluidos: 'completed',
  erro: 'error',
  abandonada: 'abandoned',
};

export function corDaColuna(id) {
  return COR_DA_COLUNA[id] ?? 'abandoned';
}

/** Quantos faltam mostrar numa coluna. */
export function faltam(coluna, mostrados) {
  return Math.max(0, (coluna?.total ?? 0) - mostrados);
}

/** Uma mudança do long polling que mexe no quadro. */
const TIPOS_QUE_MEXEM = new Set(['sessao', 'estado', 'precisa-de-voce']);
export function mexeNoQuadro(mudancas) {
  return Array.isArray(mudancas) && mudancas.some((m) => TIPOS_QUE_MEXEM.has(m?.tipo));
}

// ---------- Peças ----------

const SUB = {
  sessoes: 'As sessões por status, só leitura',
  agentes: 'Os agentes por status, só leitura',
};

const VAZIO = {
  sessoes: { titulo: 'Nenhuma sessão ainda', texto: 'Quando uma sessão do Claude Code começar nesta máquina, ela aparece aqui.' },
  agentes: { titulo: 'Nenhum agente ainda', texto: 'Quando uma sessão do Claude Code começar nesta máquina, os agentes dela aparecem aqui.' },
};

const hrefDaSessao = (id) => `/ui/sessoes/${encodeURIComponent(id)}`;

function selos(st, mot) {
  const s = status(st);
  const m = motivo(mot);
  return el(
    'div',
    { class: 'selos' },
    el('span', { class: `selo-st b-${s.cor}` }, el('span', { class: 'p' }), s.rotulo),
    m ? el('span', { class: `selo-mot${m.urgente ? '' : ' leve'}` }, icone(m.icone), m.rotulo) : null,
  );
}

function avatar(nome) {
  return el('span', { class: 'av' }, icone(nome));
}

function info(nomeDoIcone, texto, classe = null) {
  return el('span', { class: classe }, icone(nomeDoIcone), texto);
}

function cardDeSessao(s) {
  const custo = formatarCusto(s.custoUsd);
  return el(
    'a',
    { class: `cartao kc st-${status(s.status).cor}`, href: hrefDaSessao(s.id), title: s.titulo || null },
    el('div', { class: 'l1' }, avatar('pasta'), el('div', { class: 'nome' }, el('div', { class: 'tt' }, s.titulo || '(sem título)'), el('small', {}, idCurto(s.id)))),
    selos(s.status, s.motivo),
    s.ultimoPedido ? el('blockquote', {}, s.ultimoPedido) : null,
    s.cwd ? el('div', { class: 'cwd' }, s.cwd) : null,
    el(
      'div',
      { class: 'pe' },
      info('bot', rotuloAgentes(s.agentes)),
      s.modelo ? info('modelo', s.modelo) : null,
      custo ? info('moedas', custo) : null,
      info('duracao', formatarDuracao(s.duracaoMs), s.rodando ? 'dur rodando' : 'dur'),
    ),
  );
}

function cardDeAgente(a) {
  return el(
    'a',
    { class: `cartao kc agente st-${status(a.status).cor}`, href: hrefDaSessao(a.sessaoId), title: a.descricao || a.nome || null },
    el('div', { class: 'l1' }, avatar(a.principal ? 'bot' : 'subagente'), el('div', { class: 'nome' }, el('div', { class: 'tt' }, a.nome || '(sem nome)'), a.descricao ? el('small', {}, a.descricao) : null)),
    selos(a.status, a.motivo),
    el('div', { class: 'pe' }, a.modelo ? info('modelo', a.modelo) : null, info('duracao', formatarDuracao(a.duracaoMs), a.rodando ? 'dur rodando' : 'dur')),
  );
}

// ---------- A tela ----------

export async function montar(area, ctx) {
  const folha = ligarFolha();
  ctx.titulo('Kanban');
  let visao = visaoDaUrl(location.search);
  let leitura = 0; // descarta resposta de leitura velha
  let quadroNoAr = false;

  const botoes = Object.fromEntries(
    VISOES.map((v) => [v, el('button', { type: 'button', 'aria-pressed': String(v === visao), aoClicar: () => trocar(v) }, v === 'agentes' ? 'Agentes' : 'Sessões')]),
  );
  const alternador = el('div', { class: 'seg', role: 'group', 'aria-label': 'Visão do Kanban' }, botoes.agentes, botoes.sessoes);
  const atualizar = el('button', { type: 'button', class: 'btn', aoClicar: () => desenhar() }, icone('atualizar'), 'Atualizar');
  const cab = cabecalho({ icone: 'kanban', titulo: 'Kanban', sub: SUB[visao], acoes: [alternador, atualizar] });
  const sub = cab.querySelector('.sub');

  function trocar(v) {
    if (v === visao) return;
    visao = v;
    for (const [k, b] of Object.entries(botoes)) b.setAttribute('aria-pressed', String(k === visao));
    sub.textContent = SUB[visao];
    history.replaceState(history.state, '', `${location.pathname}${queryDaVisao(visao)}`);
    quadroNoAr = false;
    desenhar();
  }

  async function desenhar() {
    const minha = ++leitura;
    const v = visao;
    if (!quadroNoAr) area.replaceChildren(cab, carregando({ rotulo: 'Carregando o quadro', blocos: 2 }));
    atualizar.disabled = true;
    try {
      const dados = await ctx.ler(rotaDoKanban(v));
      if (minha !== leitura) return;
      const colunas = Array.isArray(dados?.colunas) ? dados.colunas : [];
      if (!colunas.some((c) => c.total > 0)) {
        quadroNoAr = false;
        area.replaceChildren(cab, vazio(VAZIO[v]));
      } else {
        quadroNoAr = true;
        area.replaceChildren(cab, quadro(v, colunas));
      }
    } catch (e) {
      if (e?.name === 'AbortError' || minha !== leitura) return;
      const texto = e?.message ?? String(e);
      if (quadroNoAr) {
        // O quadro de antes fica; a faixa diz que esta leitura falhou.
        area.querySelector('.faixa-erro')?.remove();
        cab.after(faixaDeErro({ titulo: 'O quadro não atualizou.', texto, acao: { rotulo: 'Tentar de novo', aoClicar: () => desenhar() } }));
      } else {
        area.replaceChildren(cab, erro({ texto, tentar: () => desenhar() }));
      }
    } finally {
      if (minha === leitura) atualizar.disabled = false;
    }
  }

  function quadro(v, colunas) {
    return el('div', { class: 'kanban', role: 'region', 'aria-label': v === 'agentes' ? 'Agentes por status' : 'Sessões por status', tabindex: '0' }, ...colunas.map((c) => coluna(v, c)));
  }

  function coluna(v, c) {
    const card = v === 'agentes' ? cardDeAgente : cardDeSessao;
    const cor = corDaColuna(c.id);
    const lista = el('div', { class: 'cards' }, ...(c.itens ?? []).map(card));
    const contador = el('span', { class: 'n', 'aria-label': `${c.total} no total` }, String(c.total ?? 0));
    let pagina = c.pagina ?? 1;
    let mostrados = (c.itens ?? []).length;
    let temMais = Boolean(c.temMais);
    const mais = el('button', { type: 'button', class: 'mais' });

    function rotular(texto = null) {
      const n = faltam({ total: Number(contador.textContent) }, mostrados);
      mais.hidden = !temMais || n === 0;
      mais.textContent = texto ?? `mostrar mais ${n}`;
    }

    mais.addEventListener('click', async () => {
      const desta = leitura;
      mais.disabled = true;
      rotular('carregando…');
      try {
        const r = await ctx.ler(rotaDoKanban(v, c.id, pagina + 1));
        if (desta !== leitura) return; // o quadro foi relido nesse meio-tempo
        const col = r?.colunas?.find((x) => x.id === c.id);
        if (!col) throw new Error('a coluna não veio');
        lista.append(...(col.itens ?? []).map(card));
        mostrados += (col.itens ?? []).length;
        pagina = col.pagina ?? pagina + 1;
        temMais = Boolean(col.temMais);
        contador.textContent = String(col.total ?? contador.textContent);
        rotular();
      } catch (e) {
        if (e?.name === 'AbortError' || desta !== leitura) return;
        rotular('não carregou · tentar de novo');
      } finally {
        mais.disabled = false;
      }
    });
    rotular();

    return el(
      'section',
      { class: 'col', 'aria-label': `${c.rotulo}: ${c.total}` },
      el('h2', { class: 'cab' }, el('span', { class: `ponto d-${cor}` }), el('span', { class: `c-${cor}` }, c.rotulo), contador),
      lista,
      mais,
    );
  }

  // Ao vivo: junta as mudanças de sessão numa releitura só.
  let espera = null;
  ctx.aoMudar((mudancas) => {
    if (!mexeNoQuadro(mudancas)) return;
    clearTimeout(espera);
    espera = setTimeout(() => desenhar(), 400);
  });
  ctx.aoReiniciar(() => desenhar());

  // A limpeza vale mesmo se a pessoa sair antes da primeira leitura voltar.
  ctx.sinal.addEventListener('abort', () => {
    clearTimeout(espera);
    folha.remove();
  });
  await desenhar();
}

/** Põe `kanban.css` no <head>, uma vez só; devolve o <link> para a limpeza. */
function ligarFolha() {
  const ja = document.head.querySelector('link[data-tela="kanban"]');
  if (ja) return ja;
  const link = el('link', { rel: 'stylesheet', href: '/ui/kanban.css', 'data-tela': 'kanban' });
  document.head.append(link);
  return link;
}
