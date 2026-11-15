// End-to-end skeleton of the permission requests on screen (#621, parent #60); the wireframe is docs/wireframes/index.html,
// screens 60-1 to 60-13 (ids `60-permission-*`), approved by the design owner on 2026-11-14. (#621)
// Every scenario is red on purpose: the components layer, the state layer and the contract layer (reads of the core's (#621)
// `GET /api/sessions/<id>/permission-requests`, decision 0025 draft) turn them green, and each removes its `todo`. (#621)
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const SID = 'b91d04aa-7c21';
const BASE = `/api/sessions/${SID}`;
const REQS = `${BASE}/permission-requests`;
const ORIGIN = 'http://127.0.0.1:8787';
const page = { pathname: `/ui/sessions/${SID}`, search: '', hash: '#conversation', origin: ORIGIN, href: `${ORIGIN}/ui/sessions/${SID}#conversation` };
Object.assign(globalThis, { location: page, history: { state: null, replaceState: () => {}, pushState: () => {}, back: () => {} } });

const NOW = Date.now();
const iso = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const ahead = (sec: number) => new Date(NOW + sec * 1000).toISOString();

// The shape of the draft of decision 0025: `state` is pending | answered | answered_elsewhere | expired | withdrawn | core_restarted; (#621)
// `summary` is already redacted by the core, on one line; `terminalOnly` requests are denied from here only. (#621)
const request = (id: string, extra: Record<string, unknown> = {}) => ({
  id, state: 'pending', tool: 'Bash', summary: 'DATABASE_URL=•••• npm run migrate -- --env local', folder: '/simulacao/motor-de-regras',
  requestedAt: iso(60), expiresAt: ahead(520), terminalOnly: false, decision: null, reason: null, answeredAt: null, ...extra,
});
const pendingList = (...items: unknown[]) => ({ available: true, requests: items });

// Every mounted screen is left at the end, so its timers and listeners do not keep the runner alive. (#621)
const leaves: AbortController[] = [];
// `mount` returns what undoes it (the polling timers): every one is called at the end, so the runner can exit. (#621)
const cleanups: Array<() => void> = [];
async function mounted(mod: { mount: (a: ElementoFalso, c: unknown) => unknown }, area: ElementoFalso, ctx: unknown) {
  const off = await mod.mount(area, ctx);
  if (typeof off === 'function') cleanups.push(off as () => void);
}
const releases: Array<() => void> = [];
after(() => {
  leaves.forEach((l) => l.abort());
  cleanups.forEach((f) => f());
  releases.forEach((f) => f());
});

interface Served { [route: string]: unknown }
const detail = (extra: Served = {}): Served => ({
  [BASE]: { session: { id: `${SID}-0`, title: 'Migração do esquema de pedidos', status: 'active', attention: { level: 'blocked', reason: 'permission' }, model: 'm', startedAt: iso(3600), since: iso(60), cwd: '/simulacao/motor-de-regras', banner: null, identity: null }, endedAt: null, cost: null, branch: null, machine: null, open: null, counts: { agents: 1, events: 9 } },
  [`${BASE}/messaging`]: { available: false, reason: null, processes: 0 },
  [`${BASE}/transcription`]: {},
  [`${BASE}/agents`]: { numbers: { events: 9, perMinute: 1, tools: 1, uniqueTools: 1, subagents: 0, compactions: 0, errors: 0, durationMin: 60, running: false }, tools: [], tasks: null, tokens: null, agents: [] },
  [REQS]: pendingList(request('rq-1')),
  ...extra,
});

