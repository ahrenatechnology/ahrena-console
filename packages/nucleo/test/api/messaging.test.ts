import { OWNER_TOKEN, ownerRequest as request } from '../owner-http.ts';
// The messaging routes (#61) end to end on 127.0.0.1, with the real adapters over a temporary
// configuration folder and a FAKE inbox: a Unix-socket server in a temporary folder that, like
// Claude Code 2.1.302, takes one line per message and then writes the peer turn to the session's
// transcript. Never the real ~/.claude, never a real session's socket.
//
// Scenarios, each naming its criterion: #61/AC-1 (send a message to an idle session works end to end)
// and #61/AC-2 (automated tests cover it). `/clear` and `/compact` are out of this slice (the mod).
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { PEER_PREFIX, PEER_SUFFIX } from '../../src/ingest/history/transcript.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createMessagingRoute, MAX_MESSAGE_BODY } from '../../src/api/messaging.ts';
import { AuditFile } from '../../src/messaging/adapters/audit-file.ts';
import { SessionsDirectory } from '../../src/messaging/adapters/sessions-dir.ts';
import { SocketInbox } from '../../src/messaging/adapters/socket-inbox.ts';
import { TranscriptTurns } from '../../src/messaging/adapters/transcript-turns.ts';
import { CONFIRM_WINDOW_MS } from '../../src/messaging/model.ts';
import { Messaging } from '../../src/messaging/service.ts';
import type { Session } from '../../src/model.ts';

const root = mkdtempSync(join(tmpdir(), 'acm-api-'));
const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(root, { recursive: true, force: true });
});

const SECRET = 'mensagem-secreta-do-teste-que-nao-pode-vazar-7f3a';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

let n = 0;
interface Boot {
  url: string;
  host: string;
  sessionId: string;
  configDir: string;
  lines: string[];
  logs: string[];
  auditFile: string;
  dbFile: string;
  close(): Promise<void>;
}

/**
 * A core with one known session. `processes`: how many live processes claim it (each a fake inbox).
 * `confirm`: the fake inbox writes the peer turn to the transcript. `fakeClock`: the window passes at once.
 */
