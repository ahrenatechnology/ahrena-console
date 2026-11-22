// What the memory module may never do, and who may never reach it (#727/AC-4, #727/AC-5).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeSpawn, turn } from '../src/memory/mocks/fake-child.ts';
import { handoffsFixture, recentFixture, statusFixture } from '../src/memory/mocks/fixtures.ts';
import { createMemoryModule } from '../src/memory/memory.ts';

const THIS_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(THIS_FILE);
const MEMORY_DIR = join(TEST_DIR, '..', 'src', 'memory');
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const FAKE_TOKEN = 'fake-token-0000-not-real';

function files(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isSource = (path: string) => /\.(ts|tsx|mts|mjs|js)$/.test(path);
const isTest = (path: string) => /\.test\.[a-z]+$/.test(path) || /\/mocks\//.test(path);
const memorySources = (): string[] => {
  const found = files(MEMORY_DIR, (p) => isSource(p) && !isTest(p));
  assert.ok(found.length >= 3, 'the scan found the module files (#727)');
  return found;
};

describe('#719/AC-10 the module never reads the ai-memory token (#727/AC-4)', () => {
  test('#719/AC-10 no non-test file of the module names auth-tokens/ or an auth-token file', () => {
    const sources = memorySources();
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      assert.equal(/auth-tokens?/i.test(text), false, `${relative(MEMORY_DIR, path)} names an auth-token path`);
    }
  });

  test('#719/AC-10 no non-test file of the module imports node:fs or reads a file', () => {
    for (const path of memorySources()) {
      const text = readFileSync(path, 'utf8');
      assert.equal(/node:fs|from 'fs'|readFile|createReadStream|opendir|readdir/.test(text), false, `${relative(MEMORY_DIR, path)} touches the file system`);
    }
  });

  test('#719/AC-10 #733/AC-4 a token planted in the environment and the output reaches no argv, no child environment and no output', async () => {
    const doubles = fakeSpawn();
    const memory = createMemoryModule({
      dataDir: '/Users/someone/.ahrena-console/ai-memory',
      binaryPath: '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory',
      spawn: doubles.spawn,
      killGroup: () => {},
      env: { PATH: '/usr/bin', AI_MEMORY_AUTH_TOKEN: FAKE_TOKEN, AHRENA_CONSOLE_TOKEN: FAKE_TOKEN },
    });
    const outputs: unknown[] = [];
    const planWithToken = JSON.stringify({
      format: 1,
      data_dir: '/d',
      config_path: '/d/c',
      fresh: true,
      service: { action: 'a', manager: 'm', path: null },
      agents: [],
      other_agents: [],
      auth_token: FAKE_TOKEN,
    });
    for (const [call, stdout] of [
      [() => memory.version(), 'ai-memory 3.5.1\n'],
      [() => memory.setupPlan(), planWithToken],
      [() => memory.status(), JSON.stringify({ ...statusFixture(), token: FAKE_TOKEN, client: { auth: false, token: FAKE_TOKEN } })],
      [() => memory.handoffs('app'), JSON.stringify(handoffsFixture())],
      [() => memory.recent('app'), JSON.stringify(recentFixture())],
    ] as const) {
      const pending = call();
      await turn();
      doubles.calls.at(-1)!.child.finish(0, stdout, `stderr ${FAKE_TOKEN}`);
      outputs.push(await pending);
    }
    assert.equal(doubles.calls.length, 5);
    for (const spawned of doubles.calls) {
      const everything = JSON.stringify([spawned.command, spawned.args, spawned.options.env]);
      assert.equal(everything.includes(FAKE_TOKEN), false);
      assert.equal(/auth-tokens?/i.test(everything), false);
      assert.equal('AI_MEMORY_AUTH_TOKEN' in (spawned.options.env ?? {}), false);
    }
    assert.equal(JSON.stringify(outputs).includes(FAKE_TOKEN), false);
    assert.equal(/token/i.test(JSON.stringify(outputs)), false, 'no token field is read (#733/AC-4)');
  });
});