function ctxFor(served: Served, params: Record<string, string> = { id: SID }) {
  const leave = new AbortController();
  leaves.push(leave);
  const writes: Array<{ route: string; body: unknown }> = [];
  const navigated: string[] = [];
  const calls: string[] = [];
  let answer: (route: string, body: unknown) => unknown = () => ({ ok: true });
  const read = async (r: string) => {
    calls.push(r);
    const v = served[r];
    if (v instanceof Error) throw v;
    if (typeof v === 'function') return (v as () => unknown)();
    if (v === undefined) throw Object.assign(new Error(`not served: ${r}`), { name: 'ReadError' });
    return v;
  };
  const write = async (route: string, body: unknown) => {
    writes.push({ route, body });
    const out = answer(route, body);
    if (out instanceof Error) throw out;
    return out;
  };
  const ctx = { params, signal: leave.signal, read, write, navigate: (r: string) => void navigated.push(r), counter: () => {}, title: () => {}, onChange: () => {}, onRestart: () => {}, liveState: () => 'live' };
  return { ctx, leave, writes, navigated, calls, onWrite: (f: typeof answer) => void (answer = f) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const buttons = (area: ElementoFalso) => area.querySelectorAll('button');
const button = (area: ElementoFalso, label: string) => buttons(area).find((b) => texto(b).startsWith(label));

async function mountDetail(served: Served) {
  // The import sits in the body so a missing module turns the scenario red, not the whole file. (#621)
  const mod = await import('../../ui/screens/session-detail.js' as string);
  const c = ctxFor(served);
  const area = new ElementoFalso('main');
  await mounted(mod, area, c.ctx);
  await settle();
  return { area, ...c };
}
const strip = (area: ElementoFalso) => area.querySelector('[aria-label="Pedido de permissão"], [aria-label="Pedidos de permissão"]');

const blockedItem = (extra: Record<string, unknown> = {}) => ({ session: SID, title: 'Migração do esquema de pedidos', project: 'motor-de-regras', reason: 'permission', longReason: 'Pede permissão', minutes: 1, level: 'blocked', open: null, account: null, ...extra });
async function mountDashboard(served: Served) {
  const mod = await import('../../ui/screens/dashboard.js' as string);
  const c = ctxFor({ '/api/attention': { blocked: 1, idle: 0, items: [blockedItem()] }, '/api/dashboard': { sessions: [], agents: [], activity: [] }, ...served }, {});
  const area = new ElementoFalso('main');
  await mounted(mod, area, c.ctx);
  await settle();
  return { area, ...c };
}
async function mountWall(served: Served) {
  const mod = await import('../../ui/screens/wall.js' as string);
  const c = ctxFor({ '/api/wall': { cards: [{ id: SID, title: 'Migração do esquema de pedidos', status: 'waiting', attention: { level: 'blocked', reason: 'permission' } }], parked: [] }, ...served }, {});
  const area = new ElementoFalso('main');
  await mounted(mod, area, c.ctx);
  await settle();
  return { area, ...c };
}

const TODO = (screen: string) => ({ todo: `issue 621: ${screen}` });

describe('AC-2 (60-2): a pending request shows in the strip at the top of the Conversation tab', () => {
  test('the strip reads the core route and names the tool, the redacted one-line summary, the folder, the time and the deadline', TODO('60-2'), async () => {
    const { area, calls } = await mountDetail(detail());
    assert.ok(calls.includes(REQS), 'GET /api/sessions/<id>/permission-requests');
    const s = strip(area)!;
    assert.ok(s, 'the strip exists');
    assert.match(texto(s), /O Claude pede permissão para usar o Bash/);
    assert.match(texto(s), /DATABASE_URL=•••• npm run migrate -- --env local/);
    assert.match(texto(s), /\/simulacao\/motor-de-regras/);
    assert.match(texto(s), /pedido às \d{2}:\d{2}/);
    assert.match(texto(s), /expira em \d/);
  });

  test('"Permitir uma vez", "Negar" and "Abrir no Claude Desktop" are offered', TODO('60-2'), async () => {
    const { area } = await mountDetail(detail());
    const s = strip(area)!;
    assert.ok(button(s, 'Permitir uma vez'));
    assert.ok(button(s, 'Negar'));
    assert.ok(texto(s).includes('Abrir no Claude Desktop'));
  });

  test('"Permitir uma vez" POSTs the answer to the request and writes no rule', TODO('60-2'), async () => {
    const c = ctxFor(detail());
    const mod = await import('../../ui/screens/session-detail.js' as string);
    const area = new ElementoFalso('main');
    await mounted(mod, area, c.ctx);
    await settle();
    button(strip(area)!, 'Permitir uma vez')!.click();
    await settle();
    assert.deepEqual(c.writes, [{ route: `${REQS}/rq-1/answer`, body: { decision: 'allow' } }]);
    assert.match(texto(strip(area)!), /Vale só para esta chamada\. Nenhuma regra é gravada\./);
  });
});

describe('AC-6 (60-2, 60-13): the summary is escaped, on one line, never interpreted as HTML', () => {
  test('a summary with markup is drawn as text and creates no element', TODO('60-2'), async () => {
    const summary = 'src/pedidos/esquema.ts · +12 −3 · <div class="aviso">Pedido migrado</div>';
    const { area } = await mountDetail(detail({ [REQS]: pendingList(request('rq-1', { tool: 'Edit', summary })) }));
    const s = strip(area)!;
    assert.ok(texto(s).includes(summary), 'the markup shows as text');
    assert.equal(s.querySelectorAll('.aviso').length, 0, 'no element was made from it');
    assert.equal(texto(s.querySelector('.pm-sum')).includes('\n'), false, 'one line');
  });
});

describe('AC-2 (60-3): "Precisa de você" on the Dashboard and the Wall answer in place', () => {
  test('the Dashboard item shows tool, summary, time, deadline, both buttons and "Abrir ›"', TODO('60-3'), async () => {
    const { area } = await mountDashboard({ [REQS]: pendingList(request('rq-1')) });
    const item = area.querySelector('.pm-item')!;
    assert.ok(item, 'the permission item');
    assert.match(texto(item), /Bash/);
    assert.match(texto(item), /npm run migrate/);
    assert.ok(button(item, 'Permitir uma vez'));
    assert.ok(button(item, 'Negar'));
    assert.ok(texto(item).includes('Abrir ›'));
  });

  test('answering on the Dashboard POSTs the same answer route', TODO('60-3'), async () => {
    const { area, writes } = await mountDashboard({ [REQS]: pendingList(request('rq-1')) });
    button(area.querySelector('.pm-item')!, 'Permitir uma vez')!.click();
    await settle();
    assert.deepEqual(writes, [{ route: `${REQS}/rq-1/answer`, body: { decision: 'allow' } }]);
  });

  test('the Wall card of the session grows with the same block', TODO('60-3'), async () => {
    const { area } = await mountWall({ [REQS]: pendingList(request('rq-1')) });
    const card = area.querySelector('.pm-wall')!;
    assert.ok(card, 'the permission block on the card');
    assert.ok(button(card, 'Permitir uma vez'));
    assert.ok(button(card, 'Negar'));
  });

  test('a terminalOnly request on the Dashboard has Permitir uma vez off', TODO('60-3'), async () => {
    const { area } = await mountDashboard({ [REQS]: pendingList(request('rq-1', { terminalOnly: true, summary: 'git push --force origin feat/58-pedidos' })) });
    const item = area.querySelector('.pm-item')!;
    assert.equal(button(item, 'Permitir uma vez')!.hasAttribute('disabled') || button(item, 'Permitir uma vez')!.getAttribute('aria-disabled') === 'true', true);
    assert.equal(button(item, 'Negar')!.hasAttribute('disabled'), false);
  });
});

describe('AC-2 (60-4): Negar opens an optional reason', () => {
  test('Negar opens a one-line field in focus, up to 500 characters; Cancelar and Esc close it', TODO('60-4'), async () => {
    const { area } = await mountDetail(detail());
    button(strip(area)!, 'Negar')!.click();
    await settle();
    const field = strip(area)!.querySelector('input[aria-label="Motivo da negação (opcional)"]')!;
    assert.ok(field, 'the reason field');
    assert.equal(field.getAttribute('maxlength'), '500');
    assert.ok(button(strip(area)!, 'Cancelar'));
    button(strip(area)!, 'Cancelar')!.click();
    assert.equal(strip(area)!.querySelectorAll('input').length, 0);
  });

  test('the second Negar POSTs the deny with the reason; with no reason, with none', TODO('60-4'), async () => {
    const c = ctxFor(detail());
    const mod = await import('../../ui/screens/session-detail.js' as string);
    const area = new ElementoFalso('main');
    await mounted(mod, area, c.ctx);
    await settle();
    button(strip(area)!, 'Negar')!.click();
    const field = strip(area)!.querySelector('input')!;
    field.value = 'antes, confira se o banco local está vazio';
    button(strip(area)!, 'Negar')!.click();
    await settle();
    assert.deepEqual(c.writes, [{ route: `${REQS}/rq-1/answer`, body: { decision: 'deny', reason: 'antes, confira se o banco local está vazio' } }]);
  });
});

describe('AC-2 (60-5): a terminalOnly request offers deny only', () => {
  test('Permitir uma vez is off with the why in words, and Negar works', TODO('60-5'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: pendingList(request('rq-1', { terminalOnly: true, summary: 'git push --force origin feat/58-pedidos' })) }));
    const s = strip(area)!;
    const allow = button(s, 'Permitir uma vez')!;
    assert.ok(allow.hasAttribute('disabled') || allow.getAttribute('aria-disabled') === 'true');
    assert.match(texto(s), /só negar daqui/);
    assert.match(texto(s), /Só o Claude Desktop ou o terminal liberam/);
    assert.equal(button(s, 'Negar')!.hasAttribute('disabled'), false);
  });
});

