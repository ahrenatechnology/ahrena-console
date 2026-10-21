// Contract test (#61) against the REAL installed `claude` CLI: the inbox line format is undocumented,
// so this proves, for the installed version, what the messaging adapters assume:
//
// 1. a live `claude -p` session writes `sessions/<pid>.json` with `sessionId`, `pid`, `entrypoint`
//    and an absolute `messagingSocketPath` that is a socket of ours;
// 2. one line `{"type":"user","message":{"role":"user","content":…}}` on that socket, with no auth
//    line and the `.key` file unreadable, becomes a new turn; the socket writes nothing back;
// 3. the turn shows in the transcript as a `user` line with `origin.kind: "peer"` and
//    `verifiedPeerPid` equal to the writer's pid, which `TranscriptTurns` reads as "delivered";
// 4. the `sessions/<pid>.json` disappears when the process exits.
//
// Skipped unless AHRENA_CONSOLE_CONTRACT_CLI=1. Runs with a temporary HOME, CLAUDE_CONFIG_DIR and
// XDG_RUNTIME_DIR (so the socket is created in a temporary folder, not in /tmp/cc-socks), a fake
// key and a fake Anthropic API on 127.0.0.1 that echoes: no login, no plan, no real session.
// AHRENA_CONSOLE_CLAUDE_BIN picks another binary (default `claude` on the PATH).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { peerTurnOf } from '../../src/ingest/history/transcript.ts';
import { AuditFile } from '../../src/messaging/adapters/audit-file.ts';
import { SessionsDirectory } from '../../src/messaging/adapters/sessions-dir.ts';
import { SocketInbox } from '../../src/messaging/adapters/socket-inbox.ts';
import { findTranscript, TranscriptTurns } from '../../src/messaging/adapters/transcript-turns.ts';
import { Messaging } from '../../src/messaging/service.ts';

const enabled = process.env.AHRENA_CONSOLE_CONTRACT_CLI === '1';
const CLAUDE = process.env.AHRENA_CONSOLE_CLAUDE_BIN ?? 'claude';

