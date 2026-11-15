// Behaviour scenarios of #619 at the API: the window credential and the Controle switch, through the real HTTP API, with the
// credential fed by the real channel reader (a PassThrough stands for the inherited socket, a fake PeerVerifier for the native check).
// Each scenario carries its criterion token (`#619/AC-n`). The credentials below are fixtures of the test, never real ones. (#619)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { parseApiOptions } from '../../src/api/cli-options.ts';
import { openPermissionDeps } from '../../src/permissions/adapters/deps.ts';
import { createWindowCredentialHolder } from '../../src/permissions/window-credential.ts';
import { readWindowChannel, type PeerVerdict } from '../../src/permissions/window-channel.ts';
import { MemoryInstallationSettings, SqliteInstallationSettings, type InstallationSettings } from '../../src/settings/installation-settings.ts';
import { OWNER_TOKEN } from '../owner-http.ts';
import { permissionFixture, SID, until, type FixtureOptions, type PermissionFixture } from './permission-fixture.ts';

const CRED_A = 'a1'.repeat(32);
const CRED_B = 'b2'.repeat(32);
const CRED_C = 'c3'.repeat(32);
const SWITCH = '/api/permissions/answer-from-console';

/** The app's end of the channel: the reader, the holder it feeds and the line the app writes. (#619) */
function channel(verdict: PeerVerdict = 'match') {
  const stream = new PassThrough();
  const holder = createWindowCredentialHolder();
  const logs: string[] = [];
  const reader = readWindowChannel({ fd: 3, stream, verifier: { verify: async () => verdict }, holder, log: (m) => logs.push(m) });
  const send = async (line: string, expect: string | null): Promise<void> => {
    stream.write(`${line}\n`);
    await until(() => holder.current() === expect);
  };
  return { stream, holder, logs, reader, send };
}

async function given(run: (f: PermissionFixture) => Promise<void>, over: FixtureOptions = {}): Promise<void> {
  const f = await permissionFixture(over);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}

const withWindow = (credential: string | null) => ({ headers: { 'ahrena-window': credential } });
const answerWith = (f: PermissionFixture, rid: string, credential: string | null) => f.answer(SID, rid, { decision: 'allow' }, withWindow(credential));

/** The /ui window calling the switch: its `Origin`, JSON and, when it has one, the window credential. (#619) */
const fromWindow = (f: PermissionFixture, method: string, body: unknown, credential: string | null) =>
  f.call(method, SWITCH, { body, headers: { origin: f.api.url, ...(credential === null ? {} : { 'ahrena-window': credential }) } });

describe('answer needs the live window credential (#619/AC-1)', () => {
  test('#619/AC-1: Given a live credential, When answer arrives without Ahrena-Window, Then 403 window_only; with the live one, 200', () => {
    const c = channel();
    return given(async (f) => {
      await c.send(CRED_A, CRED_A);
      const { rid } = await f.register();
      const without = await answerWith(f, rid, null);
      assert.equal(without.status, 403);
      assert.deepEqual(without.json, { error: 'window_only' });
      assert.equal((await answerWith(f, rid, CRED_B)).status, 403);
      assert.equal((await answerWith(f, rid, CRED_A)).status, 200);
    }, { holder: c.holder });
  });

  test('#619/AC-1: Given a credential rotated out, When answer arrives with the old one, Then 403 window_only; the new one answers', () => {
    const c = channel();
    return given(async (f) => {
      await c.send(CRED_A, CRED_A);
      const { rid } = await f.register();
      await c.send(CRED_B, CRED_B);
      const old = await answerWith(f, rid, CRED_A);
      assert.equal(old.status, 403);
      assert.deepEqual(old.json, { error: 'window_only' });
      assert.equal((await answerWith(f, rid, CRED_B)).status, 200);
    }, { holder: c.holder });
  });

  test('#619/AC-1: Given the channel closed (EOF), When answer arrives with the last credential, Then 403 window_only', () => {
    const c = channel();
    return given(async (f) => {
      await c.send(CRED_A, CRED_A);
      const { rid } = await f.register();
      c.stream.end();
      await c.reader.done;
      assert.equal(c.holder.current(), null);
      const late = await answerWith(f, rid, CRED_A);
      assert.equal(late.status, 403);
      assert.deepEqual(late.json, { error: 'window_only' });
    }, { holder: c.holder });
  });

  test('#619/AC-1: Given a core restarted (a new holder, a new credential), When answer arrives with the previous run\'s credential, Then 403 window_only', async () => {
    const before = channel();
    await before.send(CRED_A, CRED_A);
    const after = channel();
    await after.send(CRED_C, CRED_C);
    await given(async (f) => {
      const { rid } = await f.register();
      const stale = await answerWith(f, rid, CRED_A);
      assert.equal(stale.status, 403);
      assert.deepEqual(stale.json, { error: 'window_only' });
      assert.equal((await answerWith(f, rid, CRED_C)).status, 200);
    }, { holder: after.holder });
  });
});

