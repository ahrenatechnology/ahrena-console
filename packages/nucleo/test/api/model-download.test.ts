// The model download the core owns (#405, decision 0019 item 10): the downloader over a LOCAL http server
// serving a small fake model (URL and digest injected, no network), and the routes that start it and report it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as rawRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createTranscriptionRoute, TRANSCRIPTION_MODEL_ROUTE } from '../../src/api/transcription.ts';
import { downloadModel, ModelDownloadError } from '../../src/transcription/install.ts';
import { createModelDownload, type ModelDownload } from '../../src/transcription/model-download.ts';
import { createTranscription } from '../../src/transcription/whisper.ts';
import { ownerRequest } from '../owner-http.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';

const MODEL = Buffer.from('fake-model-'.repeat(2000)); // 22 000 bytes
const SHA = createHash('sha256').update(MODEL).digest('hex');
const WRONG_SHA = '0'.repeat(64);

// ---------- The fake model host ----------

const seenRanges: (string | undefined)[] = [];
let gate: Promise<void> | null = null; // while set, the body stops after the first half until released
let hits = 0;
let stall = false; // send half the body and never finish
let badRange = false; // answer a Range with a 206 that starts at 0
let host: Server;
let modelUrl = '';

before(async () => {
  host = createServer((req, res) => {
    hits++;
    seenRanges.push(req.headers.range);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const from = m ? Number(m[1]) : 0;
    if (from >= MODEL.length) {
      res.writeHead(416);
      return void res.end();
    }
    const body = MODEL.subarray(from);
    if (badRange && m) {
      res.writeHead(206, { 'content-length': MODEL.length, 'content-range': `bytes 0-${MODEL.length - 1}/${MODEL.length}` });
      return void res.end(MODEL);
    }
    res.writeHead(m ? 206 : 200, { 'content-length': body.length, ...(m && { 'content-range': `bytes ${from}-${MODEL.length - 1}/${MODEL.length}` }) });
    const half = Math.floor(body.length / 2);
    res.write(body.subarray(0, half));
    if (stall) return;
    void (gate ?? Promise.resolve()).then(() => res.end(body.subarray(half)));
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  modelUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/ggml.bin`;
});
after(() => void host?.close());

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ahrena-model-test-'));
}
function hold(): () => void {
  let release!: () => void;
  gate = new Promise<void>((r) => (release = () => ((gate = null), r())));
  return release;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), 'condition not reached in time');
};

describe('downloadModel', () => {
  test('writes through .part, reports progress, checks the digest and renames', async () => {
    const dir = tmp();
    const to = join(dir, 'm', 'ggml.bin');
    try {
      mkdirSync(join(dir, 'm'));
      const seen: { phase: string; receivedBytes: number; totalBytes: number }[] = [];
      const release = hold(); // the body stops half-way until the first bytes were reported
      const done = downloadModel(to, { url: modelUrl, sha256: SHA, onProgress: (p) => seen.push(p) });
      await until(() => seen.some((p) => p.receivedBytes > 0));
      release();
      await done;
      assert.deepEqual(readFileSync(to), MODEL);
      assert.equal(existsSync(`${to}.part`), false);
      assert.ok(seen.length >= 3);
      assert.ok(seen.every((p) => p.totalBytes === MODEL.length || p.phase === 'verifying'));
      assert.ok(seen.some((p) => p.phase === 'downloading' && p.receivedBytes > 0 && p.receivedBytes < MODEL.length), 'progress mid-way');
      assert.deepEqual(seen.at(-1), { phase: 'verifying', receivedBytes: MODEL.length, totalBytes: MODEL.length });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a digest that does not match deletes the file and fails with a code', async () => {
    const dir = tmp();
    const to = join(dir, 'ggml.bin');
    try {
      await assert.rejects(downloadModel(to, { url: modelUrl, sha256: WRONG_SHA }), (e: unknown) => e instanceof ModelDownloadError && e.code === 'checksum_mismatch');
      assert.equal(existsSync(to), false);
      assert.equal(existsSync(`${to}.part`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resumes a .part with a Range request instead of starting over', async () => {
    const dir = tmp();
    const to = join(dir, 'ggml.bin');
    try {
      writeFileSync(`${to}.part`, MODEL.subarray(0, 5000));
      seenRanges.length = 0;
      await downloadModel(to, { url: modelUrl, sha256: SHA });
      assert.deepEqual(seenRanges, ['bytes=5000-']);
      assert.deepEqual(readFileSync(to), MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an HTTP error is http_error and a dead host is network_error; neither leaves a model', async () => {
    const dir = tmp();
    const to = join(dir, 'ggml.bin');
    try {
      const notFound = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
      await assert.rejects(downloadModel(to, { url: modelUrl, sha256: SHA, fetch: notFound }), (e: unknown) => e instanceof ModelDownloadError && e.code === 'http_error');
      const dead = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      await assert.rejects(downloadModel(to, { url: modelUrl, sha256: SHA, fetch: dead }), (e: unknown) => e instanceof ModelDownloadError && e.code === 'network_error');
      assert.equal(existsSync(to), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('downloadModel guards', () => {
  test('a stall (no bytes for stallMs) is network_error and keeps the .part so it can be retried', async () => {
    const dir = tmp();
    const to = join(dir, 'ggml.bin');
    stall = true;
    try {
      await assert.rejects(downloadModel(to, { url: modelUrl, sha256: SHA, stallMs: 150 }), (e: unknown) => e instanceof ModelDownloadError && e.code === 'network_error');
      assert.ok(existsSync(`${to}.part`), 'the partial file stays');
      stall = false;
      await downloadModel(to, { url: modelUrl, sha256: SHA });
      assert.deepEqual(readFileSync(to), MODEL);
    } finally {
      stall = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a 206 whose Content-Range does not start at the .part size restarts the file from zero', async () => {
    const dir = tmp();
    const to = join(dir, 'ggml.bin');
    badRange = true;
    try {
      writeFileSync(`${to}.part`, MODEL.subarray(0, 5000));
      await downloadModel(to, { url: modelUrl, sha256: SHA });
      assert.deepEqual(readFileSync(to), MODEL);
    } finally {
      badRange = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createModelDownload', () => {
  test('a second start while downloading returns the current state and does not fetch again', async () => {
    const dir = tmp();
    const logs: string[] = [];
    const d = createModelDownload({ target: join(dir, 'models', 'ggml.bin'), url: modelUrl, sha256: SHA, log: (m) => logs.push(m) });
    const release = hold();
    hits = 0;
    try {
      assert.equal(d.start().state, 'downloading');
      await until(() => d.status().receivedBytes > 0);
      const again = d.start();
      assert.equal(again.state, 'downloading');
      assert.equal(again.totalBytes, MODEL.length);
      assert.ok(again.receivedBytes > 0 && again.receivedBytes < MODEL.length);
      release();
      await d.settled();
      assert.equal(hits, 1);
      assert.equal(d.status().state, 'idle');
      assert.deepEqual(readFileSync(join(dir, 'models', 'ggml.bin')), MODEL);
      assert.ok(logs.every((l) => !l.includes(modelUrl) && !l.includes(dir)), 'only sizes and codes are logged');
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a mismatch ends failed with a code, deletes the file, and can be started again', async () => {
    const dir = tmp();
    const target = join(dir, 'ggml.bin');
    const bad = createModelDownload({ target, url: modelUrl, sha256: WRONG_SHA });
    try {
      bad.start();
      await bad.settled();
      assert.deepEqual(bad.status(), { state: 'failed', receivedBytes: MODEL.length, totalBytes: MODEL.length, error: 'checksum_mismatch' });
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(`${target}.part`), false);
      assert.equal(bad.start().state, 'downloading', 'a failed download can be retried');
      await bad.settled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- The routes ----------

interface Boot {
  demo: DemoApi;
  dir: string;
  model: string;
  download: ModelDownload;
  close: () => Promise<void>;
}
async function boot({ withBin = true, sha = SHA }: { withBin?: boolean; sha?: string } = {}): Promise<Boot> {
  const dir = tmp();
  const bin = join(dir, 'whisper-server');
  if (withBin) writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const model = join(dir, 'models', 'ggml.bin');
  const transcription = createTranscription({ config: { url: null, bin, model } });
  const download = createModelDownload({ target: model, url: modelUrl, sha256: sha });
  const demo = await startDemoApi({ transcription: createTranscriptionRoute({ transcription, modelDownload: download }) });
  return {
    demo,
    dir,
    model,
    download,
    close: async () => {
      transcription.close();
      await download.settled();
      await demo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function call(b: Boot, method: string, path: string, headers: Record<string, string | undefined>, { owner = true }: { owner?: boolean } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const send = owner ? ownerRequest : rawRequest;
    const req = send(`${b.demo.api.url}${path}`, { method, headers: h }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (p: Buffer) => parts.push(p));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const startModel = (b: Boot, extra: Record<string, string | undefined> = {}) => call(b, 'POST', TRANSCRIPTION_MODEL_ROUTE, { origin: `http://${b.demo.host}`, ...extra });
const status = (b: Boot) => call(b, 'GET', '/api/transcription', {});

describe('GET /api/transcription and POST /api/transcription/model', () => {
  test('model_missing reports an idle download; starting it reports progress, then the model is available', async () => {
    const b = await boot();
    const release = hold();
    try {
      const before = await status(b);
      assert.equal(before.body.reason, 'model_missing');
      assert.deepEqual(before.body.download, { state: 'idle', receivedBytes: 0, totalBytes: 0 });

      const started = await startModel(b);
      assert.equal(started.status, 200);
      assert.equal(started.body.download.state, 'downloading');
      await until(() => b.download.status().receivedBytes > 0);
      const mid = await status(b);
      assert.equal(mid.body.download.state, 'downloading');
      assert.equal(mid.body.download.totalBytes, MODEL.length);
      assert.ok(mid.body.download.receivedBytes > 0);

      const second = await startModel(b);
      assert.equal(second.status, 200);
      assert.equal(second.body.download.state, 'downloading');

      release();
      await b.download.settled();
      const after = await status(b);
      assert.equal(after.body.available, true);
      assert.equal(after.body.reason, null);
      assert.equal('download' in after.body, false);
    } finally {
      release();
      await b.close();
    }
  });

  test('a SHA mismatch reports failed with a code and no stack, and the model stays missing', async () => {
    const b = await boot({ sha: WRONG_SHA });
    try {
      await startModel(b);
      await b.download.settled();
      const r = await status(b);
      assert.equal(r.body.reason, 'model_missing');
      assert.equal(r.body.download.state, 'failed');
      assert.equal(r.body.download.error, 'checksum_mismatch');
      assert.ok(!JSON.stringify(r.body).includes('    at '));
      assert.equal(existsSync(b.model), false);
    } finally {
      await b.close();
    }
  });

  test('a stale failed state is reset to idle in GET and POST once the model file exists', async () => {
    const b = await boot({ sha: WRONG_SHA });
    try {
      await startModel(b);
      await b.download.settled();
      assert.equal((await status(b)).body.download.state, 'failed');
      mkdirSync(join(b.dir, 'models'), { recursive: true });
      writeFileSync(b.model, MODEL);
      const g = await status(b);
      assert.equal(g.body.available, true);
      assert.equal('download' in g.body, false, 'no stale failure on an available model');
      const p = await startModel(b);
      assert.equal(p.status, 200);
      assert.deepEqual(p.body.download, { state: 'idle', receivedBytes: 0, totalBytes: 0 });
    } finally {
      await b.close();
    }
  });

  test('with a running whisper-server (no download manager) POST is 200 idle, not 503', async () => {
    const dir = tmp();
    const transcription = createTranscription({ config: { url: 'http://127.0.0.1:9', bin: join(dir, 'x'), model: join(dir, 'm') } });
    const demo = await startDemoApi({ transcription: createTranscriptionRoute({ transcription }) });
    try {
      const b = { demo } as Boot;
      const r = await startModel(b);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.download, { state: 'idle', receivedBytes: 0, totalBytes: 0 });
    } finally {
      transcription.close();
      await demo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a whisper-server it is 503 not_installed and nothing is fetched', async () => {
    const b = await boot({ withBin: false });
    hits = 0;
    try {
      const r = await startModel(b);
      assert.equal(r.status, 503);
      assert.equal(r.body.reason, 'not_installed');
      assert.equal(hits, 0);
    } finally {
      await b.close();
    }
  });

  test('guards: the owner proof first, then Origin (none or foreign is 403), and only POST', async () => {
    const b = await boot();
    hits = 0;
    try {
      assert.equal((await call(b, 'POST', TRANSCRIPTION_MODEL_ROUTE, { origin: `http://${b.demo.host}` }, { owner: false })).status, 403);
      const noOrigin = await call(b, 'POST', TRANSCRIPTION_MODEL_ROUTE, {});
      assert.equal(noOrigin.status, 403);
      const foreign = await startModel(b, { origin: 'http://evil.example' });
      assert.equal(foreign.status, 403);
      assert.equal((await call(b, 'GET', TRANSCRIPTION_MODEL_ROUTE, {})).status, 405);
      assert.equal((await call(b, 'POST', `${TRANSCRIPTION_MODEL_ROUTE}/`, { origin: `http://${b.demo.host}` })).status, 403, 'only the exact path');
    } finally {
      await b.download.settled();
      await b.close();
    }
  });
});
