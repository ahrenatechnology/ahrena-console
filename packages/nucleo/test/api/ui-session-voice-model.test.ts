// The voice model download in the compose box (#405, decision 0019 items 4 and 10): the dictation status
// line and the microphone are reused; there is no new component. The core is a scripted fake (`GET
// /api/transcription` answers what the test queues, `POST /api/transcription/model` is recorded), so every
// state of `download` is reachable without a 1.6 GB file.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ElementoFalso, documentoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
Object.assign(globalThis, {
  location: { pathname: '/ui', search: '', hash: '' },
  history: { replaceState() {}, pushState() {} },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  getComputedStyle: () => ({ getPropertyValue: () => '', paddingBottom: '0' }),
});

// @ts-expect-error: browser modules, plain JavaScript
const message = await import('../../ui/screens/session-message.js');
message.timing.pollMs = 10;

type Download = { state: 'idle' | 'downloading' | 'verifying' | 'failed'; receivedBytes: number; totalBytes: number; error?: string };
const TOTAL = 1_624_555_275;
const missing = (download: Download) => ({ version: 1, available: false, reason: 'model_missing', model: 'large-v3-turbo', download });
const idle: Download = { state: 'idle', receivedBytes: 0, totalBytes: TOTAL };
const downloading = (receivedBytes: number): Download => ({ state: 'downloading', receivedBytes, totalBytes: TOTAL });
const ready = { version: 1, available: true, reason: null, model: 'large-v3-turbo' };

let gets: unknown[] = [];
let posts: string[] = [];
let postAnswer: () => unknown = () => ({ version: 1, download: downloading(0) });
/** What the next GETs answer; the last one repeats. */
const script = (...answers: unknown[]) => (gets = [...answers]);
let getCount = 0;

const leaves: AbortController[] = [];
afterEach(() => {
  for (const l of leaves.splice(0)) l.abort();
});
beforeEach(() => {
  message.forgetAvailability();
  documentoFalso.activeElement = null;
  posts = [];
  getCount = 0;
  postAnswer = () => ({ version: 1, download: downloading(0) });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(3);
  }
}
const one = (root: ElementoFalso, selector: string) => root.querySelector(selector);
const disabled = (n: ElementoFalso | null) => !!n && ((n as unknown as { disabled?: boolean }).disabled ?? n.hasAttribute('disabled')) === true;
const statusText = (box: ElementoFalso) => texto(one(box, '.sm-status-slot'));
const click = (n: ElementoFalso | null) => n!.dispatchEvent({ type: 'click' });
const button = (box: ElementoFalso, label: string) => box.querySelectorAll('button').find((b) => texto(b).includes(label)) ?? null;

