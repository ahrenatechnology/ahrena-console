// Dictation (#352, decision 0019) on the core: the route over a FAKE whisper-server (a local HTTP server
// that answers like whisper.cpp's `/inference`), the same-origin gate, the limits and the config.
// Never a real whisper, never a real microphone: the audio here is a few bytes of silence.
import assert from 'node:assert/strict';
import { createServer, request as rawRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { MAX_AUDIO_BYTES, createTranscriptionRoute, isExpectedWav } from '../../src/api/transcription.ts';
import { cleanText, createTranscription, resolveWhisperConfig } from '../../src/transcription/whisper.ts';
import { ownerRequest } from '../owner-http.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';

/** A 16 kHz mono PCM16 WAV of `samples` zeros. */
function wav(samples = 1600, { rate = 16000, channels = 1, bits = 16 } = {}): Buffer {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------- The fake whisper-server ----------

const inferences: { contentType: string; body: Buffer }[] = [];
let reply: { status: number; json: unknown; delayMs: number } = { status: 200, json: { text: ' Olá mundo. ' }, delayMs: 0 };
let fake: Server;
let fakeUrl = '';

before(async () => {
  fake = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (p: Buffer) => parts.push(p));
    req.on('end', () => {
      if (req.method === 'GET') return void res.end('ok');
      inferences.push({ contentType: String(req.headers['content-type']), body: Buffer.concat(parts) });
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json));
      }, reply.delayMs);
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
after(() => void fake?.close());

// ---------- The core ----------

interface Boot {
  demo: DemoApi;
  close: () => Promise<void>;
}
async function boot(config: { url?: string; bin?: string; model?: string }, logs: string[] = []): Promise<Boot> {
  const transcription = createTranscription({ config: { url: config.url ?? null, bin: config.bin ?? '/none/whisper-server', model: config.model ?? '/none/model.bin' }, log: (m) => logs.push(m) });
  const demo = await startDemoApi({ transcription: createTranscriptionRoute({ transcription, log: (m) => logs.push(m) }) });
  return {
    demo,
    close: async () => {
      transcription.close();
      await demo.close();
    },
  };
}

interface Reply {
  status: number;
  body: any;
}
function call(demo: DemoApi, method: string, headers: Record<string, string | undefined>, body?: Buffer, { owner = true }: { owner?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const send = owner ? ownerRequest : rawRequest;
    const req = send(`${demo.api.url}/api/transcription`, { method, headers: h }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (p: Buffer) => parts.push(p));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (b: Boot, audio: Buffer, extra: Record<string, string | undefined> = {}) =>
  call(b.demo, 'POST', { origin: `http://${b.demo.host}`, 'content-type': 'audio/wav', ...extra }, audio);

describe('GET /api/transcription', () => {
  test('says the whisper is not installed, and why', async () => {
    const b = await boot({});
    try {
      const r = await call(b.demo, 'GET', {});
      assert.deepEqual(r.body, { version: 1, available: false, reason: 'not_installed', model: 'large-v3-turbo' });
    } finally {
      await b.close();
    }
  });

  test('says it is available when it points to a running whisper-server', async () => {
    const b = await boot({ url: fakeUrl });
    try {
      const r = await call(b.demo, 'GET', {});
      assert.equal(r.body.available, true);
      assert.equal(r.body.reason, null);
    } finally {
      await b.close();
    }
  });
});

describe('POST /api/transcription', () => {
  test('sends the WAV to the whisper-server and returns the cleaned text', async () => {
    const b = await boot({ url: fakeUrl });
    inferences.length = 0;
    reply = { status: 200, json: { text: ' [BLANK_AUDIO] Olá   mundo. ' }, delayMs: 0 };
    try {
      const r = await post(b, wav());
      assert.equal(r.status, 200);
      assert.equal(r.body.text, 'Olá mundo.');
      assert.equal(typeof r.body.durationMs, 'number');
      assert.equal(inferences.length, 1);
      assert.match(inferences[0].contentType, /^multipart\/form-data/);
      const sent = inferences[0].body.toString('latin1');
      assert.match(sent, /name="language"\r\n\r\npt/);
      assert.match(sent, /name="response_format"\r\n\r\njson/);
      assert.ok(sent.includes('RIFF'), 'the audio went through');
    } finally {
      await b.close();
    }
  });

  test('refuses a request without Origin: only the /ui may send audio', async () => {
    const b = await boot({ url: fakeUrl });
    try {
      const r = await call(b.demo, 'POST', { 'content-type': 'audio/wav' }, wav());
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, 'ui_only');
    } finally {
      await b.close();
    }
  });

  test('refuses the /ui itself without the owner proof, and the whisper is never asked (#302)', async () => {
    const b = await boot({ url: fakeUrl });
    inferences.length = 0;
    try {
      const r = await call(b.demo, 'POST', { origin: `http://${b.demo.host}`, 'content-type': 'audio/wav' }, wav(), { owner: false });
      assert.equal(r.status, 403);
      const status = await call(b.demo, 'GET', { origin: `http://${b.demo.host}` }, undefined, { owner: false });
      assert.equal(status.status, 403);
      assert.equal(inferences.length, 0);
    } finally {
      await b.close();
    }
  });

  test('refuses a foreign Origin', async () => {
    const b = await boot({ url: fakeUrl });
    try {
      const r = await post(b, wav(), { origin: 'http://evil.example' });
      assert.equal(r.status, 403);
    } finally {
      await b.close();
    }
  });

  test('415 when it is not audio/wav', async () => {
    const b = await boot({ url: fakeUrl });
    try {
      const r = await post(b, wav(), { 'content-type': 'application/json' });
      assert.equal(r.status, 415);
    } finally {
      await b.close();
    }
  });

  test('503 when the whisper is not installed', async () => {
    const b = await boot({});
    try {
      const r = await post(b, wav());
      assert.equal(r.status, 503);
      assert.equal(r.body.reason, 'unavailable');
    } finally {
      await b.close();
    }
  });

  test('400 when the audio is not a 16 kHz mono 16-bit WAV', async () => {
    const b = await boot({ url: fakeUrl });
    try {
      assert.equal((await post(b, Buffer.from('not a wav at all, just text'))).status, 400);
      assert.equal((await post(b, wav(1600, { rate: 44100 }))).status, 400);
      assert.equal((await post(b, wav(1600, { channels: 2 }))).status, 400);
    } finally {
      await b.close();
    }
  });

  test('413 above the limit, and the whisper is never asked', async () => {
    const b = await boot({ url: fakeUrl });
    inferences.length = 0;
    try {
      const r = await post(b, Buffer.alloc(MAX_AUDIO_BYTES + 1));
      assert.equal(r.status, 413);
      assert.equal(inferences.length, 0);
    } finally {
      await b.close();
    }
  });

  test('409 while another transcription is running', async () => {
    const b = await boot({ url: fakeUrl });
    reply = { status: 200, json: { text: 'um' }, delayMs: 150 };
    try {
      const first = post(b, wav());
      await new Promise((r) => setTimeout(r, 40));
      const second = await post(b, wav());
      assert.equal(second.status, 409);
      assert.equal((await first).status, 200);
    } finally {
      reply = { status: 200, json: { text: ' Olá mundo. ' }, delayMs: 0 };
      await b.close();
    }
  });

  test('502 when the whisper-server fails, without the audio or the text in the log', async () => {
    const logs: string[] = [];
    const b = await boot({ url: fakeUrl }, logs);
    reply = { status: 500, json: { error: 'boom' }, delayMs: 0 };
    try {
      const r = await post(b, wav());
      assert.equal(r.status, 502);
      assert.equal(r.body.reason, 'failed');
      assert.ok(logs.every((l) => !l.includes('RIFF')));
    } finally {
      reply = { status: 200, json: { text: ' Olá mundo. ' }, delayMs: 0 };
      await b.close();
    }
  });
});

describe('the transcription building blocks', () => {
  test('isExpectedWav reads the header', () => {
    assert.equal(isExpectedWav(wav()), true);
    assert.equal(isExpectedWav(wav(10, { bits: 8 })), false);
    assert.equal(isExpectedWav(Buffer.alloc(10)), false);
  });

  test('cleanText drops the markers whisper prints for silence', () => {
    assert.equal(cleanText(' [BLANK_AUDIO] '), '');
    assert.equal(cleanText('  Oi,\n tudo   bem? [MUSIC]'), 'Oi, tudo bem?');
    assert.equal(cleanText(undefined), '');
  });

  test('resolveWhisperConfig: defaults under the console home, overridden by the environment', () => {
    const d = resolveWhisperConfig('/home/x/.ahrena-console', {});
    assert.equal(d.url, null);
    assert.match(d.bin, /\/home\/x\/\.ahrena-console\/voice\/bin\/whisper-server$/);
    assert.match(d.model, /\/voice\/models\/ggml-large-v3-turbo\.bin$/);
    const e = resolveWhisperConfig('/home/x/.ahrena-console', { AHRENA_CONSOLE_WHISPER_BIN: '/a/b', AHRENA_CONSOLE_WHISPER_MODEL: '/a/m.bin' });
    assert.equal(e.bin, '/a/b');
    assert.equal(e.model, '/a/m.bin');
    assert.equal(resolveWhisperConfig('/h', { AHRENA_CONSOLE_WHISPER_URL: 'http://127.0.0.1:9000/' }).url, 'http://127.0.0.1:9000/');
  });
});
