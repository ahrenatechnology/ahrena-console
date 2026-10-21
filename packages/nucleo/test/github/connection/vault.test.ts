// The credential vault (#241, decision 0011 §3): one port, a Keychain adapter (`security`), a Secret
// Service adapter (`secret-tool`) and an in-memory one. The adapters run against fake executables in a
// temp dir, by absolute path: the real tools never run here.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  chooseVault,
  GITHUB_VAULT_SERVICE,
  KeychainVault,
  MemoryVault,
  parseDumpKeychain,
  VaultError,
  SecretServiceVault,
  type CredentialVault,
} from '../../../src/github/connection/index.ts';
import { createFakeSecretTool, createFakeSecurity, type FakeTool } from './fake-vault-tools.ts';

const SECRET = 'gho_FAKEfake0123456789abcdefABCDEF0123'; // obviously fake, test-only
const SVC = GITHUB_VAULT_SERVICE;

function contract(name: string, make: () => { vault: CredentialVault; done?: () => void }) {
  describe(`#241/AC-3 vault contract: ${name}`, () => {
    test('set, get, list and delete round trip; a missing account reads null', async () => {
      const { vault, done } = make();
      try {
        assert.equal(await vault.get('octo-cat'), null);
        await vault.set('octo-cat', SECRET);
        assert.equal(await vault.get('octo-cat'), SECRET);
        await vault.set('other1', 'gho_second');
        assert.deepEqual((await vault.list()).sort(), ['octo-cat', 'other1']);
        await vault.delete('octo-cat');
        assert.equal(await vault.get('octo-cat'), null);
        assert.deepEqual(await vault.list(), ['other1']);
        await vault.delete('never-there'); // deleting a missing account is fine
      } finally {
        done?.();
      }
    });

    test('set overwrites the same account', async () => {
      const { vault, done } = make();
      try {
        await vault.set('octo-cat', 'gho_first');
        await vault.set('octo-cat', SECRET);
        assert.equal(await vault.get('octo-cat'), SECRET);
        assert.deepEqual(await vault.list(), ['octo-cat']);
      } finally {
        done?.();
      }
    });

    test('an invalid login or secret is refused, and the error does not carry the value', async () => {
      const { vault, done } = make();
      try {
        for (const login of ['', '-rf', 'a b', 'x"y', 'a\nb', 'a'.repeat(40)]) {
          await assert.rejects(vault.set(login, SECRET), (err: Error) => !err.message.includes(SECRET));
        }
        for (const secret of ['', 'with space', 'quote"d', 'new\nline', `${SECRET}\\`]) {
          await assert.rejects(vault.set('octo-cat', secret), (err: Error) => !err.message.includes(secret || '\u0000'));
        }
        assert.deepEqual(await vault.list(), []);
      } finally {
        done?.();
      }
    });
  });
}

contract('memory', () => ({ vault: new MemoryVault() }));
contract('keychain (fake security)', () => {
  const tool = createFakeSecurity();
  return { vault: new KeychainVault({ bin: tool.bin }), done: tool.cleanup };
});
contract('secret service (fake secret-tool)', () => {
  const tool = createFakeSecretTool();
  return { vault: new SecretServiceVault({ bin: tool.bin }), done: tool.cleanup };
});

