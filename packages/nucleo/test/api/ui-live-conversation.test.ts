// A conversa ao vivo da aba Conversa (#414, tela C100), montada no DOM falso com um `ctx` que serve um
// topo fixo e respostas de `GET /api/sessions/<id>/conversation` controladas: a leitura inteira na
// primeira carga e, depois, só o delta por `?after=<cursor>`. Cada cenário nomeia seu critério:
// AC-2 (mensagem/ferramenta nova sem mudança de estado), AC-3 (pede e aplica só o delta), AC-4 (lista
// presa ao fim × rolada para cima com o aviso "N novas mensagens") e AC-5 (a ferramenta muda de estado
// na própria linha, sem redesenhar a lista, e os blocos abertos continuam abertos).
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { ElementoFalso, documentoFalso, instalarDomFalso } from './fake-dom.ts';

instalarDomFalso();

const page = { pathname: '/ui/sessions/c3f09b52-4e10', search: '', hash: '#conversation' };
const setUrl = (url: string) => {
  const u = new URL(url, 'http://127.0.0.1');
  Object.assign(page, { pathname: u.pathname, search: u.search, hash: u.hash });
};
Object.assign(globalThis, {
  location: page,
  history: { replaceState: (_s: unknown, _t: string, url: string) => setUrl(url), pushState: (_s: unknown, _t: string, url: string) => setUrl(url) },
});

// @ts-expect-error: browser module, plain JavaScript
const detail = await import('../../ui/screens/session-detail.js');

const SID = 'c3f09b52-4e10';
const BASE = `/api/sessions/${SID}`;
const nowIso = () => new Date().toISOString();

// A minimal-but-complete head so the top and tabs render without throwing.
const head = () => ({
  session: { id: `${SID}-0000-0000`, title: 'Conversa ao vivo', status: 'active', attention: null, model: 'claude-opus-4-8', startedAt: nowIso(), since: nowIso(), cwd: null, banner: null, identity: null },
  endedAt: null,
  cost: null,
  branch: null,
  machine: null,
  open: null,
  counts: { agents: 1, events: 2 },
});

type Msg = { id: string; role: 'you' | 'assistant'; at: string; text: string | null; model: string | null; tokens: unknown; tools: unknown[] };
const you = (id: string, text: string): Msg => ({ id, role: 'you', at: nowIso(), text, model: null, tokens: null, tools: [] });
const bot = (id: string, text: string | null, tools: unknown[] = []): Msg => ({ id, role: 'assistant', at: nowIso(), text, model: 'claude-opus-4-8', tokens: { input: 2000, output: 260 }, tools });
const bashTool = (id: string, state: string, result: string | null = null) => ({ id, name: 'Bash', summary: 'npm test -- pagamentos', state, input: 'npm test -- pagamentos', result });

// ---------- The fake ctx: records every route, serves head + controlled conversation ----------

function harness(full: { messages: Msg[]; total: number; cursor: string }) {
  const requests: string[] = [];
  const deltas: unknown[] = [];
  const changeHandlers: ((c: unknown[]) => void)[] = [];
  const leave = new AbortController();
  const read = async (route: string) => {
    requests.push(route);
    if (route === BASE) return head();
    if (route.startsWith(`${BASE}/conversation`)) {
      if (route.includes('after=')) return deltas.shift() ?? { messages: [], cursor: full.cursor };
      return { agents: [{ id: 'main', name: 'principal' }], agent: 'main', total: full.total, messages: full.messages, cursor: full.cursor };
    }
    if (route.includes('/messaging')) return { available: false, reason: null, processes: 0 };
    if (route.includes('/transcription')) return {};
    if (route.endsWith('/agents')) return { numbers: { events: 0, perMinute: 0, tools: 0, uniqueTools: 0, subagents: 0, compactions: 0, errors: 0, durationMin: 0, running: false }, tools: [], tasks: null, tokens: null, agents: [] };
    throw Object.assign(new Error(`rota não servida: ${route}`), { name: 'ReadError' });
  };
  const ctx = {
    params: { id: SID },
    signal: leave.signal,
    read,
    write: async () => ({}),
    navigate: () => {},
    counter: () => {},
    title: () => {},
    onChange: (f: (c: unknown[]) => void) => changeHandlers.push(f),
    onRestart: () => {},
    liveState: () => 'live',
  };
  return {
    ctx,
    requests,
    leave,
    queueDelta: (d: unknown) => deltas.push(d),
    fire: () => changeHandlers.forEach((f) => f([{ type: 'activity', key: SID, sessionId: SID, seq: deltas.length }])),
  };
}