describe('#719/AC-11 nothing from the memory module leaves the machine (#727/AC-5)', () => {
  /*
   * The proof is structural (#727/AC-5). The hub has no code yet (decision 0002) and the one outbound path that
   * exists is the OTLP observer; a payload can carry a field of the module only if the code that
   * builds it can reach the module. So: no module outside memory/ imports it, but the ones listed
   * here. The list is empty today; adding a name to it is a review decision, and it may never hold
   * observability, telemetry, a hub or a remote sender. #735: the three files of the local read routes and the composition root that builds the module
   * (the routes answer the interface of this machine only); a test file may import the module, it sends nothing.
   */
  const ALLOWED_IMPORTERS: string[] = ['packages/nucleo/src/api/cli.ts', 'packages/nucleo/src/api/memory-route.ts', 'packages/nucleo/src/api/memory-view.ts'];
  const NEVER_ALLOWED = [/\/observability\//, /\/telemetry\//, /hub/i, /remote/i, /otel/i];
  const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

  function importsOfMemory(): string[] {
    const found: string[] = [];
    let scanned = 0;
    const roots = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'apps')];
    for (const root of roots) {
      for (const path of files(root, (p) => isSource(p) && !p.includes('/node_modules/'))) {
        if (path.startsWith(`${MEMORY_DIR}/`) || path === THIS_FILE || /\.test\.[a-z]+$/.test(path) || path.includes('/test/')) continue;
        scanned += 1;
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(SPECIFIER)) {
          const segments = match[1]!.split('/');
          if (segments.includes('memory')) found.push(relative(REPO_ROOT, path));
        }
      }
    }
    assert.ok(scanned > 100, `the scan found the repository sources, not ${scanned} files (#727)`);
    return [...new Set(found)].sort();
  }

  test('#719/AC-11 no module outside src/memory/ imports the memory module, except the allowlist', () => {
    assert.deepEqual(importsOfMemory().filter((p) => !ALLOWED_IMPORTERS.includes(p)), []);
  });

  test('#719/AC-11 the allowlist never holds an observability, telemetry, hub or remote sender', () => {
    for (const allowed of ALLOWED_IMPORTERS) {
      for (const never of NEVER_ALLOWED) assert.equal(never.test(allowed), false, `${allowed} may not import the memory module`);
    }
  });

  test('#719/AC-11 the module itself opens no network, observer or telemetry channel', () => {
    for (const path of memorySources()) {
      const text = readFileSync(path, 'utf8');
      assert.equal(/node:(?:http|https|net|tls|dgram|http2)|\bfetch\s*\(|WebSocket|observability|telemetry|opentelemetry/i.test(text), false, `${relative(MEMORY_DIR, path)} reaches a network or a sender`);
    }
  });

  test('#719/AC-11 #734/D3 nothing under src/mcp imports the memory module: no ai-memory data enters the console MCP in phase 1', () => {
    const mcpFiles = files(join(TEST_DIR, '..', 'src', 'mcp'), isSource);
    assert.ok(mcpFiles.length > 3, `the scan found the console MCP sources, not ${mcpFiles.length} files (#734)`);
    const importing = mcpFiles.filter((path) => [...readFileSync(path, 'utf8').matchAll(SPECIFIER)].some((m) => m[1]!.split('/').includes('memory') || /embedded-ai-memory/.test(m[1]!)));
    assert.deepEqual(importing.map((p) => relative(REPO_ROOT, p)), []);
    assert.equal(ALLOWED_IMPORTERS.some((p) => p.includes('/src/mcp/')), false, 'the console MCP is never an importer in phase 1 (#734)');
  });

  test('#719/AC-11 the scan sees an import of the module (so an empty result means something)', () => {
    const probe = `import { x } from '../memory/memory.ts';`;
    const seen = [...probe.matchAll(SPECIFIER)].some((m) => m[1]!.split('/').includes('memory'));
    assert.equal(seen, true);
    const other = `import { x } from './embedded-ai-memory.ts';`;
    assert.equal([...other.matchAll(SPECIFIER)].some((m) => m[1]!.split('/').includes('memory')), false);
  });
});

