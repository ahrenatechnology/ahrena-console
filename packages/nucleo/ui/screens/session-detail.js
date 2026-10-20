// O Detalhe da sessão (#29 e #30): o topo do A5 e as abas Agentes (C4), Conversa (C5) e Linha do
// tempo (C6), sobre `GET /api/sessions/<id>…` (src/api/detalhe.ts). Workflow e Decisões não entram
// nesta versão.
//
// Tudo o que vem do núcleo, e o texto da conversa mais ainda, é conteúdo não confiável: entra por
// `textContent` (`el()`), nunca como HTML.

import { el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../states.js';
import { abrirNoDesktop } from '../api.js';
import { criar as abaWorkflow } from './session-detail-workflow.js';
import { criar as abaDecisoes } from './session-detail-decisions.js';

// ---------- Formatos ----------

const NUM = new Intl.NumberFormat('pt-BR');
const DEC = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HORA = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const DIA = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

const num = (n) => NUM.format(n);
const usd = (v) => (v === null || v === undefined ? 'sem preço' : `~US$ ${USD.format(v)}`);

/** 6.000.000 → "6,0 M"; 230.000 → "230 k"; 4.100 → "4,1 k". */
function tokens(n) {
  if (n >= 1e6) return `${DEC.format(n / 1e6)} M`;
  if (n >= 1e4) return `${num(Math.round(n / 1e3))} k`;
  if (n >= 1e3) return `${DEC.format(n / 1e3)} k`;
  return num(n);
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function nomeDoModelo(id) {
  if (!id) return null;
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** 40 s, 12 min, 1 h 05 min. */
function duracao(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "agora", "2 min", "3 h", "2 d". */
function ha(iso, agora = Date.now()) {
  const m = Math.round((agora - Date.parse(iso)) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}

/** "hoje, 22:41", "ontem, 09:10" ou "18/10, 09:10". */
function quando(iso, agora = new Date()) {
  const d = new Date(iso);
  const dia = (x) => x.toDateString();
  const ontem = new Date(agora);
  ontem.setDate(agora.getDate() - 1);
  const prefixo = dia(d) === dia(agora) ? 'hoje' : dia(d) === dia(ontem) ? 'ontem' : DIA.format(d);
  return `${prefixo}, ${HORA.format(d)}`;
}

const STATUS = { active: 'Ativa', working: 'Ativa', waiting: 'Esperando você', error: 'Erro', completed: 'Concluída', abandoned: 'Abandonada' };
const COR = { active: 'active', working: 'active', waiting: 'waiting', error: 'error', completed: 'completed', abandoned: 'abandoned' };

function pilulaDeStatus(status, rotulo = STATUS[status] ?? status) {
  return el('span', { class: `sd-status sd-s-${COR[status] ?? 'abandoned'}` }, rotulo);
}

/** O motivo da espera, como no A5: "Pede permissão", "Pergunta", "Sua vez"… */
function motivoDe(sessao) {
  if (sessao.status === 'error') return null;
  if (sessao.faixa?.tipo === 'permissao') return 'Pede permissão';
  if (sessao.faixa?.tipo === 'pergunta') return 'Pergunta';
  return { interrupted: 'Interrompida', stop: 'Sua vez', session_start: 'No prompt', notification: 'Pede permissão' }[sessao.motivo] ?? null;
}

/** Texto com `código` entre crases: cada pedaço vira nó de texto ou `<code>`, nunca HTML. */
function comCodigo(texto) {
  const partes = String(texto ?? '').split(/`([^`\n]+)`/);
  return partes.map((p, i) => (i % 2 ? el('code', { class: 'sd-code' }, p) : p));
}

const ICONE_DA_FERRAMENTA = { Bash: 'terminal', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', Read: 'file', Agent: 'robot', Task: 'robot', Grep: 'search', Glob: 'search', TaskUpdate: 'tasks', TaskCreate: 'tasks', TodoWrite: 'tasks' };

function botaoCopiar(texto, rotulo) {
  const b = el('button', { type: 'button', class: 'sd-copy', title: `Copiar ${rotulo}`, 'aria-label': `Copiar ${rotulo}` }, icone('copy'));
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(texto);
      b.classList.add('sd-copied');
      setTimeout(() => b.classList.remove('sd-copied'), 1200);
    } catch {}
  });
  return b;
}

function pilula(icon, ...filhos) {
  return el('span', { class: 'sd-pill mono' }, icon ? icone(icon) : null, ...filhos);
}

// ---------- A tela ----------

// O registro das abas, na ordem da barra. Uma aba nova é uma linha aqui e um módulo em
// `ui/screens/detalhe-<aba>.js` que exporta `criar(ctx, base, { cabeca, rotular })` e devolve
// `{ mostrar(corpo), esconder(), atualizar() }`:
// - `base` é `/api/sessions/<id>`; `cabeca()` é o topo já lido (`GET /api/sessions/<id>`);
// - `rotular(texto)` põe o "(…)" ao lado do nome da aba; `null` tira.
// A aba carrega o próprio CSS, se tiver.
const ABAS = [
  { id: 'agents', rotulo: 'Agentes', icone: 'robot', criar: abaAgentes },
  { id: 'conversation', rotulo: 'Conversa', icone: 'conversation', criar: abaConversa },
  { id: 'timeline', rotulo: 'Linha do tempo', icone: 'list', criar: abaTempo },
  { id: 'workflow', rotulo: 'Workflow', icone: 'graph', criar: abaWorkflow },
  { id: 'decisions', rotulo: 'Decisões', icone: 'decision', criar: abaDecisoes },
];

let cssCarregado = false;
function carregarCss() {
  if (cssCarregado || document.querySelector('link[data-screen="session-detail"]')) return;
  cssCarregado = true;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/session-detail.css', 'data-screen': 'session-detail' }));
}

export async function montar(area, ctx) {
  carregarCss();
  const id = ctx.params.id;
  const base = `/api/sessions/${encodeURIComponent(id)}`;
  const topo = el('div', { class: 'sd-top' });
  const abas = el('nav', { class: 'sd-tabs', role: 'tablist', 'aria-label': 'Abas da sessão' });
  const corpo = el('div', { class: 'sd-body', role: 'tabpanel' });
  area.replaceChildren(carregando({ rotulo: 'Carregando a sessão' }));

  let cabeca = null;
  let aba = (location.hash.slice(1) && ABAS.some((a) => a.id === location.hash.slice(1))) ? location.hash.slice(1) : null;
  const rotulos = {};
  const telas = Object.fromEntries(
    ABAS.map((a) => [a.id, a.criar(ctx, base, { cabeca: () => cabeca, rotular: (t) => ((rotulos[a.id] = t ?? undefined), desenharAbas()) })]),
  );

  function desenharAbas() {
    abas.replaceChildren(
      ...ABAS.map((a) => {
        // Até a aba dizer o dela, Agentes e Linha do tempo usam as contagens do topo.
        const padrao = { agents: cabeca?.contagens.agentes, timeline: cabeca ? num(cabeca.contagens.eventos) : null }[a.id];
        const rotulo = rotulos[a.id] ?? padrao;
        const sufixo = rotulo === undefined || rotulo === null ? '' : ` (${rotulo})`;
        const b = el('button', { type: 'button', role: 'tab', class: `sd-tab${a.id === aba ? ' on' : ''}`, 'aria-selected': a.id === aba ? 'true' : 'false', 'data-tab': a.id }, icone(a.icone), `${a.rotulo}${sufixo}`);
        b.addEventListener('click', () => trocar(a.id));
        return b;
      }),
    );
  }

  function trocar(nova) {
    if (nova === aba) return;
    telas[aba]?.esconder();
    aba = nova;
    history.replaceState(null, '', `${location.pathname}#${aba}`);
    desenharAbas();
    corpo.replaceChildren(carregando({ rotulo: 'Carregando', blocos: 2 }));
    telas[aba].mostrar(corpo);
  }

  async function lerCabeca() {
    try {
      cabeca = await ctx.ler(base);
      ctx.titulo(cabeca.sessao.titulo);
      topo.replaceChildren(...desenharTopo(cabeca, atualizarTudo));
      desenharAbas();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      if (!cabeca) {
        area.replaceChildren(
          e.status === 404
            ? vazio({ titulo: 'Sessão não encontrada', texto: `O núcleo não conhece a sessão ${id}.`, acao: { rotulo: 'Voltar para Sessões', icone: 'back', aoClicar: () => ctx.navegar('/ui/sessions') } })
            : erro({ texto: e.message, tentar: () => primeira() }),
        );
      } else {
        topo.querySelector('.error-band')?.remove();
        topo.append(faixaDeErro({ titulo: 'Não deu para atualizar.', texto: e.message, acao: { rotulo: 'Tentar de novo', aoClicar: atualizarTudo } }));
      }
      return false;
    }
  }

  async function primeira() {
    area.replaceChildren(carregando({ rotulo: 'Carregando a sessão' }));
    if (!(await lerCabeca())) return;
    aba ??= cabeca.sessao.status === 'waiting' ? 'conversation' : 'agents';
    area.replaceChildren(topo, abas, corpo);
    desenharAbas();
    corpo.replaceChildren(carregando({ rotulo: 'Carregando', blocos: 2 }));
    telas[aba].mostrar(corpo);
  }

  async function atualizarTudo() {
    if (!cabeca) return primeira();
    await lerCabeca();
    telas[aba].atualizar();
  }

  // Ao vivo: a mudança desta sessão relê o topo e a aba aberta, juntando as que chegam perto.
  let espera = null;
  ctx.aoMudar((mudancas) => {
    if (!mudancas.some((m) => m.sessionId === id)) return;
    clearTimeout(espera);
    espera = setTimeout(atualizarTudo, 400);
  });
  ctx.aoReiniciar(atualizarTudo);

  await primeira();
  return () => clearTimeout(espera);
}

// ---------- Topo (A5) ----------

function desenharTopo(c, atualizar) {
  const s = c.sessao;
  const agora = Date.now();
  const motivo = motivoDe(s);
  const fim = s.status === 'active' || s.status === 'waiting' ? agora : Date.parse(c.encerradaEm ?? s.desde);
  const linha1 = el(
    'div',
    { class: 'sd-row' },
    el('a', { class: 'sd-back', href: '/ui/sessions', title: 'Voltar para Sessões', 'aria-label': 'Voltar para Sessões' }, icone('back')),
    el('h1', {}, s.titulo),
    pilulaDeStatus(s.status),
    motivo && s.status === 'waiting' ? el('span', { class: `sd-reason${s.urgente ? ' sd-urgent' : ''}` }, s.faixa?.tipo === 'permissao' ? icone('shield') : null, motivo) : null,
    el('button', { type: 'button', class: 'sd-refresh', title: 'Atualizar', 'aria-label': 'Atualizar', aoClicar: atualizar }, icone('refresh')),
  );
  const pilulas = el(
    'div',
    { class: 'sd-pills' },
    pilula(null, s.id.slice(0, 12), botaoCopiar(s.id, 'o id da sessão')),
    s.modelo ? pilula('port', nomeDoModelo(s.modelo)) : null,
    pilula('clock', `${quando(s.iniciadaEm)} (${duracao(fim - Date.parse(s.iniciadaEm))})`),
    c.custo ? el('span', { class: 'sd-pill mono sd-cost', title: 'Estimativa' }, usd(c.custo.usd)) : null,
    c.branch ? pilula('branch', c.branch) : null,
  );
  const pasta = s.cwd ? el('div', { class: 'sd-folder mono' }, icone('folder'), el('span', {}, s.cwd), botaoCopiar(s.cwd, 'a pasta')) : null;
  return [linha1, pilulas, pasta, s.faixa ? faixa(c) : null].filter(Boolean);
}

/** O texto da faixa com o comando que pede permissão em `<code>`, montado pelo DOM. */
function comComando(texto, comando) {
  const i = comando ? texto.indexOf(comando) : -1;
  if (i < 0) return comCodigo(texto);
  return [texto.slice(0, i), el('code', { class: 'sd-code' }, comando), texto.slice(i + comando.length)];
}

// The class of each band type and tool state (the API value stays as it comes).
const BAND_CLASS = { permissao: 'permission', pergunta: 'question', erro: 'error' };
const TOOL_STATE_CLASS = { ok: 'ok', erro: 'error', permissao: 'permission', rodando: 'running' };
const TITULO_DA_FAIXA = { permissao: 'Esperando você · Pede permissão.', pergunta: 'Esperando você · Pergunta.', erro: 'Erro.' };

function faixa(c) {
  const f = c.sessao.faixa;
  const aviso = el('span', { class: 'sd-notice', role: 'status' });
  const botao = el('button', { type: 'button', class: 'btn outline', disabled: !c.local, title: c.local ? null : 'Esta sessão não está no Claude Desktop' }, 'Abrir no Claude Desktop', icone('external'));
  botao.addEventListener('click', async () => {
    aviso.textContent = '';
    try {
      await abrirNoDesktop(c.local);
    } catch (e) {
      // Sem quem abra (fora do macOS, ou a demonstração): o link de reserva leva ao `claude://`.
      if (e.status === 501) return void (location.href = `/open/${c.local}`);
      aviso.textContent = e.message;
    }
  });
  return el(
    'section',
    { class: `sd-band sd-t-${BAND_CLASS[f.tipo] ?? f.tipo}`, role: f.tipo === 'erro' ? 'alert' : 'status' },
    icone(f.tipo === 'erro' ? 'error' : 'shield'),
    el('p', {}, el('b', {}, TITULO_DA_FAIXA[f.tipo] ?? ''), ' ', ...comComando(f.texto, c.comando), `. Há ${ha(f.desde).replace('agora', 'menos de 1 min')}.`, aviso),
    botao,
  );
}

// ---------- Aba Agentes (C4) ----------

function abaAgentes(ctx, base) {
  let alvo = null;
  async function desenhar() {
    try {
      const a = await ctx.ler(`${base}/agents`);
      alvo?.replaceChildren(...agentes(a));
    } catch (e) {
      if (e.name === 'AbortError') return;
      alvo?.replaceChildren(erro({ titulo: 'Não deu para ler os agentes', texto: e.message, tentar: desenhar }));
    }
  }
  return {
    mostrar(no) {
      alvo = no;
      return desenhar();
    },
    esconder: () => (alvo = null),
    atualizar: () => desenhar(),
  };
}

function numero(icon, rotulo, valor, detalhe) {
  return el('div', { class: 'card sd-number' }, el('div', { class: 'eyebrow' }, icone(icon), rotulo), el('div', { class: 'sd-value' }, el('b', { class: 'mono' }, valor), detalhe ? el('small', {}, detalhe) : null));
}

function agentes(a) {
  const n = a.numeros;
  const numeros = el(
    'div',
    { class: 'sd-numbers' },
    numero('bolt', 'Eventos', num(n.eventos), `${num(n.porMinuto)}/min`),
    numero('key', 'Ferramentas', num(n.ferramentas), `${num(n.ferramentasUnicas)} únicas`),
    numero('subagent', 'Subagentes', num(n.subagentes), '+1 principal'),
    numero('layers', 'Compactações', num(n.compactacoes)),
    numero('alert', 'Erros', num(n.erros)),
    numero('timer', 'Duração', `${num(n.duracaoMin)} min`, n.rodando ? 'rodando' : null),
  );

  const maior = Math.max(1, ...a.ferramentas.map((f) => f.n));
  const ferramentas = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icone('key'), 'Ferramentas mais usadas'), el('small', {}, `${num(n.ferramentasUnicas)} no total`)),
    a.ferramentas.length
      ? el(
          'ul',
          { class: 'sd-bars' },
          ...a.ferramentas.map((f) => {
            const barra = el('span', { class: 'sd-full' });
            barra.style.setProperty('--w', `${(f.n / maior) * 100}%`);
            return el('li', {}, el('span', { class: 'sd-ico' }, icone(ICONE_DA_FERRAMENTA[f.nome] ?? 'key')), el('span', { class: 'mono sd-name' }, f.nome), el('span', { class: 'sd-rail' }, barra), el('span', { class: 'mono sd-n' }, num(f.n)));
          }),
        )
      : el('p', { class: 'sd-none' }, 'Nenhuma ferramenta ainda.'),
  );

  const t = a.tarefas;
  const tarefas = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icone('tasks'), 'Progresso das tarefas')),
    t && t.total ? progresso(t) : el('p', { class: 'sd-none' }, 'Sem plano nesta sessão.'),
  );

  const k = a.tokens;
  const fluxo = el(
    'section',
    { class: 'card sd-block' },
    el('header', {}, el('div', { class: 'eyebrow' }, icone('coins'), 'Fluxo de tokens'), k ? el('small', {}, `${tokens(k.total)} no total`) : null),
    k && k.total ? fluxoDeTokens(k) : el('p', { class: 'sd-none' }, 'Nenhum uso medido ainda.'),
  );

  const arvore = el(
    'section',
    { class: 'sd-tree' },
    el('div', { class: 'eyebrow' }, icone('robot'), `Agentes · ${a.agentes.length}`),
    ...a.agentes.map((g) => no(g)),
  );

  return [numeros, el('div', { class: 'sd-two' }, ferramentas, tarefas), fluxo, arvore];
}

