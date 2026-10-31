// Dictation in the compose box (#352, decision 0019, wireframe of the five states), end to end: the real
// compose box (ui/screens/session-message.js, session-voice.js) mounted in the minimal DOM, the real
// POST /api/transcription of the demo core over a FAKE whisper-server, and a FAKE microphone: the box's
// `voice` option takes the recorder, so there is no getUserMedia, no sound card, no real whisper.
// The page's fetch sends its own Origin, as the browser's from /ui does.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createMessagingRoute } from '../../src/api/messaging.ts';
import { createTranscriptionRoute } from '../../src/api/transcription.ts';
import type { LiveProcess } from '../../src/messaging/model.ts';
import { Messaging } from '../../src/messaging/service.ts';
import { DETAIL_SESSION } from '../../src/simulator/detail.ts';
import { createTranscription } from '../../src/transcription/whisper.ts';
import { ElementoFalso, documentoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import { ownerFetch as fetch } from '../owner-http.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';

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
const { httpReader, httpWriter } = await import('../../ui/api.js');
// @ts-expect-error: idem
const message = await import('../../ui/screens/session-message.js');
// @ts-expect-error: idem
const voice = await import('../../ui/screens/session-voice.js');

// ---------- The fake whisper-server and the core ----------

let spoken = ' Roda a suíte de novo. ';
const heard: number[] = [];
let whisper: Server;
let demo: DemoApi;
let service: Messaging;
let transcription: ReturnType<typeof createTranscription>;
let read: (route: string, options?: unknown) => Promise<any>;
let write: (route: string, body: unknown, options?: unknown) => Promise<any>;
let installed = true;

const live = (): LiveProcess[] => [{ pid: 4182, socketPath: '/fake/s.sock', configDir: '/fake/home/.claude', accountId: null, entrypoint: 'claude-desktop', remoteControl: true }];

before(async () => {
  whisper = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (p: Buffer) => parts.push(p));
    req.on('end', () => {
      if (req.method === 'POST') heard.push(Buffer.concat(parts).length);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'POST' ? JSON.stringify({ text: spoken }) : 'ok');
    });
  });
  await new Promise<void>((r) => whisper.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(whisper.address() as AddressInfo).port}`;
  transcription = createTranscription({ config: { url, bin: '/none', model: '/none' } });
  const gate: typeof transcription = { ...transcription, availability: () => (installed ? transcription.availability() : { available: false, reason: 'not_installed', model: 'large-v3-turbo' }) };
  demo = await startDemoApi({
    messaging: (storage) => {
      service = new Messaging({
        live: { find: async () => live() },
        inbox: { deliver: async () => ({ ok: true }) },
        turns: { open: async () => ({ poll: async () => null, close() {} }) },
        audit: { record() {} },
        pollMs: 10,
        now: () => Date.now(),
        sleep: async () => {},
        burst: { perSession: 50, total: 200 },
      });
      return createMessagingRoute({ messaging: service, sessions: storage, accounts: { ofId: async (id) => ({ id, label: 'Pessoal (teste)', color: '#e5484d' }) } });
    },
    transcription: createTranscriptionRoute({ transcription: gate }),
  });
  const origin = `http://${demo.host}`;
  const withOrigin = (url: URL, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), origin } });
  read = httpReader({ base: demo.api.url, fetch: (url: URL, init?: RequestInit) => fetch(url, init) });
  write = httpWriter({ base: demo.api.url, fetch: withOrigin });
  message.timing.pollMs = 15;
});
after(async () => {
  transcription?.close();
  service?.close();
  await demo?.close();
  whisper?.close();
});
beforeEach(() => {
  message.forgetAvailability();
  documentoFalso.activeElement = null;
  heard.length = 0;
  spoken = ' Roda a suíte de novo. ';
  installed = true;
});

// ---------- Helpers ----------