describe('#241/AC-3 KeychainVault talks to `security` without the secret in argv', () => {
  let tool: FakeTool;
  let vault: KeychainVault;
  before(() => {
    tool = createFakeSecurity();
    vault = new KeychainVault({ bin: tool.bin });
  });
  after(() => tool.cleanup());

  test('the default executable is /usr/bin/security (never PATH-resolved); the kind is keychain', () => {
    assert.equal(new KeychainVault().bin, '/usr/bin/security');
    assert.equal(vault.kind, 'keychain');
  });

  test('set writes one add-generic-password line to `security -i` on stdin; the secret is never in argv', async () => {
    await vault.set('octo-cat', SECRET);
    const calls = tool.calls();
    const write = calls.find((c) => c.argv[0] === '-i');
    assert.ok(write, 'security -i was used');
    assert.deepEqual(write.argv, ['-i']);
    assert.equal(write.stdin, `add-generic-password -U -s "${SVC}" -a "octo-cat" -w "${SECRET}"\n`);
    for (const c of calls) assert.ok(!c.argv.join(' ').includes(SECRET), `secret in argv of ${c.argv[0]}`);
    assert.deepEqual(tool.items(), { [`${SVC}|octo-cat`]: SECRET });
  });

  test('get reads with find-generic-password -w; list reads dump-keychain without -d and only this service', async () => {
    tool.seed({ [`${SVC}|octo-cat`]: SECRET, 'some.other.service|octo-cat': 'gho_other', [`${SVC}|second`]: 'gho_x' });
    const before = tool.calls().length;
    assert.equal(await vault.get('octo-cat'), SECRET);
    assert.deepEqual((await vault.list()).sort(), ['octo-cat', 'second']);
    const [get, list] = tool.calls().slice(before);
    assert.deepEqual(get.argv, ['find-generic-password', '-s', SVC, '-a', 'octo-cat', '-w']);
    assert.deepEqual(list.argv, ['dump-keychain']);
  });

  test('delete uses delete-generic-password; a missing item (exit 44) is not an error', async () => {
    tool.seed({ [`${SVC}|octo-cat`]: SECRET });
    await vault.delete('octo-cat');
    await vault.delete('octo-cat');
    assert.deepEqual(tool.items(), {});
    const last = tool.calls().at(-1)!;
    assert.deepEqual(last.argv, ['delete-generic-password', '-s', SVC, '-a', 'octo-cat']);
  });

  test('an invalid value is refused before spawning anything', async () => {
    const before = tool.calls().length;
    await assert.rejects(vault.set('octo-cat', 'bad"secret'));
    await assert.rejects(vault.get('-bad'));
    await assert.rejects(vault.delete('a b'));
    assert.equal(tool.calls().length, before);
  });

  test('a failing `security` rejects with the exit code only', async () => {
    tool.failWith(1);
    try {
      await assert.rejects(vault.set('octo-cat', SECRET), (err: Error) => /exit 1/.test(err.message) && !err.message.includes(SECRET));
      await assert.rejects(vault.get('octo-cat'), /exit 1/);
      await assert.rejects(vault.list(), /exit 1/);
    } finally {
      tool.failWith(null);
    }
  });

  test('review M2: `security -i` exiting 0 without writing is a write failure (checked by reading it back)', async () => {
    tool.seed({});
    tool.dropWrites(true);
    try {
      await assert.rejects(vault.set('octo-cat', SECRET), (err: Error) => err instanceof VaultError && !err.message.includes(SECRET));
    } finally {
      tool.dropWrites(false);
    }
    await vault.set('octo-cat', SECRET);
    const check = tool.calls().at(-1)!;
    assert.deepEqual(check.argv, ['find-generic-password', '-s', SVC, '-a', 'octo-cat', '-w'], 'read back on stdout, never in argv');
  });

  test('parseDumpKeychain reads the hex form of an attribute and skips what is not a login', () => {
    const dump = [
      'keychain: "/fake/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>=0x6F63746F2D636174  "octo-cat"\n    "svce"<blob>=0x6465762E616872656E61  "dev.ahrena.console.github"\n',
      'keychain: "/fake/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>=0x61620A  "ab\\012"\n    "svce"<blob>="dev.ahrena.console.github"\n',
      'keychain: "/fake/login.keychain-db"\nclass: "inet"\nattributes:\n    "acct"<blob>="web-user"\n    "svce"<blob>="dev.ahrena.console.github"\n',
    ].join('');
    assert.deepEqual(parseDumpKeychain(dump), ['octo-cat']);
  });

  test('an executable that does not exist rejects (no PATH fallback)', async () => {
    const missing = new KeychainVault({ bin: `${tool.dir}/does-not-exist` });
    await assert.rejects(missing.get('octo-cat'));
  });
});