// mount wires the live change behind a 400 ms debounce; a fired change settles after it.
const settle = () => new Promise((r) => setTimeout(r, 480));
const msgs = (area: ElementoFalso) => area.querySelector('.sd-messages')!.querySelectorAll('[data-mid]');
const midList = (area: ElementoFalso) => msgs(area).map((n) => n.getAttribute('data-mid'));

describe('Live conversation (#414, C100)', () => {
  let scope: ReturnType<typeof harness> | null = null;
  afterEach(() => {
    scope?.leave.abort();
    scope = null;
    documentoFalso.activeElement = null;
  });

  // Mounts the screen inside a `.cc-main` scroll container and lands on the conversation tab.
  async function mountLive(full: { messages: Msg[]; total: number; cursor: string }) {
    const h = harness(full);
    scope = h;
    const ccMain = new ElementoFalso('div');
    ccMain.setAttribute('class', 'cc-main');
    ccMain.scrollHeight = 1000;
    ccMain.clientHeight = 500;
    const area = new ElementoFalso('main');
    ccMain.append(area);
    await detail.mount(area, h.ctx);
    // Let the first show() + draw() resolve.
    await new Promise((r) => setTimeout(r, 0));
    return { h, area, ccMain };
  }

  test('AC-2 / AC-3: a new block arrives via the delta, without re-reading the whole conversation', async () => {
    const { h, area } = await mountLive({ messages: [you('m1', 'quebre o retry'), bot('m2', 'Rodando a bateria.', [bashTool('t1', 'running')])], total: 2, cursor: 'k0' });
    assert.deepEqual(midList(area), ['m1', 'm2']);
    const before = msgs(area);

    // Um bloco novo (sem nenhuma mudança de estado da sessão): só o delta volta.
    h.queueDelta({ messages: [bot('m3', 'Extraindo o cálculo de juros.', [bashTool('t2', 'ok', 'ok')])], total: 3, cursor: 'k1' });
    h.fire();
    await settle();

    // AC-2: o bloco novo apareceu.
    assert.deepEqual(midList(area), ['m1', 'm2', 'm3']);
    assert.match(area.querySelector('[data-mid="m3"]')!.textContent, /Extraindo o cálculo de juros/);
    // AC-3: pediu só o delta (?after=k0) e não releu a conversa inteira (uma só leitura sem after).
    assert.ok(h.requests.some((r) => r.startsWith(`${BASE}/conversation?after=k0`)), 'pediu o delta com after=k0');
    assert.equal(h.requests.filter((r) => r === `${BASE}/conversation`).length, 1, 'a conversa inteira foi lida uma só vez');
    // AC-3: aplicou só o delta — os nós de m1 e m2 são os mesmos de antes (a lista não foi redesenhada).
    const after = msgs(area);
    assert.equal(after[0], before[0], 'm1 continua o mesmo nó');
    assert.equal(after[1], before[1], 'm2 continua o mesmo nó');
  });

  test('AC-5: the tool goes running to ok on its own line; only that node swaps and the open blocks stay open', async () => {
    const { h, area } = await mountLive({ messages: [you('m1', 'roda os testes'), bot('m2', 'Toca a bateria de pagamentos.', [bashTool('t1', 'running')])], total: 2, cursor: 'k0' });
    const m1Before = area.querySelector('[data-mid="m1"]');
    // A pessoa abre o bloco de atividade de m2 (a dobra "1 ação").
    const fold = area.querySelector('[data-mid="m2"]')!.querySelector('.sd-activity-head')!;
    fold.click();
    assert.equal(area.querySelector('[data-mid="m2"]')!.querySelector('.sd-activity-head')!.getAttribute('aria-expanded'), 'true');
    assert.match(area.querySelector('[data-mid="m2"]')!.textContent, /Rodando/);

    // O resultado chega: a mesma ferramenta (mesmo message.id e tool.id) volta como ok.
    h.queueDelta({ messages: [bot('m2', 'Toca a bateria de pagamentos.', [bashTool('t1', 'ok', '3 passaram')])], total: 2, cursor: 'k1' });
    h.fire();
    await settle();

    // AC-5: a linha agora diz OK, e não Rodando.
    const m2 = area.querySelector('[data-mid="m2"]')!;
    assert.match(m2.textContent, /OK/);
    assert.doesNotMatch(m2.textContent, /Rodando/);
    // AC-5: só aquele nó trocou — m1 é o mesmo nó (a lista não foi redesenhada por inteiro).
    assert.equal(area.querySelector('[data-mid="m1"]'), m1Before, 'm1 continua o mesmo nó');
    // AC-5: o bloco que a pessoa abriu continua aberto.
    assert.equal(m2.querySelector('.sd-activity-head')!.getAttribute('aria-expanded'), 'true', 'a dobra continua aberta');
  });

  test('AC-4: stuck to the bottom follows; scrolled up it holds position and shows the "N novas mensagens" pill, which lands at the bottom', async () => {
    const { h, area, ccMain } = await mountLive({ messages: [you('m1', 'começa'), bot('m2', 'ok, começando.')], total: 2, cursor: 'k0' });
    // Presa ao fim: ao abrir, a lista desceu até o fim.
    assert.equal(ccMain.scrollTop, ccMain.scrollHeight, 'abriu no fim');
    const pill = () => area.querySelector('.sd-newpill')!;
    assert.equal(pill().hidden, true, 'sem aviso no começo');

    // Ainda presa: um bloco novo faz a lista acompanhar (desce junto), sem aviso.
    h.queueDelta({ messages: [bot('m3', 'primeiro passo.')], total: 3, cursor: 'k1' });
    h.fire();
    await settle();
    assert.ok(midList(area).includes('m3'));
    assert.equal(ccMain.scrollTop, ccMain.scrollHeight, 'presa ao fim, acompanhou');
    assert.equal(pill().hidden, true, 'presa ao fim não mostra aviso');

    // A pessoa rola para cima de propósito.
    ccMain.scrollTop = 0;
    ccMain.dispatchEvent({ type: 'scroll' });

    // Chega um bloco novo: a posição se mantém e o aviso aparece com o número exato.
    h.queueDelta({ messages: [bot('m4', 'segundo passo.')], total: 4, cursor: 'k2' });
    h.fire();
    await settle();
    assert.equal(ccMain.scrollTop, 0, 'rolada para cima, a leitura fica onde está');
    assert.equal(pill().hidden, false, 'o aviso apareceu');
    assert.match(pill().textContent, /1 nova mensagem/);

    // Mais dois blocos: o aviso soma (3 novas mensagens).
    h.queueDelta({ messages: [bot('m5', 'terceiro passo.'), bot('m6', 'quarto passo.')], total: 6, cursor: 'k3' });
    h.fire();
    await settle();
    assert.match(pill().textContent, /3 novas mensagens/);
    assert.equal(ccMain.scrollTop, 0, 'ainda não puxou para baixo');

    // Clicar no aviso leva ao fim e o esconde.
    pill().click();
    assert.equal(ccMain.scrollTop, ccMain.scrollHeight, 'o aviso levou ao fim');
    assert.equal(pill().hidden, true, 'o aviso sumiu');
  });
});