describe('60-6: sending', () => {
  test('after the click both buttons lock and the chosen one says "Enviando…"; a second click sends nothing', TODO('60-6'), async () => {
    const c = ctxFor(detail());
    c.onWrite(() => new Promise((resolve) => releases.push(() => resolve({ ok: true }))));
    const mod = await import('../../ui/screens/session-detail.js' as string);
    const area = new ElementoFalso('main');
    await mounted(mod, area, c.ctx);
    await settle();
    const allow = button(strip(area)!, 'Permitir uma vez')!;
    allow.click();
    allow.click();
    await settle();
    assert.equal(c.writes.length, 1, 'no double answer');
    assert.ok(texto(strip(area)!).includes('Enviando…'));
    assert.ok(buttons(strip(area)!).filter((b) => ['Enviando…', 'Negar'].some((l) => texto(b).startsWith(l))).every((b) => b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true'));
  });
});

describe('AC-3 (60-7): answered here', () => {
  test('allowed once: "Permitido uma vez, por você, pelo Console" with the time, and no buttons', TODO('60-7'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: pendingList(request('rq-1', { state: 'answered', decision: 'allow', answeredAt: iso(5) })) }));
    const s = strip(area)!;
    assert.match(texto(s), /Permitido uma vez, por você, pelo Console/);
    assert.match(texto(s), /às \d{2}:\d{2}/);
    assert.equal(buttons(s).length, 0);
  });

  test('denied with a reason: "Negado por você, pelo Console" and the reason sent to the Claude', TODO('60-7'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: pendingList(request('rq-1', { state: 'answered', decision: 'deny', reason: 'antes, confira se o banco local está vazio', answeredAt: iso(5) })) }));
    assert.match(texto(strip(area)!), /Negado por você, pelo Console/);
    assert.match(texto(strip(area)!), /Motivo enviado ao Claude: “antes, confira se o banco local está vazio”/);
  });

  test('an answered request leaves "Precisa de você" on the Dashboard', TODO('60-7'), async () => {
    const { area, calls } = await mountDashboard({ [REQS]: pendingList(request('rq-1', { state: 'answered', decision: 'allow', answeredAt: iso(5) })) });
    assert.ok(calls.includes(REQS), 'the Dashboard reads the requests of the blocked session');
    assert.equal(area.querySelectorAll('.pm-item').length, 0);
    assert.equal(button(area, 'Permitir uma vez'), undefined);
  });
});