function progresso(t) {
  const pct = Math.round((t.feitos / t.total) * 100);
  const r = 26;
  const volta = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'sd-ring');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, dash] of [['sd-bg', `${volta} ${volta}`], ['sd-front', `${(volta * pct) / 100} ${volta}`]]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [k, v] of Object.entries({ cx: 32, cy: 32, r, class: cls, 'stroke-dasharray': dash, transform: 'rotate(-90 32 32)' })) c.setAttribute(k, String(v));
    svg.append(c);
  }
  const andamento = t.passos.filter((p) => p.estado === 'in_progress').length;
  const pendentes = t.passos.filter((p) => p.estado === 'pending').length;
  const mostrar = 4;
  const passos = t.passos.slice(0, mostrar);
  const resto = t.passos.length - passos.length;
  return el(
    'div',
    { class: 'sd-tasks' },
    el('div', { class: 'sd-ring-box' }, svg, el('b', { class: 'sd-pct' }, `${pct}%`), el('div', {}, el('b', {}, `${t.feitos} / ${t.total} concluídas`), t.atual ? el('div', { class: 'sd-current' }, `Atual: ${t.atual}`) : null)),
    el(
      'div',
      { class: 'sd-legend' },
      el('span', { class: 'sd-l-ok' }, 'Concluídas ', el('b', {}, num(t.feitos))),
      el('span', { class: 'sd-l-progress' }, 'Em andamento ', el('b', {}, num(andamento))),
      el('span', { class: 'sd-l-pending' }, 'Pendentes ', el('b', {}, num(pendentes))),
    ),
    el(
      'ul',
      { class: 'sd-steps' },
      ...passos.map((p, i) =>
        el('li', { class: `sd-p-${p.estado}` }, icone(p.estado === 'completed' ? 'done' : 'circle'), p.estado === 'in_progress' ? (p.textoAtivo ?? p.texto) : p.texto, i === passos.length - 1 && resto > 0 ? el('span', { class: 'sd-more' }, ` · +${resto}`) : null),
      ),
    ),
  );
}

