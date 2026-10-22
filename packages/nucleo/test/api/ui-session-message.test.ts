// Sending a message to a live session from the /ui (#61, wireframes C51 to C53), end to end: the real
// screens (ui/screens/session-detail.js, session-message.js, sessions.js, dashboard.js) mounted in the
// minimal DOM, reading and writing the real local API of the demo over HTTP, with the real messaging
// service behind the routes. Only the ports of the service are doubles: no socket, no real session,
// no ~/.claude. The POST goes out with the page's own Origin, as the browser's fetch from /ui sends it.
//
// Scenarios, each naming its criterion: #61/AC-1 (sending a message to a live session works end to
// end, as the approved wireframes describe) and #61/AC-2 (automated tests cover the behaviour).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createMessagingRoute } from '../../src/api/messaging.ts';
import { UI_FOLDER } from '../../src/api/ui.ts';
import type { LiveProcess } from '../../src/messaging/model.ts';
import type { DeliveryResult } from '../../src/messaging/ports.ts';
import { Messaging } from '../../src/messaging/service.ts';
import { DETAIL_SESSION } from '../../src/simulator/detail.ts';
import { ElementoFalso, documentoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';

instalarDomFalso();

// ---------- The page around the screens: location, history, the observers the screens use ----------

const page = { pathname: '/ui', search: '', hash: '' };
const setUrl = (url: string) => {
  const u = new URL(url, 'http://127.0.0.1');
  Object.assign(page, { pathname: u.pathname, search: u.search, hash: u.hash });
};
Object.assign(globalThis, {
  location: page,
  history: { replaceState: (_s: unknown, _t: string, url: string) => setUrl(url), pushState: (_s: unknown, _t: string, url: string) => setUrl(url) },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  getComputedStyle: () => ({ getPropertyValue: () => '', paddingBottom: '0' }),
});

// @ts-expect-error: browser modules, plain JavaScript
const { httpReader, httpWriter } = await import('../../ui/api.js');
// @ts-expect-error: idem
const message = await import('../../ui/screens/session-message.js');
// @ts-expect-error: idem
const detail = await import('../../ui/screens/session-detail.js');
// @ts-expect-error: idem
const sessions = await import('../../ui/screens/sessions.js');
// @ts-expect-error: idem
const dashboard = await import('../../ui/screens/dashboard.js');

// ---------- The core: the demo, with the messaging service over doubles of its ports ----------

/** How each session's live processes behave in a scenario. */
interface Plan {
  processes: number;
  remoteControl?: boolean;
  entrypoint?: string;
  accountId?: string | null;
  deliver?: DeliveryResult;
  confirm?: boolean;
}
const plans = new Map<string, Plan>();
/** What reached a "socket": the text the person typed, and nothing else. */
const delivered: { socketPath: string; text: string }[] = [];
/** Every request the screens made, to prove what goes out and how often. */
const requests: { method: string; path: string; body: string | null }[] = [];
let skew = 0;

const live = (sessionId: string): LiveProcess[] => {
  const p = plans.get(sessionId);
  if (!p) return [];
  return Array.from({ length: p.processes }, (_, i) => ({
    pid: 4182 + i,
    socketPath: `/fake/${sessionId}-${i}.sock`,
    configDir: '/fake/home/.claude-team',
    accountId: p.accountId ?? null,
    entrypoint: p.entrypoint ?? 'claude-desktop',
    remoteControl: p.remoteControl ?? true,
  }));
};

let demo: DemoApi;
let service: Messaging;
let read: (route: string, options?: unknown) => Promise<any>;
let write: (route: string, body: unknown, options?: unknown) => Promise<any>;

before(async () => {
  demo = await startDemoApi({
    messaging: (storage) => {
      service = new Messaging({
        live: { find: async (id) => live(id) },
        inbox: {
          async deliver(socketPath, text) {
            delivered.push({ socketPath, text });
            const id = socketPath.replace(/^\/fake\//, '').replace(/-\d+\.sock$/, '');
            return plans.get(id)?.deliver ?? { ok: true };
          },
        },
        turns: { open: async (_p, sessionId) => ({ poll: async () => (plans.get(sessionId)?.confirm ? Date.now() + skew : null), close() {} }) },
        audit: { record() {} },
        pollMs: 10,
        // The 60 s window passes in a few milliseconds: each wait moves the clock 10 s.
        now: () => Date.now() + skew,
        sleep: async (ms) => void ((skew += ms * 1000), await new Promise((r) => setTimeout(r, 1))),
        burst: { perSession: 50, total: 200 },
      });
      return createMessagingRoute({ messaging: service, sessions: storage, accounts: { ofId: async (id) => ({ id, label: 'Pessoal (teste)', color: '#e5484d' }) } });
    },
  });
  const origin = `http://${demo.host}`;
  // The browser's fetch from /ui sends the page's Origin: the core's same-origin exception wants it.
  const recording = (withOrigin: boolean) => async (url: URL, init: RequestInit = {}) => {
    requests.push({ method: init.method ?? 'GET', path: `${url.pathname}${url.search}`, body: typeof init.body === 'string' ? init.body : null });
    return fetch(url, withOrigin ? { ...init, headers: { ...(init.headers as Record<string, string>), origin } } : init);
  };
  read = httpReader({ base: demo.api.url, fetch: recording(false) });
  write = httpWriter({ base: demo.api.url, fetch: recording(true) });
  message.timing.pollMs = 15;
});
after(async () => {
  service?.close();
  await demo?.close();
});
beforeEach(() => {
  plans.clear();
  delivered.length = 0;
  requests.length = 0;
  message.forgetAvailability();
  documentoFalso.activeElement = null;
});

// ---------- Helpers ----------

const leaves: AbortController[] = [];
afterEach(() => {
  for (const l of leaves.splice(0)) l.abort();
});

function context(params: Record<string, string> = {}) {
  const leave = new AbortController();
  leaves.push(leave);
  const navigated: string[] = [];
  const ctx = {
    params,
    read: (route: string, options?: object) => read(route, { signal: leave.signal, ...options }),
    write: (route: string, body: unknown, options?: object) => write(route, body, { signal: leave.signal, ...options }),
    signal: leave.signal,
    navigate: (route: string) => void (navigated.push(route), setUrl(route)),
    counter: () => {},
    title: () => {},
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
  };
  return { ctx, navigated, leave };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const all = (root: ElementoFalso, selector: string) => root.querySelectorAll(selector);
const one = (root: ElementoFalso, selector: string) => root.querySelector(selector);
const disabled = (n: ElementoFalso | null) => !!n && ((n as unknown as { disabled?: boolean }).disabled ?? n.hasAttribute('disabled')) === true;
const buttonNamed = (root: ElementoFalso, name: RegExp) => all(root, 'button').find((b) => name.test(texto(b))) ?? null;
function type(box: ElementoFalso, text: string) {
  const input = one(box, 'textarea')!;
  input.value = text;
  input.dispatchEvent({ type: 'input' });
}
function pressSend(box: ElementoFalso) {
  one(box, 'textarea')!.dispatchEvent({ type: 'keydown', key: 'Enter', metaKey: true });
}

/** The box has its availability: a destination (on) or a reason (off). */
const drawn = (box: ElementoFalso | null) => !!box && (texto(one(box, '.sm-dest')) !== '' || !!one(box, '.sm-status'));

/** The Detail of a session mounted on `url`, and its compose box once it is drawn. */
async function openDetail(id: string, url = `/ui/sessions/${id}#conversation`) {
  setUrl(url);
  const { ctx, navigated } = context({ id });
  const area = new ElementoFalso('main');
  await detail.mount(area, ctx);
  await until(() => drawn(one(area, '.sm-compose')), 'the compose box');
  return { area, box: one(area, '.sm-compose')!, navigated };
}

/** A compose box alone, on a session of the demo with this plan. */
async function openBox(id: string, plan: Plan | null, head: object | null = null) {
  if (plan) plans.set(id, plan);
  const { ctx } = context({ id });
  const box = message.createComposeBox(ctx, id, { head: () => head });
  await until(() => drawn(box.node), 'the availability');
  return box.node as ElementoFalso;
}

// ---------- C51: the box at the foot of the Conversa ----------

describe('#61/AC-1 C51: the compose box at the foot of the Detail\'s Conversa', () => {
  test('a live idle session: destination, the empty text, the note, /compact and /clear off "dependem do mod", Enviar off until there is text', async () => {
    plans.set(DETAIL_SESSION, { processes: 1, remoteControl: true, accountId: 'acc-1' });
    const { area, box } = await openDetail(DETAIL_SESSION);
    await until(() => /processo vivo nesta máquina/.test(texto(box)), 'the destination line');
    const body = one(area, '.sd-body')!;
    assert.equal(body.childNodes.at(-1), box, 'the box is the last thing of the Conversa tab');
    assert.ok(one(body, '.sd-messages'), 'below the conversation');

    const dest = texto(one(box, '.sm-dest'));
    assert.match(dest, /^Para Migração do esquema de pedidos Claude Desktop Pessoal \(teste\) Remote Control ligado processo vivo nesta máquina$/);
    const input = one(box, 'textarea')!;
    assert.match(input.getAttribute('placeholder')!, /^Escreva para a sessão… \((⌘↵|Ctrl↵) envia\)$/);
    assert.match(texto(one(box, '.sm-note')), /^Chega à sessão como mensagem de outra sessão : não aprova permissão, não roda comando e não muda configuração\.$/);
    const commands = all(box, '.sm-cmd');
    assert.deepEqual(commands.map(texto), ['/compact', '/clear'], 'Remote control is not offered when it is already on');
    assert.ok(commands.every(disabled), '/compact and /clear are off: they depend on the mod');
    assert.match(texto(one(box, '.sm-why')), /dependem do mod/);
    const send = one(box, '.sm-send')!;
    assert.match(texto(send), /^Enviar (⌘↵|Ctrl↵)$/);
    assert.ok(disabled(send), 'nothing to send yet');

    type(box, 'sim, roda os testes da fila e me diz quais falharam');
    assert.equal(texto(one(box, '.sm-count')), '51 / 16 KiB');
    assert.ok(!disabled(one(box, '.sm-send')), 'Enviar turns on with text');
  });

  test('the permission variant: Remote Control off shows a disabled "Remote control", and the box warns it does not answer the permission', async () => {
    plans.set(DETAIL_SESSION, { processes: 1, remoteControl: false });
    const { box } = await openDetail(DETAIL_SESSION);
    await until(() => /não responde à permissão/.test(texto(box)), 'the permission warning');
    assert.deepEqual(all(box, '.sm-cmd').map(texto), ['/compact', '/clear', 'Remote control']);
    assert.ok(all(box, '.sm-cmd').every(disabled));
    assert.doesNotMatch(texto(one(box, '.sm-dest')), /Remote Control ligado/);
    const warning = one(box, '.sm-status.sm-wait')!;
    assert.match(texto(warning), /^Esta mensagem não responde à permissão\. Permitir ou negar o npm run migrate continua no Claude Desktop\. A mensagem espera na caixa de entrada da sessão e o Claude lê quando a ferramenta voltar\.$/);
    assert.ok(one(warning, 'code'), 'the command in <code>');
    assert.ok(!disabled(one(box, 'textarea')), 'the box stays on');
  });

  test('"Mandar mensagem" lands here with ?focus=message: the text takes the focus and the query leaves the URL', async () => {
    plans.set(DETAIL_SESSION, { processes: 1 });
    const { box, area } = await openDetail(DETAIL_SESSION, `/ui/sessions/${DETAIL_SESSION}?focus=message#conversation`);
    await until(() => documentoFalso.activeElement === one(box, 'textarea'), 'the focus');
    assert.equal(page.search, '');
    assert.equal(page.hash, '#conversation');
    // A re-draw of the conversation (a live change, Atualizar) does not move the box: the focus stays.
    const reads = requests.filter((r) => r.path.includes('/conversation')).length;
    buttonNamed(one(area, '.sd-bar')!, /Atualizar/)!.click();
    await until(() => requests.filter((r) => r.path.includes('/conversation')).length > reads, 'the re-draw');
    await sleep(30);
    assert.equal(documentoFalso.activeElement, one(box, 'textarea'), 'still focused after the re-draw');
  });
});

// ---------- C52: the states after Enviar ----------

describe('#61/AC-1 C52: the delivery states', () => {
  test('⌘↵ sends exactly the text, in the POST body only; Enviando… locks the box; Entregue às HH:MM empties it and re-reads the conversation', async () => {
    plans.set(DETAIL_SESSION, { processes: 1, confirm: false });
    const { box } = await openDetail(DETAIL_SESSION);
    await until(() => /processo vivo/.test(texto(box)), 'the destination');
    const typed = 'sim, roda os testes da fila e me diz quais falharam';
    type(box, typed);
    pressSend(box);
    await until(() => /Enviando…/.test(texto(box)), 'Enviando…');
    assert.ok(disabled(one(box, 'textarea')), 'the box is locked while sending');
    assert.match(texto(one(box, '.sm-status.sm-busy')), /^Enviando… Entregando na caixa de entrada da sessão\. A caixa fica travada até a resposta do núcleo\.$/);
    assert.equal(one(box, '.sm-send')!.getAttribute('aria-busy'), 'true');
    assert.equal(one(box, 'textarea')!.value, typed, 'the text stays while it is on the way');

    const conversationReads = () => requests.filter((r) => r.path.includes('/conversation')).length;
    const before = conversationReads();
    plans.get(DETAIL_SESSION)!.confirm = true;
    await until(() => /Entregue/.test(texto(box)), 'Entregue');
    assert.match(texto(one(box, '.sm-status.sm-ok')), /^Entregue às \d\d:\d\d\. A sessão começou um turno novo às \d\d:\d\d; a mensagem está na conversa, acima\.$/);
    assert.equal(one(box, 'textarea')!.value, '', 'the text left the box');
    assert.ok(buttonNamed(box, /Ver na conversa/));
    assert.ok(disabled(one(box, '.sm-send')), 'nothing to send again');
    await until(() => conversationReads() > before, 'the conversation re-read');

    const posts = requests.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, `/api/sessions/${DETAIL_SESSION}/messages`, 'no query string');
    assert.deepEqual(JSON.parse(posts[0]!.body!), { text: typed });
    assert.ok(requests.every((r) => !r.path.includes(encodeURIComponent(typed)) && !r.path.includes('roda')), 'the text never goes in a URL');
    assert.deepEqual(delivered.map((d) => d.text), [typed]);
  });

  test('Enviada, sem confirmação: no resend offered, the box is empty', async () => {
    const box = await openBox(DETAIL_SESSION, { processes: 1, confirm: false });
    type(box, 'roda a bateria inteira');
    pressSend(box);
    await until(() => /sem confirmação/.test(texto(box)), 'sem confirmação');
    assert.match(texto(one(box, '.sm-status.sm-wait')), /^Enviada às \d\d:\d\d, sem confirmação\. Em 60 s a sessão não começou um turno novo\. .*Mandar de novo duplica\.$/);
    assert.equal(buttonNamed(box, /Tentar de novo/), null, 'never resend');
    assert.equal(one(box, 'textarea')!.value, '');
    assert.equal(delivered.length, 1);
  });

  test('Não entregue: the reason, the text stays, and Tentar de novo sends it again', async () => {
    const box = await openBox(DETAIL_SESSION, { processes: 1, deliver: { ok: false, reason: 'connection_refused' } });
    type(box, 'sim, roda os testes');
    pressSend(box);
    await until(() => /Não entregue/.test(texto(box)), 'Não entregue');
    assert.match(texto(one(box, '.sm-status.sm-fail')), /^Não entregue\. O processo da sessão recusou a conexão: ele pode ter saído agora\. O texto continua na caixa\.$/);
    assert.equal(one(box, 'textarea')!.value, 'sim, roda os testes');
    const retry = buttonNamed(box, /Tentar de novo/)!;
    assert.ok(retry && !disabled(retry));
    plans.get(DETAIL_SESSION)!.deliver = { ok: true };
    plans.get(DETAIL_SESSION)!.confirm = true;
    retry.click();
    await until(() => /Entregue/.test(texto(box)), 'Entregue after Tentar de novo');
    assert.deepEqual(delivered.map((d) => d.text), ['sim, roda os testes', 'sim, roda os testes']);
  });

  test('409 in flight: the core\'s pt-BR error on screen, and the box follows the message in flight', async () => {
    const box = await openBox(DETAIL_SESSION, { processes: 1, confirm: false });
    // Another tab sent first: the message is in flight when this box sends.
    const other = await write(`/api/sessions/${DETAIL_SESSION}/messages`, { text: 'da outra aba' });
    assert.equal(other.state, 'sending');
    type(box, 'e esta aqui');
    pressSend(box);
    await until(() => /Outra mensagem a caminho/.test(texto(box)), 'the in-flight notice');
    assert.match(texto(box), /Outra mensagem a caminho\. Ainda há uma mensagem a caminho desta sessão\. Espere a confirmação\./);
    assert.ok(disabled(one(box, '.sm-send')), 'Enviar waits for the other message');
    await until(() => !/Outra mensagem a caminho/.test(texto(box)), 'the other message settles');
    // Not this box's message: its text stays, nothing says it was sent, and Enviar is back.
    assert.equal(one(box, 'textarea')!.value, 'e esta aqui');
    assert.doesNotMatch(texto(box), /sem confirmação|Entregue|Não entregue/);
    assert.ok(!disabled(one(box, '.sm-send')));
    assert.deepEqual(delivered.map((d) => d.text), ['da outra aba']);
  });

  test('429 and a core that forgot the message: the pt-BR text on screen, Enviar back after the wait, never a silent resend', async () => {
    const { ctx } = context({ id: 'x' });
    const available = { version: 1, sessionId: 'x', available: true, reason: null, entrypoint: 'cli', remoteControl: false, configDir: '.claude', account: null, processes: 1, inFlight: null, blockedOnPerson: false };
    const fail = (status: number, body: object, msg: string) => Object.assign(new Error(msg), { status, body });
    let answer: () => Promise<unknown> = () => Promise.reject(fail(429, { error: 'Muitas mensagens em pouco tempo. Espere um pouco e tente de novo.', reason: 'rate_limited', retryAfterMs: 120 }, 'Muitas mensagens em pouco tempo. Espere um pouco e tente de novo.'));
    const stub = {
      ...ctx,
      read: async (route: string) => {
        if (route.endsWith('/messaging')) return available;
        throw fail(404, { error: 'não encontrado' }, 'não encontrado');
      },
      write: () => answer(),
    };
    const box = message.createComposeBox(stub, 'x').node as ElementoFalso;
    await until(() => drawn(box), 'the availability');
    assert.match(texto(one(box, '.sm-dest')), /Terminal \.claude processo vivo nesta máquina/);
    type(box, 'oi');
    pressSend(box);
    await until(() => /Espere um pouco/.test(texto(box)), 'the 429 notice');
    assert.match(texto(one(box, '.sm-status')), /Muitas mensagens em pouco tempo\. Espere um pouco e tente de novo\./);
    assert.ok(disabled(one(box, '.sm-send')), 'Enviar waits');
    assert.equal(one(box, 'textarea')!.value, 'oi', 'the text stays');
    await until(() => !disabled(one(box, '.sm-send')), 'Enviar back after the wait');

    answer = async () => ({ messageId: 'm-1', sessionId: 'x', state: 'sending', reason: null });
    pressSend(box);
    await until(() => /Sem notícia da mensagem/.test(texto(box)), 'the forgotten message');
    assert.match(texto(box), /O núcleo reiniciou e não sabe mais dela\. Veja na conversa se ela chegou antes de mandar de novo\./);
    assert.equal(buttonNamed(box, /Tentar de novo/), null);
  });

  test('over 16 KiB: the counter says it and Enviar stays off', async () => {
    const box = await openBox(DETAIL_SESSION, { processes: 1 });
    type(box, 'é'.repeat(8193));
    assert.equal(texto(one(box, '.sm-count')), '16386 / 16 KiB');
    assert.ok(one(box, '.sm-count')!.classList.contains('sm-over'));
    assert.ok(disabled(one(box, '.sm-send')));
    pressSend(box);
    await sleep(30);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
  });
});

// ---------- C53: when the box is off ----------

describe('#61/AC-1 C53: the box off, and why', () => {
  test('no live process: dashed, "Mandar mensagem desligado nesta sessão", the reason and Abrir no Claude Desktop', async () => {
    const { box, area } = await openDetail(DETAIL_SESSION);
    await until(() => /Sem processo vivo/.test(texto(box)), 'the reason');
    assert.ok(box.classList.contains('sm-off'));
    assert.equal(texto(one(box, '.sm-dest')), '', 'no destination');
    assert.equal((one(box, 'textarea') as unknown as { placeholder: string }).placeholder, 'Mandar mensagem desligado nesta sessão');
    assert.ok(disabled(one(box, 'textarea')));
    assert.match(texto(one(box, '.sm-status')), /^Sem processo vivo\. A sessão não está aberta nesta máquina, então não há para onde entregar\. Abra no Claude Desktop; quando o processo voltar, a caixa liga sozinha\.$/);
    assert.equal(all(box, '.sm-cmd').length, 0, 'no commands');
    assert.ok(disabled(one(box, '.sm-send')));
    const open = buttonNamed(box, /Abrir no Claude Desktop/)!;
    assert.ok(open && !disabled(open));
    // The Detail's open action of #285, the same as in the header: its click is the core's open route.
    assert.ok(open.closest('.open-action'), 'the shared open action');
    open.click();
    await until(() => requests.some((r) => r.method === 'POST' && r.path === `/api/sessions/${DETAIL_SESSION}/open`), 'the open route asked');
    assert.ok(one(area, '.sd-band'), 'the Detail keeps its band');
  });

  test('two processes say they are the session: off, and why', async () => {
    const box = await openBox(DETAIL_SESSION, { processes: 2 });
    await until(() => /processos dizem/.test(texto(box)), 'the reason');
    assert.match(texto(one(box, '.sm-status')), /^Dois processos dizem ser esta sessão\. Para não entregar no lugar errado, não mandamos\. Feche um deles e a caixa volta\.$/);
    assert.equal(buttonNamed(box, /Abrir no Claude Desktop/), null);
  });

  test('the reasons of every unavailable case, in pt-BR (other machine: #282)', () => {
    assert.deepEqual(message.unavailableText('other_machine'), { title: 'A sessão roda em outra máquina.', text: 'A entrega pelo núcleo de lá vem no #282; o Remote Control não leva mensagem do console (só uma sessão do Claude logada manda por ele).' });
    assert.equal(message.unavailableText('ambiguous', 3).title, 'Três processos dizem ser esta sessão.');
    assert.match(message.unavailableText('unsupported_platform').text, /Windows/);
    for (const r of ['socket_gone', 'connection_refused', 'timeout', 'socket_error', 'no_live_process', 'ambiguous', 'other_machine', 'unsupported_platform']) assert.doesNotMatch(message.failureText(r), /_/, r);
    assert.deepEqual(['claude-desktop', 'cli', 'sdk-cli', 'something-new', null].map(message.entrypointLabel), ['Claude Desktop', 'Terminal', 'claude -p', 'Claude Code', 'Claude Code']);
  });
});

// ---------- C53: "Mandar mensagem" on the lists, without flooding the core ----------

describe('#61/AC-1 C53: "Mandar mensagem" on Sessões and on the Dashboard', () => {
  test('Sessões: a row with a live process has the button, which opens the Detail on Conversa focused; a completed one says "sem processo vivo" and is never asked', async () => {
    plans.set('sim-panel-current', { processes: 1 });
    setUrl('/ui/sessions');
    // The screen's sheet is already on the page (the fake DOM loads nothing).
    const sheet = new ElementoFalso('link');
    sheet.setAttribute('data-screen', 'sessions');
    Object.assign(sheet, { loaded: Promise.resolve() });
    documentoFalso.head.append(sheet);
    const { ctx, navigated } = context();
    const area = new ElementoFalso('main');
    const cleanup = await sessions.mount(area, ctx);
    try {
      const rows = () => all(area, 'tr.session-row');
      await until(() => all(area, '.sm-row-action').length === 1, 'the action');
      const idOf = (r: ElementoFalso) => decodeURIComponent(one(r, '.nm a')!.getAttribute('href')!.split('/').pop()!);
      const row = (id: string) => rows().find((r) => idOf(r) === id)!;
      assert.ok(one(row('sim-panel-current'), '.sm-row-action'));
      await until(() => texto(one(row(DETAIL_SESSION), 'td.msg')) === 'sem processo vivo', 'the answer for a session without a process');
      const completed = rows().filter((r) => /Concluída/.test(texto(one(r, '.st'))));
      assert.ok(completed.length > 0 && completed.every((r) => texto(one(r, 'td.msg')) === 'sem processo vivo'));
      const asked = requests.filter((r) => r.path.endsWith('/messaging')).map((r) => decodeURIComponent(r.path.split('/')[3]!));
      assert.deepEqual([...asked].sort(), rows().filter((r) => !completed.includes(r)).map(idOf).sort(), 'only the rows on screen that may have a process, once each');

      // A re-draw within the TTL asks nothing again.
      const before = asked.length;
      await sessions.mount(new ElementoFalso('main'), ctx);
      await sleep(30);
      assert.equal(requests.filter((r) => r.path.endsWith('/messaging')).length, before, 'the cache answers');

      one(row('sim-panel-current'), '.sm-row-action')!.click();
      assert.deepEqual(navigated, ['/ui/sessions/sim-panel-current?focus=message#conversation']);
    } finally {
      cleanup?.();
      sheet.remove();
    }
  });

  test('Dashboard: a "precisa de você" card with a live process has "Mandar mensagem" beside "Abrir ›", and the card stays one link', async () => {
    plans.set(DETAIL_SESSION, { processes: 1 });
    setUrl('/ui');
    const { ctx, navigated } = context();
    const area = new ElementoFalso('main');
    const cleanup = await dashboard.mount(area, ctx);
    try {
      await until(() => all(area, '.sm-link-action').length === 1, 'the action');
      const card = all(area, '.mini').find((m) => m.getAttribute('data-session') === DETAIL_SESSION)!;
      assert.equal(one(card, 'a.dash-open-link')!.getAttribute('href'), `/ui/sessions/${DETAIL_SESSION}`);
      assert.equal(all(card, 'a').length, 1, 'one link; the action is a button beside it, not inside it');
      assert.match(texto(one(card, '.foot')), /^Mandar mensagem Abrir ›$/);
      one(card, '.sm-link-action')!.click();
      assert.deepEqual(navigated, [`/ui/sessions/${DETAIL_SESSION}?focus=message#conversation`]);
    } finally {
      cleanup?.();
    }
  });

  test('every request of the screens is to /api of its own core, and the screens put nothing as HTML', () => {
    for (const f of ['screens/session-message.js', 'screens/session-detail.js', 'screens/sessions.js', 'screens/dashboard.js']) {
      assert.doesNotMatch(readFileSync(`${UI_FOLDER}${f}`, 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML/, f);
    }
    const css = readFileSync(`${UI_FOLDER}screens/session-message.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const classes = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const shared = new Set(['card', 'btn', 'outline', 'icon', 'mono']);
    assert.deepEqual([...classes].filter((c) => !c.startsWith('sm-') && !shared.has(c)), [], 'every class of the box is sm-');
  });
});