describe('#735/AC-3 #719/AC-11 a local path or a personal field of the ai-memory never leaves the machine (#735/D3)', () => {
  const SRC = join(TEST_DIR, '..', 'src');
  // data_dir, db_path, config_path and the service path are local paths; owner_user and accepted_by_user are personal data (#735). The cwd of a handoff is a local path too,
  // but the MCP and the telemetry name `cwd` legitimately for sessions, so two proofs split the surfaces (#735):
  // - the import scan above is the proof for the MCP and the telemetry (no file of theirs reaches the module that reads the handoffs);
  // - the pattern with `cwd` is the proof for the two static surfaces the import scan cannot see, the remote contract (a JSON document) and the observability exporter (#735).
  const LOCAL_FIELDS = /data_dir|db_path|config_path|service_path|owner_user|accepted_by_user/;
  const LOCAL_FIELDS_AND_CWD = new RegExp(`\\bcwd\\b|${LOCAL_FIELDS.source}`);
  const ONLY_HERE = (path: string) => path.startsWith(`${MEMORY_DIR}/`) || relative(REPO_ROOT, path) === 'packages/nucleo/src/api/memory-view.ts';

  const OUTBOUND: [string, () => string[], RegExp][] = [
    ['the console MCP, every tool output', () => files(join(SRC, 'mcp'), isSource), LOCAL_FIELDS],
    ['the telemetry, every payload', () => files(join(SRC, 'telemetry'), isSource), LOCAL_FIELDS],
    ['the observability exporter', () => files(join(SRC, 'observability'), isSource), LOCAL_FIELDS_AND_CWD],
    ['the remote contract (packages/nucleo/remote-contract.json)', () => [join(TEST_DIR, '..', 'remote-contract.json')], LOCAL_FIELDS_AND_CWD],
    ['the hub, wherever its code appears', () => files(join(REPO_ROOT, 'packages'), (p) => isSource(p) && /hub/i.test(relative(REPO_ROOT, p)) && !p.includes('/node_modules/')), LOCAL_FIELDS],
  ];
  for (const [name, list, pattern] of OUTBOUND) {
    test(`#735/AC-3 #719/AC-11 ${name} names none of the local fields`, () => {
      const found = list().filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((p) => relative(REPO_ROOT, p));
      assert.deepEqual(found, []);
    });
  }

  test('#735/AC-3 the scan reads the outbound contracts it names (so an empty result means something)', () => {
    assert.ok(OUTBOUND[0]![1]().length > 3);
    assert.ok(OUTBOUND[1]![1]().length > 10);
    assert.equal(OUTBOUND[3]![1]().length, 1);
  });

  test('#735/AC-3 outside the memory module and the view that puts them under local, no source of the repository names a local field', () => {
    const named: string[] = [];
    for (const root of [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'apps')]) {
      for (const path of files(root, (p) => isSource(p) && !p.includes('/node_modules/') && !isTest(p) && !/\/test\//.test(p))) {
        if (!ONLY_HERE(path) && LOCAL_FIELDS.test(readFileSync(path, 'utf8'))) named.push(relative(REPO_ROOT, path));
      }
    }
    assert.deepEqual(named, []);
  });

  test('#735/AC-3 the scan of the static surfaces also sees a cwd (a planted line is reported)', () => {
    assert.equal(LOCAL_FIELDS_AND_CWD.test('{ "cwd": "/somewhere" }'), true);
    assert.equal(LOCAL_FIELDS_AND_CWD.test('{ "cwdx": 1 }'), false);
    assert.equal(LOCAL_FIELDS_AND_CWD.test('const x = { owner_user: 1 }'), true);
  });

  test('#735/AC-3 the scan sees a local field (a planted line is reported)', () => {
    assert.equal(LOCAL_FIELDS.test('const x = { owner_user: 1 }'), true);
    assert.equal(LOCAL_FIELDS.test('const x = { owner: 1 }'), false);
  });
});

describe('#735/AC-5 #719/AC-10 the route files never touch the token either', () => {
  const ROUTE_FILES = ['memory-route.ts', 'memory-view.ts'].map((name) => join(TEST_DIR, '..', 'src', 'api', name));

  test('#719/AC-10 the route files name no auth-token path, read no file and open no network', () => {
    for (const path of ROUTE_FILES) {
      const text = readFileSync(path, 'utf8');
      assert.equal(/auth-tokens?/i.test(text), false, `${relative(REPO_ROOT, path)} names an auth-token path`);
      assert.equal(/node:fs|readFile|createReadStream|\bfetch\s*\(|^import (?!type).*node:(?:http|https|net|tls)/m.test(text), false, `${relative(REPO_ROOT, path)} reads a file or opens a channel (a type-only import of node:http is not one)`);
      assert.equal(/\blog\s*\(|console\./.test(text), false, `${relative(REPO_ROOT, path)} writes a log line`);
    }
  });
});
