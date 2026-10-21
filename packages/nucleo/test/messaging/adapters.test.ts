// The messaging adapters (#61) against temporary configuration folders and fake Unix-socket servers
// in temporary folders. Never the real ~/.claude, never a real session's socket.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { PEER_PREFIX, PEER_SUFFIX, peerBodyOf, peerTurnOf } from '../../src/ingest/history/transcript.ts';
import { AuditFile } from '../../src/messaging/adapters/audit-file.ts';
import { SessionsDirectory } from '../../src/messaging/adapters/sessions-dir.ts';
import { inboxLine, SocketInbox } from '../../src/messaging/adapters/socket-inbox.ts';
import { TranscriptTurns } from '../../src/messaging/adapters/transcript-turns.ts';

// Short: a Unix socket path has a ~104 byte limit.
const root = mkdtempSync(join(tmpdir(), 'acm-'));
const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** A fake inbox: a Unix socket server in a temp folder that keeps every line it gets. */
async function fakeInbox(): Promise<{ path: string; lines: string[] }> {
  const path = join(root, `s${++n}.sock`);
  const lines: string[] = [];
  const server = createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => (buf += d));
    c.on('end', () => {
      lines.push(...buf.split('\n').filter(Boolean));
      c.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return { path, lines };
}

const SID = '11111111-2222-4333-8444-555555555555';

function configDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return dir;
}