function fluxoDeTokens(k) {
  const partes = [
    ['read', 'Cache lido', k.cacheLido],
    ['written', 'Cache gravado', k.cacheGravado],
    ['input', 'Entrada', k.entrada],
    ['output', 'Saída', k.saida],
  ];
  const barra = el('div', { class: 'sd-flow', role: 'img', 'aria-label': partes.map(([, r, v]) => `${r} ${tokens(v)}`).join(', ') });
  for (const [cls, , v] of partes) {
    if (!v) continue;
    const p = el('span', { class: `sd-f-${cls}` });
    p.style.setProperty('--w', `${(v / k.total) * 100}%`);
    barra.append(p);
  }
  return el('div', {}, barra, el('div', { class: 'sd-legend' }, ...partes.map(([cls, r, v]) => el('span', { class: `sd-f-${cls}` }, `${r} `, el('b', { class: 'mono' }, tokens(v))))));
}

function no(g) {
  const fim = g.fim ? Date.parse(g.fim) : Date.now();
  const sub =
    g.tipo === 'principal'
      ? [nomeDoModelo(g.modelo), g.turnos !== null ? `${num(g.turnos)} turno${g.turnos === 1 ? '' : 's'}` : null]
      : [g.tarefa, duracao(fim - Date.parse(g.inicio))];
  return el(
    'div',
    { class: `card sd-node${g.tipo === 'subagente' ? ' sd-sub' : ''}` },
    el('span', { class: 'sd-ico' }, icone(g.tipo === 'principal' ? 'robot' : 'subagent')),
    el('div', { class: 'sd-text' }, el('b', {}, g.nome), el('small', {}, sub.filter(Boolean).join(' · '))),
    el('span', { class: 'mono sd-cost' }, g.custoUsd === null ? '' : usd(g.custoUsd)),
    pilulaDeStatus(g.status),
  );
}