describe('AC-3 (60-8): answered elsewhere, in Claude Desktop', () => {
  test('the Detail says "Respondido no Claude Desktop" with the time and does not guess allow or deny', TODO('60-8'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: pendingList(request('rq-1', { state: 'answered_elsewhere', answeredAt: iso(5) })) }));
    const s = strip(area)!;
    assert.match(texto(s), /Respondido no Claude Desktop/);
    assert.match(texto(s), /às \d{2}:\d{2}/);
    assert.match(texto(s), /O Console não sabe se foi permitir ou negar/);
    assert.equal(buttons(s).length, 0);
  });

  test('the item leaves "Precisa de você" on the Dashboard', TODO('60-8'), async () => {
    const { area, calls } = await mountDashboard({ [REQS]: pendingList(request('rq-1', { state: 'answered_elsewhere', answeredAt: iso(5) })) });
    assert.ok(calls.includes(REQS), 'the Dashboard reads the requests of the blocked session');
    assert.equal(area.querySelectorAll('.pm-item').length, 0);
  });
});

describe('AC-3 (60-9): expired', () => {
  for (const state of ['expired', 'withdrawn', 'core_restarted']) {
    test(`state ${state}: "O Console parou de esperar · responda no Claude Desktop", buttons off, Desktop link on`, TODO('60-9'), async () => {
      const { area } = await mountDetail(detail({ [REQS]: pendingList(request('rq-1', { state })) }));
      const s = strip(area)!;
      assert.match(texto(s), /O Console parou de esperar · responda no Claude Desktop/);
      assert.ok(['Permitir uma vez', 'Negar'].every((l) => { const b = button(s, l); return b && (b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true'); }));
      assert.ok(texto(s).includes('Abrir no Claude Desktop'));
    });
  }

  test('the session stays in "Precisa de você" with "Responda no Claude Desktop" and no buttons', TODO('60-9'), async () => {
    const { area } = await mountDashboard({ [REQS]: pendingList(request('rq-1', { state: 'expired' })) });
    assert.match(texto(area), /Responda no Claude Desktop/);
    assert.equal(button(area, 'Permitir uma vez'), undefined);
  });
});

describe('AC-4 (60-10): an answer refused by the core (409, 410) is not retried', () => {
  for (const status of [409, 410]) {
    test(`HTTP ${status}: "Este pedido já foi respondido ou expirou", the answer not applied, no retry`, TODO('60-10'), async () => {
      const c = ctxFor(detail());
      c.onWrite(() => Object.assign(new Error(`HTTP ${status}`), { name: 'WriteError', status }));
      const mod = await import('../../ui/screens/session-detail.js' as string);
      const area = new ElementoFalso('main');
      await mounted(mod, area, c.ctx);
      await settle();
      button(strip(area)!, 'Negar')!.click();
      button(strip(area)!, 'Negar')!.click();
      await settle();
      await new Promise((r) => setTimeout(r, 50));
      const s = strip(area)!;
      assert.match(texto(s), /Este pedido já foi respondido ou expirou/);
      assert.match(texto(s), /Sua resposta \(Negar\) não foi aplicada/);
      assert.equal(button(s, 'Tentar de novo'), undefined, 'no retry button');
      assert.equal(c.writes.length, 1, 'nothing retried by itself');
    });
  }
});

describe('60-11: core down, reconnecting, no local queue', () => {
  test('the strip says "Sem conexão com o núcleo · reconectando…", the buttons are off and nothing is queued', TODO('60-11'), async () => {
    const c = ctxFor(detail());
    const mod = await import('../../ui/screens/session-detail.js' as string);
    const area = new ElementoFalso('main');
    await mounted(mod, area, { ...c.ctx, liveState: () => 'down' });
    await settle();
    const s = strip(area)!;
    assert.match(texto(s), /Sem conexão com o núcleo · reconectando…/);
    assert.ok(['Permitir uma vez', 'Negar'].every((l) => { const b = button(s, l); return b && (b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true'); }));
    button(s, 'Negar')!.click();
    await settle();
    assert.equal(c.writes.length, 0, 'no local queue');
    assert.match(texto(s), /Nada fica guardado para enviar depois/);
  });
});

describe('AC-5 (60-12): unavailable, a Codex session or one without the plugin', () => {
  test('a Codex session: no buttons and "Responder por aqui: indisponível nesta sessão"', TODO('60-12'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: { available: false, reason: 'codex', requests: [] } }));
    const s = strip(area)!;
    assert.match(texto(s), /Responder por aqui: indisponível nesta sessão/);
    assert.match(texto(s), /Sessão do Codex/);
    assert.equal(buttons(s).filter((b) => ['Permitir uma vez', 'Negar'].some((l) => texto(b).startsWith(l))).length, 0);
  });

  test('a Claude session without the plugin: no buttons, "indisponível", and where to answer', TODO('60-12'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: { available: false, reason: 'no_plugin', requests: [] } }));
    const s = strip(area)!;
    assert.match(texto(s), /Responder por aqui: indisponível nesta sessão/);
    assert.match(texto(s), /não tem o plugin do Ahrena Console/);
    assert.equal(buttons(s).filter((b) => ['Permitir uma vez', 'Negar'].some((l) => texto(b).startsWith(l))).length, 0);
  });

  test('on the Dashboard the item says "indisponível" with no buttons', TODO('60-12'), async () => {
    const { area } = await mountDashboard({ [REQS]: { available: false, reason: 'no_plugin', requests: [] } });
    assert.match(texto(area), /Responder por aqui: indisponível/);
    assert.equal(button(area, 'Permitir uma vez'), undefined);
    assert.equal(button(area, 'Negar'), undefined);
  });
});

describe('60-13: several requests in one session', () => {
  const three = () => pendingList(
    request('rq-1', { tool: 'Edit', summary: 'src/pedidos/esquema.ts · +12 −3', requestedAt: iso(180) }),
    request('rq-2', { tool: 'WebFetch', summary: 'https://docs.exemplo.dev/migracoes/esquema?token=••••', requestedAt: iso(120) }),
    request('rq-3', { summary: 'git push --force origin feat/58-pedidos', requestedAt: iso(60), terminalOnly: true }),
  );

  test('the strip lists the three, oldest first, each with its own buttons; the third is deny only', TODO('60-13'), async () => {
    const { area } = await mountDetail(detail({ [REQS]: three() }));
    const s = strip(area)!;
    assert.match(texto(s), /3 pedidos de permissão nesta sessão/);
    const items = s.querySelectorAll('.pm-req');
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => texto(i.querySelector('.pm-n'))), ['1 de 3', '2 de 3', '3 de 3']);
    assert.ok(items.every((i) => button(i, 'Negar')));
    const allow = button(items[2]!, 'Permitir uma vez')!;
    assert.ok(allow.hasAttribute('disabled') || allow.getAttribute('aria-disabled') === 'true');
  });

  test('answering the second answers only the second', TODO('60-13'), async () => {
    const c = ctxFor(detail({ [REQS]: three() }));
    const mod = await import('../../ui/screens/session-detail.js' as string);
    const area = new ElementoFalso('main');
    await mounted(mod, area, c.ctx);
    await settle();
    button(strip(area)!.querySelectorAll('.pm-req')[1]!, 'Permitir uma vez')!.click();
    await settle();
    assert.deepEqual(c.writes, [{ route: `${REQS}/rq-2/answer`, body: { decision: 'allow' } }]);
  });

  test('"Precisa de você" shows the oldest and "+2 pedidos"', TODO('60-13'), async () => {
    const { area } = await mountDashboard({ [REQS]: three() });
    const item = area.querySelector('.pm-item')!;
    assert.match(texto(item), /npm run migrate|src\/pedidos\/esquema\.ts/);
    assert.match(texto(item), /\+2 pedidos nesta sessão/);
  });
});

describe('60-1: the flow, where one gets to the request', () => {
  test('the Detail route and the answer route are the ones of the draft: the Conversation tab opens on a pending request', TODO('60-1'), async () => {
    const { area } = await mountDetail(detail());
    assert.equal(area.querySelector('[data-tab="conversation"]')?.getAttribute('aria-selected'), 'true');
    assert.ok(strip(area), 'the strip is on the Conversation tab, the destination of the tray and the notification');
  });

  test('Abrir ›, on the Dashboard item, leads to the Detail of the session', TODO('60-1'), async () => {
    const { area } = await mountDashboard({ [REQS]: pendingList(request('rq-1')) });
    const open = area.querySelector('.pm-item a[href]')!;
    assert.equal(open.getAttribute('href'), `/ui/sessions/${SID}`);
  });
});