function writeSession(dir: string, pid: number, body: Record<string, unknown>): string {
  const file = join(dir, 'sessions', `${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, sessionId: SID, kind: 'interactive', entrypoint: 'claude-desktop', status: 'idle', ...body }));
  return file;
}

/** A pid that was alive and is not any more. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
}

describe('SessionsDirectory (#61/AC-1)', () => {
  test('finds the live process of the session, with entrypoint and Remote Control only as a flag', async () => {
    const dir = configDir('one');
    const { path } = await fakeInbox();
    writeSession(dir, process.pid, { messagingSocketPath: path, bridgeSessionId: 'bridge-value-never-kept' });
    const found = await new SessionsDirectory({ folders: async () => [{ dir }] }).find(SID);
    assert.deepEqual(found, [{ pid: process.pid, socketPath: path, configDir: dir, entrypoint: 'claude-desktop', remoteControl: true }]);
    assert.equal(JSON.stringify(found).includes('bridge-value-never-kept'), false);
  });

  test('never opens the .key file: unreadable, the session is still found', async () => {
    const dir = configDir('key');
    const { path } = await fakeInbox();
    writeSession(dir, process.pid, { messagingSocketPath: path });
    const key = join(dir, 'sessions', `${process.pid}.${'ab'.repeat(32)}.key`);
    writeFileSync(key, JSON.stringify({ peerToken: 'never-read' }));
    chmodSync(key, 0o000);
    const found = await new SessionsDirectory({ folders: async () => [{ dir }] }).find(SID);
    assert.equal(found.length, 1);
    chmodSync(key, 0o600);
  });

  test('skips what does not prove a live socket of ours', async () => {
    const dir = configDir('bad');
    const live = await fakeInbox();
    const dead = await deadPid();
    const plainFile = join(root, 'not-a-socket');
    writeFileSync(plainFile, '');
    const link = join(root, `link${++n}.sock`);
    symlinkSync(live.path, link);
    const other = process.ppid;
    // Another session, a dead pid, a regular file, a symlink to a socket, a relative path, a missing socket.
    writeSession(dir, 100001, { sessionId: 'other-session', pid: 100001, messagingSocketPath: live.path });
    writeSession(dir, dead, { messagingSocketPath: live.path });
    writeSession(dir, other, { messagingSocketPath: plainFile });
    const sessions = new SessionsDirectory({ folders: async () => [{ dir }], isAlive: (pid) => pid !== dead });
    assert.deepEqual(await sessions.find(SID), []);
    writeSession(dir, other, { messagingSocketPath: link });
    assert.deepEqual(await sessions.find(SID), []);
    writeSession(dir, other, { messagingSocketPath: 'relative/x.sock' });
    assert.deepEqual(await sessions.find(SID), []);
    writeSession(dir, other, { messagingSocketPath: `${root}/../${root.split('/').pop()}/s1.sock` });
    assert.deepEqual(await sessions.find(SID), []);
    writeSession(dir, other, { messagingSocketPath: join(root, 'missing.sock') });
    assert.deepEqual(await sessions.find(SID), []);
  });

  test('skips malformed files, a pid that is not the file name and a sessions file that is a symlink', async () => {
    const dir = configDir('malformed');
    const { path } = await fakeInbox();
    writeFileSync(join(dir, 'sessions', '12345.json'), '{ not json');
    writeSession(dir, 22222, { pid: process.pid, messagingSocketPath: path });
    const real = join(root, 'real-session.json');
    writeFileSync(real, JSON.stringify({ pid: process.pid, sessionId: SID, messagingSocketPath: path }));
    symlinkSync(real, join(dir, 'sessions', `${process.pid}.json`));
    writeFileSync(join(dir, 'sessions', `${process.pid}.json.bak`), JSON.stringify({ pid: process.pid, sessionId: SID, messagingSocketPath: path }));
    const sessions = new SessionsDirectory({ folders: async () => [{ dir }], isAlive: () => true });
    assert.deepEqual(await sessions.find(SID), []);
  });

  test('a socket owned by another uid is not ours', async () => {
    const dir = configDir('uid');
    const { path } = await fakeInbox();
    writeSession(dir, process.pid, { messagingSocketPath: path });
    const sessions = new SessionsDirectory({ folders: async () => [{ dir }], uid: (process.getuid?.() ?? 0) + 1 });
    assert.deepEqual(await sessions.find(SID), []);
  });

  test('two folders each with a live process of the session: both come back (ambiguous upstream)', async () => {
    const a = configDir('amb-a');
    const b = configDir('amb-b');
    const s1 = await fakeInbox();
    const s2 = await fakeInbox();
    writeSession(a, process.pid, { messagingSocketPath: s1.path });
    writeSession(b, process.ppid, { messagingSocketPath: s2.path });
    const found = await new SessionsDirectory({ folders: async () => [{ dir: a }, { dir: b }, { dir: join(root, 'no-such-folder') }] }).find(SID);
    assert.deepEqual(found.map((p) => p.pid).sort(), [process.pid, process.ppid].sort());
  });
});

describe('SocketInbox (#61/AC-1)', () => {
  test('writes exactly one stream-json user line, newlines of the text escaped', async () => {
    const { path, lines } = await fakeInbox();
    const r = await new SocketInbox().deliver(path, 'linha 1\nlinha 2 "aspas" é');
    assert.deepEqual(r, { ok: true });
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(lines, ['{"type":"user","message":{"role":"user","content":"linha 1\\nlinha 2 \\"aspas\\" é"}}']);
    assert.equal(inboxLine('x'), '{"type":"user","message":{"role":"user","content":"x"}}\n');
  });

  test('a socket that is gone is socket_gone; a socket file nobody listens on is connection_refused', async () => {
    assert.deepEqual(await new SocketInbox().deliver(join(root, 'nobody.sock'), 'oi'), { ok: false, reason: 'socket_gone' });
    const stale = join(root, `stale${++n}.sock`);
    // A server that dies without unlinking its socket file (like a crashed process).
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    await new Promise((r) => child.once('exit', r));
    assert.ok(statSync(stale).isSocket());
    assert.deepEqual(await new SocketInbox().deliver(stale, 'oi'), { ok: false, reason: 'connection_refused' });
  });

  test('a connection that never opens is a timeout', async () => {
    const r = await new SocketInbox({ timeoutMs: 30, connect: () => new Socket() }).deliver('/never', 'oi');
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
  });
});

describe('peerTurnOf and TranscriptTurns (#61/AC-1)', () => {
  const BODY = 'segredo\ncom linha e espaço no fim ';
  const HASH = createHash('sha256').update(BODY, 'utf8').digest('hex');
  const wrapped = (body: string) => `${PEER_PREFIX}${body}${PEER_SUFFIX} — not typed by your user, but very likely working on their behalf.`;
  const line = (o: Record<string, unknown>, body = BODY) => `${JSON.stringify({ type: 'user', uuid: `u${++n}`, sessionId: SID, message: { role: 'user', content: wrapped(body) }, ...o })}\n`;
  const live = (dir: string) => ({ pid: 1, socketPath: '/x', configDir: dir, entrypoint: null, remoteControl: false });

  test('reads the origin and the time of a peer line, never the content', () => {
    const t = peerTurnOf(line({ timestamp: '2026-10-21T10:00:00.000Z', isMeta: true, origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: 4242 } }).trim());
    assert.deepEqual(t, { at: Date.parse('2026-10-21T10:00:00.000Z'), verifiedPeerPid: 4242, bodySha256: HASH });
    assert.equal(JSON.stringify(t).includes('segredo'), false);
    // The body is what sits between the wrapping, even when it has the suffix's words itself.
    assert.equal(peerBodyOf(wrapped(`a${PEER_SUFFIX}b`)), `a${PEER_SUFFIX}b`);
    assert.equal(peerBodyOf('typed by hand'), null);
    assert.equal(peerTurnOf(JSON.stringify({ type: 'user', timestamp: '2026-10-21T10:00:00.000Z', origin: { kind: 'peer' }, message: { content: 'other shape' } }))?.bodySha256, null);
    assert.equal(peerTurnOf(line({ timestamp: '2026-10-21T10:00:00.000Z', origin: { kind: 'human' } }).trim()), null);
    assert.equal(peerTurnOf('{"type":"assistant","origin":{"kind":"peer"}}'), null);
    assert.equal(peerTurnOf('not json "peer"'), null);
  });

  test('confirms only a peer turn of our pid, with this message body, written after the probe opened', async () => {
    const dir = join(root, 'turns');
    const project = join(dir, 'projects', '-tmp-proj');
    mkdirSync(project, { recursive: true });
    const file = join(project, `${SID}.jsonl`);
    const now = Date.parse('2026-10-21T10:00:00.000Z');
    const at = (ms: number) => new Date(now + ms).toISOString();
    // A peer turn of ours from before the probe: already in the file, never counts.
    writeFileSync(file, line({ timestamp: at(-1000), origin: { kind: 'peer', verifiedPeerPid: 777 } }));
    const probe = await new TranscriptTurns({ pid: 777, now: () => now }).open(live(dir), SID, HASH);
    assert.equal(await probe.poll(), null);
    appendFileSync(file, line({ timestamp: at(10), origin: { kind: 'human' } }));
    // Another writer, a line without the verified pid, and a late turn of an EARLIER message of ours.
    appendFileSync(file, line({ timestamp: at(20), origin: { kind: 'peer', verifiedPeerPid: 999 } }));
    appendFileSync(file, line({ timestamp: at(21), origin: { kind: 'peer', from: 'unknown' } }));
    appendFileSync(file, line({ timestamp: at(22), origin: { kind: 'peer', verifiedPeerPid: 777 } }, 'a mensagem anterior'));
    assert.equal(await probe.poll(), null);
    // Half a line: waits for the rest.
    const ours = line({ timestamp: at(30), isMeta: true, origin: { kind: 'peer', verifiedPeerPid: 777 } });
    appendFileSync(file, ours.slice(0, 40));
    assert.equal(await probe.poll(), null);
    appendFileSync(file, ours.slice(40));
    assert.equal(await probe.poll(), now + 30);
    probe.close();
    assert.equal(await probe.poll(), null);
  });

  test('a session without a transcript yet is found once it appears', async () => {
    const dir = join(root, 'turns-late');
    const now = Date.now();
    const probe = await new TranscriptTurns({ pid: 777, now: () => now }).open(live(dir), SID, HASH);
    assert.equal(await probe.poll(), null);
    mkdirSync(join(dir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-p', `${SID}.jsonl`), line({ timestamp: new Date(now + 5).toISOString(), origin: { kind: 'peer', verifiedPeerPid: 777 } }));
    assert.equal(await probe.poll(), now + 5);
  });
});

describe('AuditFile', () => {
  test('one JSON line per entry, file 0600', () => {
    const file = join(root, 'data', 'messaging-audit.jsonl');
    const audit = new AuditFile(file);
    const entry = { at: '2026-10-21T10:00:00.000Z', sessionId: SID, messageId: 'm1', mechanism: 'inbox' as const, outcome: 'delivered' as const, reason: null, textSha256: 'ab'.repeat(32) };
    audit.record(entry);
    audit.record({ ...entry, messageId: null, outcome: 'refused', reason: 'in_flight' });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], entry);
    assert.equal(lines[1].reason, 'in_flight');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