// ---------- Aba Conversa (C5) ----------

const ESTADO_DA_FERRAMENTA = {
  ok: { rotulo: 'OK', icone: 'ok' },
  erro: { rotulo: 'Erro', icone: 'error' },
  permissao: { rotulo: 'Aguardando permissão', icone: 'hourglass' },
  rodando: { rotulo: 'Rodando', icone: 'clock' },
};

function abaConversa(ctx, base) {
  let alvo = null;
  let agente = null;
  const abertas = new Set();
  const fechadas = new Set();
  const lista = el('div', { class: 'card sd-messages' });
  const seletor = el('select', { class: 'sd-select', 'aria-label': 'Agente' });
  const contagem = el('span', { class: 'sd-pill mono' });
  seletor.addEventListener('change', () => {
    agente = seletor.value;
    desenhar();
  });
  const barra = el('div', { class: 'sd-bar' }, seletor, contagem, el('button', { type: 'button', class: 'btn outline', aoClicar: () => desenhar() }, icone('refresh'), 'Atualizar'));

  async function desenhar() {
    try {
      const c = await ctx.ler(`${base}/conversation${agente ? `?agent=${encodeURIComponent(agente)}` : ''}`);
      agente = c.agente;
      seletor.replaceChildren(...c.agentes.map((a) => el('option', { value: a.id, selected: a.id === c.agente }, a.nome)));
      contagem.replaceChildren(icone('conversation'), `${num(c.total)} mensage${c.total === 1 ? 'm' : 'ns'}`);
      lista.replaceChildren(...(c.mensagens.length ? c.mensagens.map(mensagem) : [el('p', { class: 'sd-none' }, 'Nenhuma mensagem deste agente ainda.')]));
      alvo?.replaceChildren(barra, lista);
    } catch (e) {
      if (e.name === 'AbortError') return;
      alvo?.replaceChildren(erro({ titulo: 'Não deu para ler a conversa', texto: e.message, tentar: desenhar }));
    }
  }

  function mensagem(m) {
    const voce = m.papel === 'voce';
    return el(
      'article',
      { class: `sd-msg ${voce ? 'sd-you' : 'sd-assistant'}` },
      el('span', { class: 'sd-avatar' }, icone(voce ? 'person' : 'robot')),
      el(
        'div',
        { class: 'sd-content' },
        el(
          'header',
          {},
          el('b', {}, voce ? 'Você' : 'Assistente'),
          m.modelo ? el('span', { class: 'sd-pill mono' }, nomeDoModelo(m.modelo)) : null,
          m.tokens ? el('span', { class: 'sd-pill mono', title: 'Tokens de entrada e de saída' }, `↓ ${tokens(m.tokens.entrada)} · ↑ ${tokens(m.tokens.saida)}`) : null,
          el('time', { class: 'mono', datetime: m.em }, HORA.format(new Date(m.em))),
        ),
        m.texto ? el('p', {}, ...comCodigo(m.texto)) : null,
        ...m.ferramentas.map(ferramenta),
      ),
    );
  }

  function ferramenta(f) {
    // A que pede permissão já vem aberta, como no C5; a pessoa pode fechar.
    const aberta = abertas.has(f.id) || (f.estado === 'permissao' && !fechadas.has(f.id));
    const est = ESTADO_DA_FERRAMENTA[f.estado];
    const detalhe = el(
      'div',
      { class: 'sd-tool-body', hidden: !aberta },
      f.entrada ? el('div', {}, el('div', { class: 'eyebrow' }, 'Entrada'), el('pre', { class: 'mono sd-pre' }, f.entrada)) : null,
      f.resultado ? el('div', {}, el('div', { class: 'eyebrow' }, 'Resultado'), el('pre', { class: 'mono sd-pre' }, f.resultado)) : null,
      !f.entrada && !f.resultado ? el('p', { class: 'sd-none' }, 'Sem entrada nem resultado guardados.') : null,
    );
    const cabeca = el(
      'button',
      { type: 'button', class: 'sd-tool-head', 'aria-expanded': aberta ? 'true' : 'false' },
      icone(aberta ? 'chevron-down' : 'chevron-right'),
      el('b', { class: 'mono sd-name' }, f.nome),
      el('span', { class: 'mono sd-summary' }, f.resumo ?? ''),
      est ? el('span', { class: `mono sd-situation sd-e-${TOOL_STATE_CLASS[f.estado] ?? f.estado}` }, icone(est.icone), est.rotulo) : null,
    );
    cabeca.addEventListener('click', () => {
      const abrir = detalhe.hidden;
      detalhe.hidden = !abrir;
      cabeca.setAttribute('aria-expanded', abrir ? 'true' : 'false');
      cabeca.firstChild.replaceWith(icone(abrir ? 'chevron-down' : 'chevron-right'));
      (abrir ? abertas : fechadas).add(f.id);
      (abrir ? fechadas : abertas).delete(f.id);
    });
    return el('div', { class: `sd-tool${f.estado === 'permissao' ? ' sd-asks' : ''}` }, cabeca, detalhe);
  }

  return {
    mostrar(no) {
      alvo = no;
      return desenhar();
    },
    esconder: () => (alvo = null),
    atualizar: () => desenhar(),
  };
}