describe('#241/AC-3 SecretServiceVault talks to `secret-tool` without the secret in argv', () => {
  let tool: FakeTool;
  let vault: SecretServiceVault;
  before(() => {
    tool = createFakeSecretTool();
    vault = new SecretServiceVault({ bin: tool.bin });
  });
  after(() => tool.cleanup());

  test('store sends the secret on stdin with service/account attributes', async () => {
    assert.equal(vault.kind, 'secret-service');
    await vault.set('octo-cat', SECRET);
    const store = tool.calls().find((c) => c.argv[0] === 'store')!;
    assert.deepEqual(store.argv, ['store', '--label=Ahrena Console (GitHub)', 'service', SVC, 'account', 'octo-cat']);
    assert.equal(store.stdin, SECRET);
    for (const c of tool.calls()) assert.ok(!c.argv.join(' ').includes(SECRET));
  });

  test('review M1: exit 1 with an error on stderr is a failure, not "not found"; the message carries no output', async () => {
    tool.seed({ [`${SVC}|octo-cat`]: SECRET });
    tool.failWith(1, `secret-tool: Cannot autolaunch D-Bus ${SECRET}\n`);
    try {
      for (const op of [() => vault.get('octo-cat'), () => vault.delete('octo-cat'), () => vault.list(), () => vault.set('octo-cat', SECRET)]) {
        await assert.rejects(op(), (err: Error) => err instanceof VaultError && !err.message.includes(SECRET) && !err.message.includes('D-Bus'));
      }
    } finally {
      tool.failWith(null);
    }
    tool.failWith(1);
    try {
      assert.equal(await vault.get('octo-cat'), null, 'exit 1 with no output at all is "not found"');
    } finally {
      tool.failWith(null);
    }
  });

  test('lookup, clear and search use the service/account attributes; search keeps only account lines', async () => {
    tool.seed({ [`${SVC}|octo-cat`]: SECRET, 'some.other.service|zed': 'gho_other' });
    const before = tool.calls().length;
    assert.equal(await vault.get('octo-cat'), SECRET);
    assert.deepEqual(await vault.list(), ['octo-cat']);
    await vault.delete('octo-cat');
    const [lookup, search, clear] = tool.calls().slice(before);
    assert.deepEqual(lookup.argv, ['lookup', 'service', SVC, 'account', 'octo-cat']);
    assert.deepEqual(search.argv, ['search', '--all', 'service', SVC]);
    assert.deepEqual(clear.argv, ['clear', 'service', SVC, 'account', 'octo-cat']);
  });
});

describe('#241/AC-3 chooseVault', () => {
  const none = () => false;
  const all = () => true;

  test('under node --test (NODE_TEST_CONTEXT) the default is the in-memory vault, never the real tools', () => {
    const v = chooseVault({ platform: 'darwin', env: { NODE_TEST_CONTEXT: 'child-v8' }, exists: all });
    assert.equal(v?.kind, 'memory');
    assert.ok(process.env.NODE_TEST_CONTEXT, 'this suite itself runs with NODE_TEST_CONTEXT');
    assert.equal(chooseVault()?.kind, 'memory');
  });

  test('macOS with /usr/bin/security → keychain; without it → none', () => {
    assert.equal(chooseVault({ platform: 'darwin', env: {}, exists: (p) => p === '/usr/bin/security' })?.kind, 'keychain');
    assert.equal(chooseVault({ platform: 'darwin', env: {}, exists: none }), null);
  });

  test('Linux with secret-tool on PATH and a session bus → secret service; otherwise none', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    const v = chooseVault({ platform: 'linux', env, exists: (p) => p === '/usr/bin/secret-tool' });
    assert.equal(v?.kind, 'secret-service');
    assert.equal((v as SecretServiceVault).bin, '/usr/bin/secret-tool');
    assert.equal(chooseVault({ platform: 'linux', env: { PATH: env.PATH }, exists: all }), null);
    assert.equal(chooseVault({ platform: 'linux', env, exists: none }), null);
    assert.equal(chooseVault({ platform: 'win32', env, exists: all }), null);
  });

  test('AHRENA_CONSOLE_VAULT overrides, even under node --test', () => {
    const t = { NODE_TEST_CONTEXT: 'child-v8' };
    assert.equal(chooseVault({ platform: 'linux', env: { ...t, AHRENA_CONSOLE_VAULT: 'none' }, exists: all }), null);
    assert.equal(chooseVault({ platform: 'darwin', env: { AHRENA_CONSOLE_VAULT: 'memory' }, exists: all })?.kind, 'memory');
    assert.equal(chooseVault({ platform: 'linux', env: { ...t, AHRENA_CONSOLE_VAULT: 'keychain' }, exists: all })?.kind, 'keychain');
    const ss = chooseVault({ platform: 'darwin', env: { ...t, AHRENA_CONSOLE_VAULT: 'secret-service', PATH: '/opt/bin' }, exists: all });
    assert.equal(ss?.kind, 'secret-service');
    // an unknown value is ignored
    assert.equal(chooseVault({ platform: 'darwin', env: { ...t, AHRENA_CONSOLE_VAULT: 'cofre' }, exists: all })?.kind, 'memory');
  });

  test('MemoryVault takes an optional seed and keeps nothing outside the process', async () => {
    const v = new MemoryVault({ 'octo-cat': SECRET });
    assert.equal(await v.get('octo-cat'), SECRET);
    assert.deepEqual(await new MemoryVault().list(), []);
  });
});