/** Every file under the folder, read as text. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [readFileSync(path, 'latin1')];
  });
}

describe('the credential is never exposed (#619/AC-2)', () => {
  test('#619/AC-2: Given a live credential, Then no GET response, no log line and no file under the data dir contains it, and the switch state is booleans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'window-credential-'));
    const c = channel();
    try {
      await c.send(CRED_A, CRED_A);
      await given(
        async (f) => {
          const { rid } = await f.register();
          assert.equal((await answerWith(f, rid, CRED_A)).status, 200);
          const reads = ['/api/overview', '/api/attention', '/api/changes?wait=0', `/api/sessions/${SID}`, `/api/sessions/${SID}/permission-requests`, SWITCH];
          for (const path of reads) {
            const reply = await f.call('GET', path);
            assert.ok(!reply.text.includes(CRED_A), `GET ${path}`);
            const fromUi = await f.call('GET', path, { headers: { origin: f.api.url } });
            assert.ok(!fromUi.text.includes(CRED_A), `GET ${path} from the /ui`);
          }
          const state = await f.call('GET', SWITCH);
          assert.equal(state.status, 200);
          assert.deepEqual(state.json, { enabled: true, available: true });
          await fromWindow(f, 'PUT', { enabled: false }, CRED_A);
          await f.call('PUT', SWITCH, { body: { enabled: true }, headers: { 'ahrena-window': CRED_B } });
          assert.ok(!f.logs.join('\n').includes(CRED_A), 'the log');
          assert.ok(!f.logs.join('\n').includes(CRED_B), 'the log');
          for (const text of filesUnder(dir)) assert.ok(!text.includes(CRED_A), 'a file under the data dir');
          assert.ok(filesUnder(dir).length > 0, 'the data dir holds the audit');
        },
        { holder: c.holder, deps: (db) => openPermissionDeps(db, dir, () => {}) },
      );
      assert.ok(!c.logs.join('\n').includes(CRED_A), 'the channel log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the owner token alone cannot answer (#619/AC-3)', () => {
  test('#619/AC-3: Given only the owner token and a forged Origin, When it answers, Then 403; and it cannot turn the switch back on', async () => {
    const c = channel();
    await c.send(CRED_A, CRED_A);
    await given(async (f) => {
      const { rid } = await f.register();
      const forged = await f.answer(SID, rid, { decision: 'allow' }, withWindow(null));
      assert.equal(forged.status, 403);
      assert.deepEqual(forged.json, { error: 'window_only' });
      const guessed = await f.answer(SID, rid, { decision: 'allow' }, withWindow('0'.repeat(64)));
      assert.equal(guessed.status, 403);
      const noOrigin = await f.call('POST', `/api/sessions/${SID}/permission-requests/${rid}/answer`, { body: { decision: 'allow' }, headers: { 'ahrena-window': CRED_A } });
      assert.equal(noOrigin.status, 403);
      assert.equal(f.deps.repository.find(SID, rid)?.state, 'pending');
      // What the person turned off, the agent with the token cannot turn on: that takes the window (internal hardening).
      assert.equal((await f.call('PUT', SWITCH, { body: { enabled: false } })).status, 200);
      for (const headers of [{}, { origin: f.api.url }, { origin: f.api.url, 'ahrena-window': '0'.repeat(64) }]) {
        const on = await f.call('PUT', SWITCH, { body: { enabled: true }, headers });
        assert.equal(on.status, 403, JSON.stringify(headers));
      }
      assert.deepEqual((await f.call('GET', SWITCH)).json, { enabled: false, available: true });
    }, { holder: c.holder });
  });
});

describe('the Controle switch (#619/AC-4)', () => {
  const fresh = (): InstallationSettings => new MemoryInstallationSettings();

  test('#619/AC-4: Given a fresh installation, Then the capability is on when the credential is live', async () => {
    const c = channel();
    await c.send(CRED_A, CRED_A);
    await given(async (f) => {
      assert.deepEqual((await f.call('GET', SWITCH)).json, { enabled: true, available: true });
      assert.equal((await f.register()).status, 201);
    }, { holder: c.holder, settings: fresh() });
  });

  test('#619/AC-4: When the owner turns the switch off, Then registration and answer are refused, and turning it on again restores both', async () => {
    const c = channel();
    await c.send(CRED_A, CRED_A);
    await given(async (f) => {
      const { rid } = await f.register();
      const off = await f.call('PUT', SWITCH, { body: { enabled: false } });
      assert.equal(off.status, 200);
      assert.deepEqual(off.json, { enabled: false, available: true });
      const refused = await f.register();
      assert.equal(refused.status, 503);
      assert.deepEqual(refused.json, { error: 'off' });
      const answered = await answerWith(f, rid, CRED_A);
      assert.equal(answered.status, 403);
      assert.deepEqual(answered.json, { error: 'window_only' });
      const on = await fromWindow(f, 'PUT', { enabled: true }, CRED_A);
      assert.equal(on.status, 200);
      assert.deepEqual(on.json, { enabled: true, available: true });
      assert.equal((await f.register()).status, 201);
      assert.equal((await answerWith(f, rid, CRED_A)).status, 200);
    }, { holder: c.holder, settings: fresh() });
  });

  test('#619/AC-4: Given the switch turned off, Then the setting persists across a restart of the core', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switch-persist-'));
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'console.sqlite');
      const first = openSqliteStorage({ path });
      const c = channel();
      await c.send(CRED_A, CRED_A);
      await given(async (f) => {
        assert.equal((await f.call('PUT', SWITCH, { body: { enabled: false } })).status, 200);
      }, { holder: c.holder, settings: new SqliteInstallationSettings(first.db) });
      first.close();
      const second = openSqliteStorage({ path });
      const again = channel();
      await again.send(CRED_B, CRED_B);
      await given(async (f) => {
        assert.deepEqual((await f.call('GET', SWITCH)).json, { enabled: false, available: true });
        assert.equal((await f.register()).status, 503);
      }, { holder: again.holder, settings: new SqliteInstallationSettings(second.db) });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#619/AC-4: the switch takes a boolean and nothing else', async () => {
    const c = channel();
    await c.send(CRED_A, CRED_A);
    await given(async (f) => {
      for (const body of [{}, { enabled: 'no' }, { enabled: false, extra: 1 }, [], { enabled: null }]) {
        const r = await f.call('PUT', SWITCH, { body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.deepEqual(r.json, { error: 'invalid_request' });
      }
      assert.equal((await f.call('PUT', SWITCH, { raw: '{nope' })).status, 400);
      assert.equal((await f.call('PUT', SWITCH, { raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await f.call('PUT', SWITCH, { bearer: false, body: { enabled: false } })).status, 403);
      assert.equal((await f.call('PUT', SWITCH, { body: { enabled: false }, headers: { origin: 'http://evil.example' } })).status, 403);
      assert.equal((await f.call('PUT', SWITCH, { body: { enabled: false }, headers: { origin: f.api.url, 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await f.call('POST', SWITCH, { body: { enabled: false } })).status, 405);
      assert.deepEqual((await f.call('GET', SWITCH)).json, { enabled: true, available: true });
    }, { holder: c.holder, settings: fresh() });
  });
});

describe('only the app that started the core hands it the credential (#619/AC-5, AC-6)', () => {
  for (const verdict of ['mismatch', { unavailable: 'spawn' }] as const) {
    test(`#619/AC-5: Given a channel whose peer check answers ${typeof verdict === 'string' ? verdict : 'unavailable'}, Then the core holds no credential and the capability is unavailable`, async () => {
      const c = channel(verdict);
      c.stream.write(`${CRED_A}\n`);
      await c.reader.done;
      assert.equal(c.holder.current(), null);
      await given(async (f) => {
        assert.deepEqual((await f.call('GET', SWITCH)).json, { enabled: true, available: false });
        const registered = await f.register();
        assert.equal(registered.status, 503);
        assert.deepEqual(registered.json, { error: 'off' });
        const answered = await f.answer(SID, 'any-request', { decision: 'allow' }, withWindow(CRED_A));
        assert.equal(answered.status, 403);
        assert.deepEqual(answered.json, { error: 'window_only' });
        assert.equal((await fromWindow(f, 'PUT', { enabled: true }, CRED_A)).status, 403);
      }, { holder: c.holder });
    });
  }

  test('#619/AC-5: no credential is accepted through an argument, an environment variable or a file', () => {
    for (const args of [['--window-credential', CRED_A], [`--window-credential=${CRED_A}`], ['--window-credential-file', '/tmp/x']]) {
      assert.throws(() => parseApiOptions(args), undefined, args.join(' '));
    }
    const holder = createWindowCredentialHolder();
    const before = process.env.AHRENA_CONSOLE_WINDOW_CREDENTIAL;
    process.env.AHRENA_CONSOLE_WINDOW_CREDENTIAL = CRED_A;
    try {
      assert.equal(holder.current(), null);
    } finally {
      if (before === undefined) delete process.env.AHRENA_CONSOLE_WINDOW_CREDENTIAL;
      else process.env.AHRENA_CONSOLE_WINDOW_CREDENTIAL = before;
    }
  });

  test('#619/AC-6: Given a second core started without the app\'s channel, Then registration answers off and answer is 403', () =>
    given(async (f) => {
      assert.deepEqual((await f.call('GET', SWITCH)).json, { enabled: true, available: false });
      const registered = await f.register();
      assert.equal(registered.status, 503);
      assert.deepEqual(registered.json, { error: 'off' });
      for (const credential of [null, CRED_A, OWNER_TOKEN]) {
        const answered = await f.answer(SID, 'any-request', { decision: 'allow' }, withWindow(credential));
        assert.equal(answered.status, 403);
        assert.deepEqual(answered.json, { error: 'window_only' });
      }
    }, { credential: null, settings: new MemoryInstallationSettings() }));
});