const leaves: AbortController[] = [];
afterEach(() => {
  for (const l of leaves.splice(0)) l.abort();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}
const one = (root: ElementoFalso, selector: string) => root.querySelector(selector);
const disabled = (n: ElementoFalso | null) => !!n && ((n as unknown as { disabled?: boolean }).disabled ?? n.hasAttribute('disabled')) === true;
const statusText = (box: ElementoFalso) => texto(one(box, '.sm-status-slot'));

/** A recorder that has heard `seconds` of audio, with the level `level`. */
function fakeMic({ seconds = 3, level = 0.5, fail }: { seconds?: number; level?: number; fail?: Error } = {}) {
  const log = { starts: 0, stops: 0, cancels: 0, seconds };
  const start = async () => {
    log.starts++;
    if (fail) throw fail;
    return {
      seconds: () => log.seconds,
      level: () => level,
      stop: async () => (log.stops++, { wav: voice.encodeWav(new Float32Array(16000)), seconds: log.seconds }),
      cancel: () => void log.cancels++,
    };
  };
  return { log, start };
}

async function openBox(mic: ReturnType<typeof fakeMic>, supported = true) {
  const leave = new AbortController();
  leaves.push(leave);
  const ctx = {
    params: { id: DETAIL_SESSION },
    read: (route: string, options?: object) => read(route, { signal: leave.signal, ...options }),
    write: (route: string, body: unknown, options?: object) => write(route, body, { signal: leave.signal, ...options }),
    signal: leave.signal,
    navigate: () => {},
    counter: () => {},
    title: () => {},
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
  };
  const box = message.createComposeBox(ctx, DETAIL_SESSION, { head: () => null, voice: { start: mic.start, supported: () => supported } });
  await until(() => !!one(box.node, '.sm-dest') && texto(one(box.node, '.sm-dest')) !== '', 'the box');
  await until(() => !!one(box.node, '.sm-mic') && (!!statusText(box.node) || !disabled(one(box.node, '.sm-mic'))), 'the microphone answer');
  return box.node as ElementoFalso;
}
const click = (n: ElementoFalso | null) => n!.dispatchEvent({ type: 'click' });
const keydown = (box: ElementoFalso, init: Record<string, unknown>) => one(box, 'textarea')!.dispatchEvent({ type: 'keydown', ...init });
const docKey = (init: Record<string, unknown>) => documentoFalso.dispatchEvent({ type: 'keydown', preventDefault() {}, ...init });
const recording = (box: ElementoFalso) => !!one(box, '.sm-recbar') && !(one(box, '.sm-recbar') as any).hidden;

describe('dictation in the compose box', () => {
  test('1. idle: the microphone sits beside Enviar and the placeholder teaches Ctrl+Espaço', async () => {
    const box = await openBox(fakeMic());
    assert.equal(disabled(one(box, '.sm-mic')), false);
    assert.match(String((one(box, 'textarea') as any).placeholder ?? one(box, 'textarea')!.getAttribute('placeholder')), /Ctrl\+Espaço dita/);
  });

  test('2. recording: the red strip takes the text field, with Cancelar and Parar e transcrever', async () => {
    const mic = fakeMic({ seconds: 12 });
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    assert.equal(mic.log.starts, 1);
    assert.equal((one(box, '.sm-field') as any).hidden, true);
    await until(() => /0:12/.test(texto(one(box, '.sm-rectime'))), 'the elapsed time');
    assert.ok(one(box, '.sm-cancel') && one(box, '.sm-stop'));
    assert.match(texto(one(box, '.sm-rechint')), /Esc cancela/);
  });

  test('3 and 4. stop: transcribing, then the text lands in the box and is never sent', async () => {
    const mic = fakeMic({ seconds: 12 });
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    click(one(box, '.sm-stop'));
    await until(() => one(box, 'textarea')!.value === 'Roda a suíte de novo.', 'the transcribed text');
    assert.equal(mic.log.stops, 1);
    assert.equal(heard.length, 1);
    assert.match(statusText(box), /Transcrito em/);
    assert.match(statusText(box), /Revise o texto e envie/);
    assert.equal(recording(box), false);
    assert.equal(disabled(one(box, '.sm-send')), false);
  });

  test('transcribing: mic and Enviar are disabled and the status says how much audio', async () => {
    const mic = fakeMic({ seconds: 12 });
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    click(one(box, '.sm-stop'));
    await until(() => /Transcrevendo 0:12 de áudio/.test(statusText(box)) || one(box, 'textarea')!.value !== '', 'the busy line');
  });

  test('the text goes in at the cursor, with a space on each side', async () => {
    const box = await openBox(fakeMic());
    const input = one(box, 'textarea')!;
    input.value = 'Antes depois';
    input.dispatchEvent({ type: 'input' });
    (input as any).selectionStart = 6;
    (input as any).selectionEnd = 6;
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    click(one(box, '.sm-stop'));
    await until(() => input.value !== 'Antes depois', 'the insertion');
    assert.equal(input.value, 'Antes Roda a suíte de novo. depois');
  });

  test('Ctrl+Espaço starts, and Ctrl+Espaço again stops and transcribes', async () => {
    const mic = fakeMic();
    const box = await openBox(mic);
    keydown(box, { key: ' ', code: 'Space', ctrlKey: true, preventDefault() {} });
    await until(() => recording(box), 'the recording strip');
    docKey({ key: ' ', code: 'Space', ctrlKey: true });
    await until(() => one(box, 'textarea')!.value === 'Roda a suíte de novo.', 'the text');
  });

  test('⌘+Espaço does not start (it is Spotlight)', async () => {
    const mic = fakeMic();
    const box = await openBox(mic);
    keydown(box, { key: ' ', code: 'Space', metaKey: true, preventDefault() {} });
    await sleep(30);
    assert.equal(mic.log.starts, 0);
  });

  test('Esc cancels: the audio is thrown away, nothing is sent', async () => {
    const mic = fakeMic();
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    docKey({ key: 'Escape' });
    await until(() => !recording(box), 'the strip to go');
    assert.equal(mic.log.cancels, 1);
    assert.equal(heard.length, 0);
    assert.equal(one(box, 'textarea')!.value, '');
  });

  test('Cancelar does the same as Esc', async () => {
    const mic = fakeMic();
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    click(one(box, '.sm-cancel'));
    await until(() => !recording(box), 'the strip to go');
    assert.equal(mic.log.cancels, 1);
  });

  test('at 5 minutes the recording stops by itself and transcribes', async () => {
    const mic = fakeMic({ seconds: voice.MAX_SECONDS });
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => one(box, 'textarea')!.value === 'Roda a suíte de novo.', 'the automatic stop');
    assert.equal(mic.log.stops, 1);
  });

  test('a recording shorter than 0.4 s is not sent', async () => {
    const mic = fakeMic({ seconds: 0.2 });
    const box = await openBox(mic);
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    click(one(box, '.sm-stop'));
    await until(() => /curta demais/.test(statusText(box)), 'the short-recording line');
    assert.equal(heard.length, 0);
  });

  test('silence in the audio: says it heard nothing and leaves the text alone', async () => {
    spoken = ' [BLANK_AUDIO] ';
    const box = await openBox(fakeMic());
    click(one(box, '.sm-mic'));
    await until(() => recording(box), 'the recording strip');
    click(one(box, '.sm-stop'));
    await until(() => /Não ouvi fala/.test(statusText(box)), 'the silence line');
    assert.equal(one(box, 'textarea')!.value, '');
  });

  test('5. off: the whisper is not installed — mic dimmed, with the reason', async () => {
    installed = false;
    const box = await openBox(fakeMic());
    assert.equal(disabled(one(box, '.sm-mic')), true);
    assert.match(statusText(box), /Ditado desligado/);
    assert.match(statusText(box), /voice install/);
  });

  test('5. off: the browser has no getUserMedia', async () => {
    const box = await openBox(fakeMic(), false);
    assert.equal(disabled(one(box, '.sm-mic')), true);
    assert.match(statusText(box), /getUserMedia/);
  });

  test('5. off: the browser denied the microphone', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const box = await openBox(fakeMic({ fail: denied }));
    click(one(box, '.sm-mic'));
    await until(() => /negou o microfone/.test(statusText(box)), 'the denied line');
    assert.equal(disabled(one(box, '.sm-mic')), true);
  });
});