async function openBox() {
  const leave = new AbortController();
  leaves.push(leave);
  const ctx = {
    params: { id: 's1' },
    read: async (route: string) => {
      if (route.includes('/messaging')) return { available: true, reason: null, processes: 1, entrypoint: 'claude-desktop', remoteControl: false, account: null };
      assert.equal(route, '/api/transcription');
      getCount++;
      const answer = gets.length > 1 ? gets.shift() : gets[0];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    write: async (route: string, _body: unknown, _options?: object) => {
      posts.push(route);
      return postAnswer();
    },
    signal: leave.signal,
    navigate: () => {},
    counter: () => {},
    title: () => {},
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
  };
  const box = message.createComposeBox(ctx, 's1', { voice: { supported: () => true, start: async () => assert.fail('no recording here') } });
  await until(() => !!one(box.node, '.sm-dest') && texto(one(box.node, '.sm-dest')) !== '' && !!one(box.node, '.sm-mic') && statusText(box.node) !== '', 'the box');
  return { node: box.node as ElementoFalso, leave };
}

describe('voice model download in the compose box', () => {
  test('idle: says the model is needed, offers Baixar modelo, and no old CLI hint', async () => {
    script(missing(idle));
    const { node } = await openBox();
    assert.match(statusText(node), /O ditado precisa baixar o modelo de voz \(1,6 GB, uma vez só\)\./);
    assert.ok(button(node, 'Baixar modelo'));
    assert.doesNotMatch(statusText(node), /voice install/);
    assert.equal(getCount, 1, 'idle does not poll');
  });

  test('Baixar modelo POSTs to the model route and shows the progress in pt-BR', async () => {
    script(missing(idle), missing(downloading(412_000_000)));
    const { node } = await openBox();
    click(button(node, 'Baixar modelo'));
    await until(() => /Baixando o modelo de voz: 412 MB de 1,6 GB \(25%\)/.test(statusText(node)), 'the progress line');
    assert.deepEqual(posts, ['/api/transcription/model']);
    assert.equal(button(node, 'Baixar modelo'), null);
  });

  test('downloading: a progress element with accessible value', async () => {
    script(missing(downloading(412_000_000)));
    const { node } = await openBox();
    const bar = one(node, 'progress')!;
    assert.ok(bar);
    assert.equal(bar.getAttribute('role'), 'progressbar');
    assert.equal(bar.getAttribute('aria-valuenow'), '25');
    assert.equal(bar.getAttribute('aria-valuemin'), '0');
    assert.equal(bar.getAttribute('aria-valuemax'), '100');
    assert.ok(bar.getAttribute('aria-label'));
  });

  test('a download already running when the page opens shows its progress at once', async () => {
    script(missing(downloading(812_000_000)));
    const { node } = await openBox();
    assert.match(statusText(node), /Baixando o modelo de voz: 812 MB de 1,6 GB \(50%\)/);
    assert.equal(posts.length, 0);
  });

  test('polls while downloading and verifying, then the mic works without a reload', async () => {
    script(
      missing(downloading(100_000_000)),
      missing(downloading(900_000_000)),
      missing({ state: 'verifying', receivedBytes: TOTAL, totalBytes: TOTAL }),
      ready,
    );
    const { node } = await openBox();
    assert.equal(disabled(one(node, '.sm-mic')), true);
    await until(() => /Conferindo o modelo…/.test(statusText(node)), 'the verifying line');
    assert.equal(one(node, 'progress')?.getAttribute('aria-valuenow') ?? '100', '100');
    await until(() => !disabled(one(node, '.sm-mic')), 'the mic to turn on');
    assert.doesNotMatch(statusText(node), /modelo/);
    assert.equal(button(node, 'Baixar modelo'), null);
  });

  test('polling stops when the state leaves downloading/verifying', async () => {
    script(missing(downloading(1)), ready);
    const { node } = await openBox();
    await until(() => !disabled(one(node, '.sm-mic')), 'the mic');
    const seen = getCount;
    await sleep(80);
    assert.equal(getCount, seen);
  });

  test('polling stops when the compose box is gone', async () => {
    script(missing(downloading(1)));
    const { leave } = await openBox();
    await sleep(40);
    leave.abort();
    await sleep(30);
    const seen = getCount;
    await sleep(80);
    assert.equal(getCount, seen);
  });

  for (const [code, pattern] of [
    ['network_error', /rede/i],
    ['http_error', /rede|servidor/i],
    ['disk_error', /espaço|disco|permissão/i],
    ['checksum_mismatch', /corromp/i],
  ] as const) {
    test(`failed (${code}): a pt-BR message and Tentar de novo, no polling`, async () => {
      script(missing({ state: 'failed', receivedBytes: 10, totalBytes: TOTAL, error: code }));
      const { node } = await openBox();
      assert.match(statusText(node), pattern);
      assert.ok(button(node, 'Tentar de novo'));
      assert.equal(one(node, '.sm-status.sm-fail')?.getAttribute('role'), 'alert');
      const seen = getCount;
      await sleep(60);
      assert.equal(getCount, seen);
    });
  }

  test('Tentar de novo POSTs again and goes back to the progress', async () => {
    script(missing({ state: 'failed', receivedBytes: 500_000_000, totalBytes: TOTAL, error: 'network_error' }), missing(downloading(600_000_000)));
    postAnswer = () => ({ version: 1, download: downloading(500_000_000) });
    const { node } = await openBox();
    click(button(node, 'Tentar de novo'));
    await until(() => /Baixando o modelo de voz: \d+ MB de 1,6 GB/.test(statusText(node)), 'the progress line');
    assert.deepEqual(posts, ['/api/transcription/model']);
    assert.equal(button(node, 'Tentar de novo'), null);
  });

  test('a POST the core refuses shows a failure with Tentar de novo', async () => {
    script(missing(idle));
    postAnswer = () => {
      throw Object.assign(new Error('O núcleo não respondeu'), { status: 0 });
    };
    const { node } = await openBox();
    click(button(node, 'Baixar modelo'));
    await until(() => !!button(node, 'Tentar de novo'), 'the retry button');
    assert.match(statusText(node), /rede/i);
  });

  test('a poll that fails mid-download keeps the progress and retries until the core answers', async () => {
    script(missing(downloading(412_000_000)), new Error('down'), new Error('down'), missing(downloading(900_000_000)), ready);
    const { node } = await openBox();
    await until(() => getCount >= 2, 'the failing poll');
    assert.match(statusText(node), /Baixando o modelo de voz: 412 MB/);
    assert.equal(disabled(one(node, '.sm-mic')), true);
    await until(() => !disabled(one(node, '.sm-mic')), 'the mic after the core came back');
  });

  test('busy lines are no live region; start and end are announced once, failure is an alert', async () => {
    script(missing(downloading(1_000_000)), missing({ state: 'verifying', receivedBytes: TOTAL, totalBytes: TOTAL }), ready);
    const { node } = await openBox();
    assert.equal(one(node, '.sm-status')?.getAttribute('role'), null);
    assert.match(texto(one(node, '.sm-sr')), /Baixando o modelo de voz\./);
    await until(() => /Conferindo/.test(statusText(node)), 'verifying');
    assert.equal(one(node, '.sm-status')?.getAttribute('role'), null);
    await until(() => /pronto/.test(texto(one(node, '.sm-sr'))), 'the end announcement');
  });

  test('an unknown error code gets a neutral message; the idle line uses the core\'s total', async () => {
    script(missing({ state: 'failed', receivedBytes: 0, totalBytes: TOTAL, error: 'weird' }));
    const a = await openBox();
    assert.match(statusText(a.node), /Não deu para baixar o modelo de voz/);
    assert.doesNotMatch(statusText(a.node), /rede/i);
    script(missing({ state: 'idle', receivedBytes: 0, totalBytes: 3_100_000_000 }));
    const b = await openBox();
    assert.match(statusText(b.node), /\(3,1 GB, uma vez só\)/);
  });

  test('model missing (idle): the mic is enabled, explains itself, and a click starts the download', async () => {
    script(missing(idle), missing(downloading(0)));
    const { node } = await openBox();
    const mic = one(node, '.sm-mic');
    assert.equal(disabled(mic), false);
    assert.match(String(mic!.getAttribute('title')), /Clique para baixar o modelo de voz e ativar o ditado/);
    click(mic);
    await until(() => posts.length === 1, 'the POST');
    assert.deepEqual(posts, ['/api/transcription/model']);
  });

  test('model failed: the mic click retries; Ctrl+Espaço does the same', async () => {
    script(missing({ state: 'failed', receivedBytes: 5, totalBytes: TOTAL, error: 'network_error' }), missing(downloading(5)));
    const { node } = await openBox();
    assert.equal(disabled(one(node, '.sm-mic')), false);
    one(node, 'textarea')!.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'Space', key: ' ', preventDefault() {} });
    await until(() => posts.length === 1, 'the POST from the shortcut');
  });

  test('while downloading, a mic click or the shortcut starts nothing new', async () => {
    script(missing(downloading(1_000_000)));
    const { node } = await openBox();
    click(one(node, '.sm-mic'));
    one(node, 'textarea')!.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'Space', key: ' ', preventDefault() {} });
    await sleep(40);
    assert.equal(posts.length, 0);
  });
});