// ---------- Aba Linha do tempo (C6) ----------

const POR_PAGINA = 50;

function abaTempo(ctx, base, { rotular }) {
  let alvo = null;
  let ultimo = null;
  let quantos = POR_PAGINA;
  const abertos = new Set();
  const filtros = { q: '', de: '', ate: '', status: '', tipo: '', ferramenta: '', agente: '' };

  const busca = el('input', { type: 'search', class: 'sd-field', placeholder: 'Buscar no resumo, ferramenta, conteúdo…', 'aria-label': 'Buscar' });
  const de = el('input', { type: 'datetime-local', class: 'sd-field sd-date', 'aria-label': 'De' });
  const ate = el('input', { type: 'datetime-local', class: 'sd-field sd-date', 'aria-label': 'Até' });
  const selects = {
    status: el('select', { class: 'sd-chip mono', 'aria-label': 'Status' }),
    tipo: el('select', { class: 'sd-chip mono', 'aria-label': 'Tipo de evento' }),
    ferramenta: el('select', { class: 'sd-chip mono', 'aria-label': 'Ferramenta' }),
    agente: el('select', { class: 'sd-chip mono', 'aria-label': 'Agente' }),
  };
  let pausa = null;
  busca.addEventListener('input', () => {
    clearTimeout(pausa);
    pausa = setTimeout(() => ((filtros.q = busca.value.trim()), recomecar()), 250);
  });
  de.addEventListener('change', () => ((filtros.de = de.value), recomecar()));
  ate.addEventListener('change', () => ((filtros.ate = ate.value), recomecar()));
  for (const [k, s] of Object.entries(selects)) s.addEventListener('change', () => ((filtros[k] = s.value), recomecar()));

  const painelDeFiltros = el(
    'section',
    { class: 'card sd-filters' },
    el('div', { class: 'sd-filters-row' }, el('label', { class: 'sd-search' }, icone('filter'), busca), el('label', { class: 'sd-date' }, icone('calendar'), el('span', {}, 'De'), de), el('label', { class: 'sd-date' }, icone('calendar'), el('span', {}, 'Até'), ate)),
    el('div', { class: 'sd-filters-row' }, ...Object.values(selects)),
  );
  const lista = el('div', { class: 'card sd-events' });
  const rodape = el('div', { class: 'sd-footer' });

  function opcoes(sel, rotulo, itens, atual) {
    sel.replaceChildren(el('option', { value: '' }, rotulo), ...itens.map(([v, r]) => el('option', { value: v, selected: v === atual }, r)));
    sel.classList.toggle('on', !!atual);
  }

  function consulta() {
    const p = new URLSearchParams();
    // The filter state keeps its names; the API reads the English parameters.
    for (const [k, nome] of [['q', 'q'], ['status', 'status'], ['tipo', 'type'], ['ferramenta', 'tool'], ['agente', 'agent']]) if (filtros[k]) p.set(nome, filtros[k]);
    // `datetime-local` é a hora do lugar; a API quer ISO em UTC.
    for (const [k, nome] of [['de', 'from'], ['ate', 'to']]) if (filtros[k]) p.set(nome, new Date(filtros[k]).toISOString());
    p.set('limit', String(quantos));
    return `${base}/events?${p}`;
  }

  function recomecar() {
    quantos = POR_PAGINA;
    desenhar();
  }

  async function desenhar() {
    try {
      const r = await ctx.ler(consulta());
      ultimo = r;
      rotular(`${num(r.filtrados)}/${num(r.total)}`);
      opcoes(selects.status, 'Status', r.opcoes.status.map((s) => [s, STATUS[s]]), filtros.status);
      opcoes(selects.tipo, 'Tipo de evento', r.opcoes.tipos.map((t) => [t, t]), filtros.tipo);
      opcoes(selects.ferramenta, 'Ferramenta', r.opcoes.ferramentas.map((t) => [t, t]), filtros.ferramenta);
      opcoes(selects.agente, 'Agente', r.opcoes.agentes.map((a) => [a.id, a.nome]), filtros.agente);
      lista.replaceChildren(...(r.itens.length ? r.itens.map(linha) : [el('p', { class: 'sd-none' }, r.total ? 'Nenhum evento com esses filtros.' : 'Nenhum evento ainda.')]));
      rodape.replaceChildren(
        ...[
          r.itens.length ? el('small', {}, `Mostrando ${num(r.itens.length)} de ${num(r.filtrados)}`) : null,
          r.proximo ? el('button', { type: 'button', class: 'btn outline', aoClicar: () => ((quantos += POR_PAGINA), desenhar()) }, 'Carregar mais') : null,
        ].filter(Boolean),
      );
      alvo?.replaceChildren(painelDeFiltros, lista, rodape);
    } catch (e) {
      if (e.name === 'AbortError') return;
      alvo?.replaceChildren(erro({ titulo: 'Não deu para ler a linha do tempo', texto: e.message, tentar: desenhar }));
    }
  }

  function linha(e) {
    const aberto = abertos.has(e.id);
    const dados = el('pre', { class: 'mono sd-pre sd-data', hidden: !aberto }, e.dados ?? 'Sem dados guardados.');
    const cab = el(
      'button',
      { type: 'button', class: 'sd-event-head', 'aria-expanded': aberto ? 'true' : 'false' },
      icone(aberto ? 'chevron-down' : 'chevron-right'),
      el('time', { class: 'mono', datetime: e.em, title: new Date(e.em).toLocaleString('pt-BR') }, ha(e.em)),
      pilulaDeStatus(e.status),
      el('span', { class: 'mono sd-type' }, e.tipo),
      el('span', { class: 'sd-summary' }, e.resumo ?? ''),
      e.ferramenta ? el('span', { class: 'sd-chip mono' }, e.ferramenta) : null,
    );
    cab.addEventListener('click', () => {
      const abrir = dados.hidden;
      dados.hidden = !abrir;
      cab.setAttribute('aria-expanded', abrir ? 'true' : 'false');
      cab.firstChild.replaceWith(icone(abrir ? 'chevron-down' : 'chevron-right'));
      if (abrir) abertos.add(e.id);
      else abertos.delete(e.id);
    });
    return el('div', { class: 'sd-event' }, cab, dados);
  }

  return {
    mostrar(no) {
      alvo = no;
      if (ultimo) alvo.replaceChildren(painelDeFiltros, lista, rodape);
      return desenhar();
    },
    esconder: () => (alvo = null),
    atualizar: () => desenhar(),
  };
}