/** A fake Messages API: streams back "echo: <last user text>" and records what it got. */
async function fakeApi(): Promise<{ url: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 10 }));
      }
      const r = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[] };
      const texts = (c: unknown): string[] => (typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text)) : []);
      const last = r.messages.filter((m) => m.role === 'user').flatMap((m) => texts(m.content)).filter((t) => !t.trimStart().startsWith('<system-reminder>')).at(-1) ?? '';
      seen.push(last);
      const ev = (t: string, d: object) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev('message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: r.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
      res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
      res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `echo: ${last.slice(0, 200)}` } }));
      res.write(ev('content_block_stop', { index: 0 }));
      res.write(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
      res.end(ev('message_stop', {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

const waitFor = async <T>(what: string, f: () => T | null | undefined | Promise<T | null | undefined>, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== null && v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('#61/AC-2 contract: the inbox of a real claude CLI session, and the peer turn in its transcript', { skip: !enabled && 'set AHRENA_CONSOLE_CONTRACT_CLI=1 to run against the installed claude CLI', timeout: 120_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'acc-'));
  const home = join(tmp, 'h');
  const config = join(tmp, 'c');
  const runtime = join(tmp, 'r');
  const project = join(tmp, 'p');
  for (const d of [home, config, runtime, project]) mkdirSync(d);
  const api = await fakeApi();
  const child = spawn(CLAUDE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5-5'], {
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TERM: 'dumb',
      CLAUDE_CONFIG_DIR: config,
      XDG_RUNTIME_DIR: runtime,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fake-key-for-the-contract-test',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
  });
  const results: unknown[] = [];
  createInterface({ input: child.stdout! }).on('line', (l) => {
    try {
      const m = JSON.parse(l) as { type?: string };
      if (m.type === 'result') results.push(m);
    } catch {}
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await api.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // A first turn typed "by the person", so the session exists and is idle.
  child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'first, typed' }, parent_tool_use_id: null })}\n`);
  await waitFor(`the first result (stderr: ${stderr.slice(0, 300)})`, () => results.length >= 1);

  // 1. The sessions file.
  const sessionsDir = join(config, 'sessions');
  const file = readdirSync(sessionsDir).find((n) => /^\d+\.json$/.test(n));
  assert.ok(file, `sessions/<pid>.json: ${readdirSync(sessionsDir).join(', ')}`);
  const info = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as Record<string, unknown>;
  t.diagnostic(`sessions file keys: ${Object.keys(info).sort().join(', ')}; entrypoint ${String(info.entrypoint)}, kind ${String(info.kind)}, status ${String(info.status)}`);
  assert.equal(info.pid, child.pid);
  assert.equal(typeof info.sessionId, 'string');
  const socketPath = info.messagingSocketPath as string;
  // SAFETY: only a socket inside our own temporary folder is ever connected to.
  assert.ok(typeof socketPath === 'string' && socketPath.startsWith(`${runtime}/`), `the socket must be under the temporary XDG_RUNTIME_DIR, got ${socketPath}`);
  const sessionId = info.sessionId as string;
  const found = await new SessionsDirectory({ folders: async () => [{ dir: config }] }).find(sessionId);
  assert.deepEqual(found.map((p) => [p.pid, p.socketPath]), [[child.pid, socketPath]]);

  // The token file exists and is made unreadable: delivery must not need it.
  const keys = readdirSync(sessionsDir).filter((n) => n.endsWith('.key'));
  t.diagnostic(`.key files next to it: ${keys.length}`);
  for (const k of keys) chmodSync(join(sessionsDir, k), 0o000);

  // 2 and 3. Through the use case with the real adapters: delivered by the peer turn.
  const text = `from the console contract ${Date.now()}`;
  const audit = join(tmp, 'audit.jsonl');
  const messaging = new Messaging({ live: new SessionsDirectory({ folders: async () => [{ dir: config }] }), inbox: new SocketInbox(), turns: new TranscriptTurns(), audit: new AuditFile(audit), pollMs: 100 });
  const sent = await messaging.send(sessionId, text);
  assert.equal(sent.kind, 'accepted');
  if (sent.kind !== 'accepted') return;
  assert.equal(sent.message.state, 'sending', JSON.stringify(sent.message));
  const settled = await waitFor('the message to settle', () => {
    const m = messaging.message(sessionId, sent.message.messageId);
    return m && m.state !== 'sending' ? m : null;
  }, 70_000);
  t.diagnostic(`message: ${settled.state}, sent ${settled.sentAt}, delivered ${settled.deliveredAt}`);
  assert.equal(settled.state, 'delivered');
  await waitFor('the second result', () => results.length >= 2);
  assert.ok(api.seen.some((s) => s.includes(text)), 'the fake API got the message as a turn');

  // The raw transcript line the confirmation relies on.
  const transcript = await findTranscript(config, sessionId);
  assert.ok(transcript);
  const peer = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => ({ l, turn: peerTurnOf(l) })).filter((x) => x.turn);
  assert.equal(peer.length, 1);
  const line = JSON.parse(peer[0].l) as Record<string, unknown>;
  t.diagnostic(`peer line: isMeta ${String(line.isMeta)}, origin ${JSON.stringify(line.origin)}, turnOrigin ${String(line.turnOrigin)}, promptSource ${String(line.promptSource)}`);
  assert.equal(peer[0].turn!.verifiedPeerPid, process.pid);

  // The socket writes nothing back, not even for an invalid line.
  const reply = await new Promise<string>((resolve, reject) => {
    const c = connect(socketPath, () => c.end('this is not json\n'));
    let got = '';
    c.on('data', (d) => (got += d));
    c.on('close', () => resolve(got));
    c.on('error', reject);
  });
  assert.equal(reply, '');

  // 4. The file goes away with the process.
  child.stdin!.end();
  await exited;
  for (const k of keys) if (existsSync(join(sessionsDir, k))) chmodSync(join(sessionsDir, k), 0o600);
  assert.equal(existsSync(join(sessionsDir, file)), false);
  assert.deepEqual(await new SessionsDirectory({ folders: async () => [{ dir: config }] }).find(sessionId), []);
  messaging.close();
});