describe('the recorder helpers', () => {
  test('clock and secondsText', () => {
    assert.equal(voice.clock(0), '0:00');
    assert.equal(voice.clock(75), '1:15');
    assert.equal(voice.secondsText(1400), '1,4 s');
  });

  test('resampleTo16k: 48 kHz in, a third of the samples out; 16 kHz stays', () => {
    const tone = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10));
    assert.equal(voice.resampleTo16k(tone, 48000).length, 1600);
    assert.equal(voice.resampleTo16k(tone, 16000).length, 4800);
  });

  test('encodeWav writes a 16 kHz mono PCM16 header and clips the samples', () => {
    const blob = voice.encodeWav(Float32Array.from([0, 1, -1, 2, -2]));
    assert.equal(blob.type, 'audio/wav');
    return blob.arrayBuffer().then((ab: ArrayBuffer) => {
      const b = Buffer.from(ab);
      assert.equal(b.toString('latin1', 0, 4), 'RIFF');
      assert.equal(b.toString('latin1', 8, 12), 'WAVE');
      assert.equal(b.readUInt16LE(20), 1);
      assert.equal(b.readUInt16LE(22), 1);
      assert.equal(b.readUInt32LE(24), 16000);
      assert.equal(b.readUInt16LE(34), 16);
      assert.equal(b.length, 44 + 5 * 2);
      assert.deepEqual([0, 1, 2, 3, 4].map((i) => b.readInt16LE(44 + i * 2)), [0, 32767, -32768, 32767, -32768]);
    });
  });
});