async function boot({ processes = 1, confirm = true, fakeClock = false, remoteControl = true, awaiting = null as Session['awaitingReason'], accountId = null as string | null } = {}): Promise<Boot> {
  const id = ++n;
  const sessionId = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
  const configDir = join(root, `c${id}`);
  const project = join(configDir, 'projects', '-tmp-proj');
  mkdirSync(join(configDir, 'sessions'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${sessionId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u0', timestamp: new Date().toISOString(), sessionId, origin: { kind: 'human' }, message: { role: 'user', content: 'antes' } })}\n`);
  const lines: string[] = [];
  const pids = [process.pid, process.ppid].slice(0, processes);
  for (const pid of pids) {
    const sock = join(root, `i${id}-${pid}.sock`);
    const server = createServer((c) => {
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (d) => (buf += d));
      c.on('end', () => {
        const got = buf.split('\n').filter(Boolean);
        lines.push(...got);
        // Like the CLI: the message becomes a peer user line marked with the writer's pid.
        if (confirm) for (const l of got) appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: `p${lines.length}`, isMeta: true, timestamp: new Date().toISOString(), sessionId, origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: process.pid }, message: { role: 'user', content: `${PEER_PREFIX}${(JSON.parse(l) as { message: { content: string } }).message.content}${PEER_SUFFIX} — not typed by your user.` } })}\n`);
        c.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, r));
    writeFileSync(join(configDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/tmp/proj', kind: 'interactive', entrypoint: 'claude-desktop', status: 'idle', messagingSocketPath: sock, ...(remoteControl ? { bridgeSessionId: 'bridge-secret-value' } : {}) }));
    // The token file next to it, unreadable: the core never opens it.
    const key = join(configDir, 'sessions', `${pid}.${'cd'.repeat(32)}.key`);
    writeFileSync(key, '{"peerToken":"never"}');
    chmodSync(key, 0o000);
  }

  const dbFile = join(root, `db${id}.sqlite`);
  const storage = openSqliteStorage({ path: dbFile });
  const now = new Date().toISOString();
  await storage.putSession({ id: sessionId, name: null, status: 'active', cwd: '/tmp/proj', model: null, source: 'startup', startedAt: now, endedAt: null, awaitingInputSince: awaiting ? now : null, awaitingReason: awaiting, updatedAt: now, accountId: null, accountSource: null, metadata: {} });
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  let skew = 0;
  const clock = () => Date.now() + skew;
  const auditFile = join(root, `data${id}`, 'messaging-audit.jsonl');
  const messaging = new Messaging({
    live: new SessionsDirectory({ folders: async () => [{ dir: configDir, accountId }] }),
    inbox: new SocketInbox(),
    turns: new TranscriptTurns({ now: clock }),
    audit: new AuditFile(auditFile, log),
    pollMs: 20,
    log,
    ...(fakeClock ? { now: clock, sleep: async (ms: number) => void (skew += ms * 200, await new Promise((r) => setTimeout(r, 1))) } : {}),
  });
  const accounts = new Accounts({ storage, file: null });
  const montador = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log, messaging: createMessagingRoute({ messaging, sessions: storage, accounts }) });
  const port = Number(new URL(api.url).port);
  return {
    url: api.url,
    host: `127.0.0.1:${port}`,
    sessionId,
    configDir,
    lines,
    logs,
    auditFile,
    dbFile,
    close: async () => {
      messaging.close();
      for (const pid of pids) chmodSync(join(configDir, 'sessions', `${pid}.${'cd'.repeat(32)}.key`), 0o600);
      await api.close();
      await storage.close();
    },
  };
}

function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; json: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

const ui = (b: Boot) => ({ origin: `http://${b.host}`, 'content-type': 'application/json' });
const post = (b: Boot, text: unknown, headers = ui(b)) => call(b.url, 'POST', `/api/sessions/${b.sessionId}/messages`, headers, JSON.stringify({ text }));

async function untilSettled(b: Boot, messageId: string) {
  for (let i = 0; i < 500; i++) {
    const r = await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messages/${messageId}`, { origin: `http://${b.host}` });
    if (r.json?.state !== 'sending') return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('never settled');
}

describe('#61/AC-1 GET /api/sessions/<id>/messaging', () => {
  test('#61/AC-1 Given one live process with Remote Control, When the box asks, Then it is available with the entrypoint and nothing of the socket', async () => {
    const b = await boot();
    try {
      const r = await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messaging`, { origin: `http://${b.host}` });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { version: 1, sessionId: b.sessionId, available: true, reason: null, entrypoint: 'claude-desktop', remoteControl: true, configDir: basename(b.configDir), account: null, processes: 1, inFlight: null, blockedOnPerson: false });
      assert.equal(/\.sock|bridge-secret|"pid"/.test(r.text), false);
      assert.equal(r.text.includes(root), false);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 Given the live process is in a profile folder with an account, Then the box names the account by its label, never the folder path', async () => {
    const b = await boot({ accountId: 'acc-x/org-x' });
    try {
      const r = await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messaging`);
      assert.equal(r.json.account.id, 'acc-x/org-x');
      assert.match(r.json.account.label, /^conta \d+$/);
      assert.match(r.json.account.color, /^#[0-9a-f]{6}$/i);
      assert.deepEqual(Object.keys(r.json.account).sort(), ['color', 'id', 'label']);
      assert.equal(r.text.includes(root), false);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 Given no live process, two, or another machine, Then it says why', async () => {
    const none = await boot({ processes: 0 });
    const two = await boot({ processes: 2 });
    try {
      const a = await call(none.url, 'GET', `/api/sessions/${none.sessionId}/messaging`);
      assert.equal(a.json.reason, 'no_live_process');
      assert.equal(a.json.available, false);
      const b = await call(two.url, 'GET', `/api/sessions/${two.sessionId}/messaging`);
      assert.deepEqual([b.json.reason, b.json.processes], ['ambiguous', 2]);
      const c = await call(none.url, 'GET', `/api/sessions/some-remote-session/messaging?machine=ws-exemplo`);
      assert.deepEqual([c.status, c.json.reason], [200, 'other_machine']);
      assert.equal((await call(none.url, 'GET', `/api/sessions/${none.sessionId}/messaging?machine=Bad!`)).status, 400);
      assert.equal((await call(none.url, 'GET', `/api/sessions/unknown-session/messaging`)).status, 404);
    } finally {
      await none.close();
      await two.close();
    }
  });

  test('#61/AC-1 Given a session blocked on a permission, Then the box stays on and says so', async () => {
    const b = await boot({ awaiting: 'notification' });
    try {
      const r = await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messaging`);
      assert.deepEqual([r.json.available, r.json.blockedOnPerson], [true, true]);
    } finally {
      await b.close();
    }
  });
});

describe('#61/AC-1 POST /api/sessions/<id>/messages', () => {
  test('#61/AC-1 Given an idle live session, When the person sends from the /ui, Then it is sending and becomes delivered when the session starts the turn', async () => {
    const b = await boot();
    try {
      const r = await post(b, SECRET);
      assert.equal(r.status, 202);
      assert.equal(r.json.state, 'sending');
      assert.equal(typeof r.json.messageId, 'string');
      const inFlight = await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messaging`);
      const settled = await untilSettled(b, r.json.messageId);
      assert.equal(settled.status, 200);
      assert.equal(settled.json.state, 'delivered');
      assert.ok(settled.json.deliveredAt >= settled.json.sentAt);
      assert.deepEqual(b.lines, [JSON.stringify({ type: 'user', message: { role: 'user', content: SECRET } })]);
      // The box was told a message was on its way, then it is free again.
      assert.ok([null, r.json.messageId].includes(inFlight.json.inFlight));
      assert.equal((await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messaging`)).json.inFlight, null);

      // #61/AC-2: an audit line when the socket took it and one when it settled, with the hash,
      // and the text in no log, audit, answer or database.
      const audit = readFileSync(b.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(audit, [
        { at: settled.json.sentAt, sessionId: b.sessionId, messageId: r.json.messageId, mechanism: 'inbox', outcome: 'sent', reason: null, textSha256: sha(SECRET) },
        { at: settled.json.settledAt, sessionId: b.sessionId, messageId: r.json.messageId, mechanism: 'inbox', outcome: 'delivered', reason: null, textSha256: sha(SECRET) },
      ]);
      const everything = [b.logs.join('\n'), readFileSync(b.auditFile, 'utf8'), r.text, settled.text];
      for (const blob of everything) assert.equal(blob.includes(SECRET), false);
      await b.close();
      for (const f of [b.dbFile, `${b.dbFile}-wal`]) if (existsSync(f)) assert.equal(readFileSync(f).includes(SECRET), false, f);
    } catch (e) {
      await b.close().catch(() => undefined);
      throw e;
    }
  });

  test('#61/AC-1 Given a session that holds the message, When 60 s pass without a turn, Then it is sent_unconfirmed and not resent', async () => {
    const b = await boot({ confirm: false, fakeClock: true });
    try {
      const r = await post(b, 'oi');
      const settled = await untilSettled(b, r.json.messageId);
      assert.deepEqual([settled.json.state, settled.json.reason], ['sent_unconfirmed', 'no_new_turn']);
      assert.ok(Date.parse(settled.json.settledAt) - Date.parse(settled.json.sentAt) >= CONFIRM_WINDOW_MS);
      assert.equal(b.lines.length, 1);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 Given no live process, When the person sends, Then it is not_delivered with the reason and no socket is touched', async () => {
    const b = await boot({ processes: 0 });
    try {
      const r = await post(b, 'oi');
      assert.equal(r.status, 202);
      assert.deepEqual([r.json.state, r.json.reason, r.json.sentAt], ['not_delivered', 'no_live_process', null]);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 Given a message in flight, When a second one is sent, Then 409 in_flight with the first id', async () => {
    const b = await boot({ confirm: false });
    try {
      const first = await post(b, 'um');
      const second = await post(b, 'dois');
      assert.equal(second.status, 409);
      assert.deepEqual([second.json.reason, second.json.messageId], ['in_flight', first.json.messageId]);
      assert.equal(b.lines.length, 1);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 Invalid text is 400 invalid_text; a body past MAX_MESSAGE_BODY is 413; not JSON is 415', async () => {
    const b = await boot();
    try {
      for (const text of ['', '   ', 42, null]) {
        const r = await post(b, text);
        assert.deepEqual([r.status, r.json.reason], [400, 'invalid_text'], JSON.stringify(text));
      }
      assert.equal((await call(b.url, 'POST', `/api/sessions/${b.sessionId}/messages`, ui(b), '[1]')).json.reason, 'invalid_text');
      assert.equal((await call(b.url, 'POST', `/api/sessions/${b.sessionId}/messages`, ui(b), `{"text":"${'a'.repeat(MAX_MESSAGE_BODY)}"}`)).status, 413);
      for (const type of ['text/plain', 'application/json-seq'])
        assert.equal((await call(b.url, 'POST', `/api/sessions/${b.sessionId}/messages`, { origin: `http://${b.host}`, 'content-type': type }, '{"text":"oi"}')).status, 415, type);
      assert.equal((await post(b, 'oi'.repeat(10), ui(b))).status, 202);
      assert.equal(b.logs.join('\n').includes('a'.repeat(100)), false);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 The 16 KiB limit is on the decoded text: 16384 bytes with newlines is 202, 16385 is 400 invalid_text', async () => {
    const b = await boot({ confirm: false });
    try {
      // Each newline costs 2 body bytes and each quote 2: the body is past 16 KiB, the text is not.
      const full = 'ab\n"'.repeat(16 * 1024 / 4);
      assert.equal(Buffer.byteLength(full), 16 * 1024);
      const r = await post(b, full);
      assert.equal(r.status, 202, JSON.stringify(r.json));
      const over = await post(b, `${full}a`);
      assert.deepEqual([over.status, over.json.reason], [400, 'invalid_text']);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 Unknown session or message: 404; a message read through another session: 404', async () => {
    const b = await boot();
    try {
      assert.equal((await call(b.url, 'POST', `/api/sessions/unknown-session/messages`, ui(b), '{"text":"oi"}')).status, 404);
      const r = await post(b, 'oi');
      assert.equal((await call(b.url, 'GET', `/api/sessions/other-session/messages/${r.json.messageId}`)).status, 404);
      assert.equal((await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messages/nope`)).status, 404);
      assert.equal((await call(b.url, 'GET', `/api/sessions/${b.sessionId}/messages`)).status, 405);
      assert.equal((await call(b.url, 'POST', `/api/sessions/${b.sessionId}/messaging`, ui(b), '{}')).status, 403);
    } finally {
      await b.close();
    }
  });
});

describe('#61/AC-1 decision 0003: the POST is a same-origin exception of the /ui only', () => {
  test('#61/AC-1 without Origin (a loopback script) it is refused: ui_only', async () => {
    const b = await boot();
    try {
      const r = await post(b, 'oi', { 'content-type': 'application/json' } as ReturnType<typeof ui>);
      assert.deepEqual([r.status, r.json.reason], [403, 'ui_only']);
      assert.equal(b.lines.length, 0);
    } finally {
      await b.close();
    }
  });

  test('#61/AC-1 another Origin, a query, a foreign Host or an encoded path get 403 and nothing is sent', async () => {
    const b = await boot();
    try {
      const body = '{"text":"oi"}';
      const path = `/api/sessions/${b.sessionId}/messages`;
      for (const origin of ['http://evil.example', 'null', `https://${b.host}`, 'http://localhost:1']) {
        assert.equal((await call(b.url, 'POST', path, { origin, 'content-type': 'application/json' }, body)).status, 403, origin);
      }
      assert.equal((await call(b.url, 'POST', `${path}?x=1`, ui(b), body)).status, 403);
      assert.equal((await call(b.url, 'POST', `/api/sessions/%2e%2e/messages`, ui(b), body)).status, 403);
      assert.equal((await call(b.url, 'POST', path, { host: 'example.test', origin: 'http://example.test', 'content-type': 'application/json' }, body)).status, 403);
      assert.equal(b.lines.length, 0);
    } finally {
      await b.close();
    }
  });
});
