/*
 * The per-OS read-only diagnosis collectors (#565): parsers on captured outputs, and the collectors
 * driven with a recording command runner, so no real tool runs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CATALOG } from '../src/diagnosis/adapters/catalog.ts';
import { DiagnosisCollector, defaultWorktreeRoots, type DiagnosisDeps, type DiagnosisFs, type RunOptions, type RunResult } from '../src/diagnosis/adapters/common.ts';
import { DarwinDiagnosisCollector } from '../src/diagnosis/adapters/darwin.ts';
import { LinuxDiagnosisCollector } from '../src/diagnosis/adapters/linux.ts';
import { parseDockerDf, parseDuSize, parseDuTree, parseJournalUsage, parsePsProcesses } from '../src/diagnosis/adapters/parsers.ts';
import type { SectionId } from '../src/diagnosis/model.ts';

const HOME = '/home/dev';
const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 86_400_000;

// ---- captured outputs -----------------------------------------------------------------------------

const PS_DARWIN = [
  '  412  56.2 1048576 Sat Nov 14 08:15:02 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '    1   0.0    9216 Mon Nov  2 07:00:01 2026 /sbin/launchd',
  '  980 102.4 2097152 Fri Nov 13 22:01:09 2026 /opt/homebrew/bin/colima-vm',
  'garbage line',
].join('\n');
const PS_LINUX = '  731  3.5  524288 Sat Nov 14 09:00:00 2026 next-server\n';

const SWAP_DARWIN = 'vm.swapusage: total = 2048.00M  used = 819.25M  free = 1228.75M  (encrypted)\n';
const MEMINFO = 'MemTotal:       16384000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n';
const MEMINFO_NO_SWAP = 'MemTotal:       16384000 kB\n';

const DF = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/sda1        100000000  91000000   9000000      91% /',
  '/dev/sdb1        500000000 100000000 400000000      20% /data',
  'tmpfs               100000         0    100000       0% /run/user/1000',
].join('\n');
const DU_TREE = ['4096\t./usr/lib', '20480\t./usr/share', '24576\t./usr', '8192\t./var', '1024\t./empty', '57344\t.'].join('\n');
const DOCKER_DF = [
  '{"Type":"Images","TotalCount":"12","Active":"3","Size":"4.5GB","Reclaimable":"3.2GB (71%)"}',
  '{"Type":"Containers","TotalCount":"5","Active":"2","Size":"120MB","Reclaimable":"0B (0%)"}',
  '{"Type":"Build Cache","TotalCount":"40","Active":"0","Size":"1.5kB","Reclaimable":"1.5kB"}',
].join('\n');
const JOURNAL = 'Archived and active journals take up 1.2G in the file system.\n';

// ---- the recording runner ----------------------------------------------------------------------------

interface Call {
  command: string;
  args: readonly string[];
  options: RunOptions;
}
type Answer = RunResult | ((call: Call) => RunResult);
const ok = (stdout: string): RunResult => ({ ok: true, stdout });
const fail = (why: Extract<RunResult, { ok: false }>['why']): RunResult => ({ ok: false, why });

function setup(answers: Record<string, Answer>, over: { files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number> } = {}) {
  const calls: Call[] = [];
  const dirs = over.dirs ?? {};
  const fs: DiagnosisFs = {
    isDirectory: async (p) => p in dirs || Object.values(dirs).some((l) => l.includes(p)),
    listDirs: async (p) => dirs[p] ?? [],
    modifiedAtMs: async (p) => over.mtimes?.[p] ?? null,
  };
  const deps: DiagnosisDeps = {
    run: async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      const key = [command, ...args].join(' ') + (options.cwd ? ` @${options.cwd}` : '');
      const answer = answers[key] ?? answers[[command, ...args].join(' ')];
      if (answer === undefined) return fail('missing');
      return typeof answer === 'function' ? answer(call) : answer;
    },
    readFile: async (p) => over.files?.[p] ?? null,
    fs,
    home: HOME,
    worktreeRoots: async () => Object.keys(dirs).filter((d) => d.endsWith('/.claude/worktrees')),
    nowMs: () => NOW_MS,
  };
  return { calls, deps };
}
const ctx = (mount: string | null = null, signal = new AbortController().signal) => ({ mount, signal });
const collect = <K extends SectionId>(c: DiagnosisCollector, id: K, mount: string | null = null) => c.collect(id, ctx(mount));

// ---- parsers ------------------------------------------------------------------------------------------

describe('diagnosis parsers', () => {
  test('ps rows become processes with basename, bytes and the start as ISO', () => {
    const rows = parsePsProcesses(PS_DARWIN);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { pid: 412, name: 'Google Chrome', rssBytes: 1048576 * 1024, cpuPct: 56.2, startedAt: new Date(2026, 10, 14, 8, 15, 2).toISOString() });
    assert.equal(rows[1].startedAt, new Date(2026, 10, 2, 7, 0, 1).toISOString());
    assert.equal(parsePsProcesses(PS_LINUX)[0].name, 'next-server');
  });

  test('docker system df rows use the decimal units docker prints', () => {
    assert.deepEqual(parseDockerDf(DOCKER_DF), [
      { type: 'Images', usedBytes: 4_500_000_000, reclaimableBytes: 3_200_000_000 },
      { type: 'Containers', usedBytes: 120_000_000, reclaimableBytes: 0 },
      { type: 'Build Cache', usedBytes: 1500, reclaimableBytes: 1500 },
    ]);
    assert.deepEqual(parseDockerDf('not json\n'), []);
  });

  test('journalctl --disk-usage uses binary units', () => {
    assert.equal(parseJournalUsage(JOURNAL), Math.round(1.2 * 1024 ** 3));
    assert.equal(parseJournalUsage('nothing here'), null);
  });

  test('du tree keeps the deepest folders under the mount, as absolute paths', () => {
    assert.deepEqual(parseDuTree(DU_TREE, '/'), [
      { path: '/usr/lib', bytes: 4096 * 1024 },
      { path: '/usr/share', bytes: 20480 * 1024 },
      { path: '/var', bytes: 8192 * 1024 },
      { path: '/empty', bytes: 1024 * 1024 },
    ]);
    assert.equal(parseDuTree('100\t./a/b\n', '/data')[0].path, '/data/a/b');
  });

  test('du size reads the total of the working directory', () => {
    assert.equal(parseDuSize('57344\t.\n'), 57344 * 1024);
    assert.equal(parseDuSize(''), null);
  });
});

// ---- processes and swap -----------------------------------------------------------------------------

describe('process and swap sections', () => {
  const psKey = ['ps', ...CATALOG.ps.args].join(' ');

  test('#565/AC-1 darwin returns processes for rss and for cpu from one fixed ps, and the swap', async () => {
    const { calls, deps } = setup({ [psKey]: ok(PS_DARWIN), 'sysctl vm.swapusage': ok(SWAP_DARWIN) });
    const c = new DarwinDiagnosisCollector(deps);
    const rss = await collect(c, 'processes-by-rss');
    const cpu = await collect(c, 'processes-by-cpu');
    assert.ok(Array.isArray(rss) && rss.length === 3 && rss[2].name === 'colima-vm');
    assert.deepEqual(cpu, rss);
    assert.deepEqual(await collect(c, 'swap'), [{ usedBytes: Math.round(819.25 * 1024 ** 2), totalBytes: 2048 * 1024 ** 2 }]);
    assert.deepEqual(calls.filter((x) => x.command === 'ps').map((x) => x.args), [CATALOG.ps.args, CATALOG.ps.args]);
  });

  test('#565/AC-1 linux reads the swap from /proc/meminfo, and a machine without swap data is unavailable', async () => {
    const { deps } = setup({}, { files: { '/proc/meminfo': MEMINFO } });
    assert.deepEqual(await collect(new LinuxDiagnosisCollector(deps), 'swap'), [{ usedBytes: 1048576 * 1024, totalBytes: 2097152 * 1024 }]);
    const none = setup({}, { files: { '/proc/meminfo': MEMINFO_NO_SWAP } });
    const r = await collect(new LinuxDiagnosisCollector(none.deps), 'swap');
    assert.ok(!Array.isArray(r) && r.unavailable);
  });

  test('#565/AC-6 a missing, slow or aborted tool makes only its section unavailable, with a short reason', async () => {
    const { deps } = setup({});
    const missing = await collect(new DarwinDiagnosisCollector(deps), 'processes-by-rss');
    assert.deepEqual(missing, { unavailable: true, reason: 'ps not found' });
    const slow = setup({ [['ps', ...CATALOG.ps.args].join(' ')]: fail('timeout') });
    assert.deepEqual(await collect(new LinuxDiagnosisCollector(slow.deps), 'processes-by-cpu'), { unavailable: true, reason: 'ps timed out' });
    const aborted = setup({ [['ps', ...CATALOG.ps.args].join(' ')]: fail('aborted') });
    const r = await collect(new LinuxDiagnosisCollector(aborted.deps), 'processes-by-cpu');
    assert.ok(!Array.isArray(r) && r.unavailable);
  });

  test('#565/AC-7 the abort signal and the catalog limits reach the runner', async () => {
    const controller = new AbortController();
    const { calls, deps } = setup({ [['ps', ...CATALOG.ps.args].join(' ')]: ok(PS_LINUX) });
    await new LinuxDiagnosisCollector(deps).collect('processes-by-rss', { mount: null, signal: controller.signal });
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[0].options.timeoutMs, CATALOG.ps.timeoutMs);
    assert.equal(calls[0].options.maxBytes, CATALOG.ps.maxBytes);
  });
});

// ---- volume sections --------------------------------------------------------------------------------

describe('volume sections', () => {
  const dfKey = ['df', ...CATALOG.df.args].join(' ');
  const duKey = (cwd: string) => `du ${CATALOG['du-tree'].args.join(' ')} @${cwd}`;

  test('#565/AC-3 the largest folders come from the mount the core itself read, as the working directory', async () => {
    const { calls, deps } = setup({ [dfKey]: ok(DF), [duKey('/data')]: ok('100\t./a\n50\t.\n') });
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.deepEqual(r, [{ path: '/data/a', bytes: 100 * 1024 }]);
    const du = calls.find((x) => x.command === 'du');
    assert.equal(du?.options.cwd, '/data');
    assert.deepEqual(du?.args, CATALOG['du-tree'].args);
  });

  test('#565/AC-7 a mount the core did not enumerate is unavailable and never reaches a command', async () => {
    for (const hostile of ['/etc/../root', '/; rm -rf /', '/nope', '', null]) {
      const { calls, deps } = setup({ [dfKey]: ok(DF) });
      const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', hostile);
      assert.ok(!Array.isArray(r) && r.unavailable, String(hostile));
      assert.ok(calls.every((x) => x.command === 'df' && !x.options.cwd && !x.args.some((a) => a.includes('rm'))));
    }
  });

  test('#565/AC-6 docker missing or journalctl missing is unavailable while others still answer', async () => {
    const { deps } = setup({ [['du', ...CATALOG['du-tree'].args].join(' ') + ' @/']: ok('1\t./x\n'), [dfKey]: ok(DF) });
    const c = new LinuxDiagnosisCollector(deps);
    assert.deepEqual(await collect(c, 'docker-df'), { unavailable: true, reason: 'docker not found' });
    assert.deepEqual(await collect(c, 'journal'), { unavailable: true, reason: 'journalctl not found' });
    assert.ok(Array.isArray(await collect(c, 'largest-folders', '/')));
  });

  test('#565/AC-3 docker df and the journal use their fixed commands', async () => {
    const { calls, deps } = setup({ [['docker', ...CATALOG['docker-df'].args].join(' ')]: ok(DOCKER_DF), 'journalctl --disk-usage': ok(JOURNAL) });
    const c = new LinuxDiagnosisCollector(deps);
    assert.equal(((await collect(c, 'docker-df')) as unknown[]).length, 3);
    assert.deepEqual(await collect(c, 'journal'), [{ bytes: Math.round(1.2 * 1024 ** 3) }]);
    assert.ok(calls.every((x) => x.options.timeoutMs > 0 && x.options.maxBytes > 0));
  });

  test('journal does not exist on the Mac', async () => {
    const { deps } = setup({ 'journalctl --disk-usage': ok(JOURNAL) });
    const r = await collect(new DarwinDiagnosisCollector(deps), 'journal');
    assert.ok(!Array.isArray(r) && r.unavailable);
  });
});

// ---- known caches and old worktrees ---------------------------------------------------------------------

describe('known-caches section', () => {
  const sizeKey = (cwd: string) => `du ${CATALOG['du-size'].args.join(' ')} @${cwd}`;
  const statusKey = (cwd: string) => `git ${CATALOG['git-status'].args.join(' ')} @${cwd}`;
  const unpushedKey = (cwd: string) => `git ${CATALOG['git-unpushed'].args.join(' ')} @${cwd}`;
  const ROOT = '/home/dev/Workspace/org/repo/.claude/worktrees';

  test('#565/AC-11 linux lists the caches that exist with their cleanup action ids', async () => {
    const { calls, deps } = setup(
      { [sizeKey(`${HOME}/.npm`)]: ok('2048\t.\n'), [sizeKey(`${HOME}/.cache/pip`)]: ok('1024\t.\n') },
      { dirs: { [`${HOME}/.npm`]: [], [`${HOME}/.cache/pip`]: [] } },
    );
    const r = await collect(new LinuxDiagnosisCollector(deps), 'known-caches');
    assert.deepEqual(r, [
      { id: 'npm-cache', path: `${HOME}/.npm`, bytes: 2048 * 1024, actionId: 'npm-cache' },
      { id: 'pip-cache', path: `${HOME}/.cache/pip`, bytes: 1024 * 1024, actionId: 'pip-cache' },
    ]);
    assert.ok(calls.filter((x) => x.command === 'du').every((x) => x.args.join(' ') === CATALOG['du-size'].args.join(' ')));
  });

  test('#565/AC-11 darwin adds Xcode DerivedData and keeps pip under Library/Caches', async () => {
    const xcode = `${HOME}/Library/Developer/Xcode/DerivedData`;
    const pip = `${HOME}/Library/Caches/pip`;
    const { deps } = setup({ [sizeKey(xcode)]: ok('10\t.\n'), [sizeKey(pip)]: ok('5\t.\n') }, { dirs: { [xcode]: [], [pip]: [] } });
    const r = (await collect(new DarwinDiagnosisCollector(deps), 'known-caches')) as { actionId: string | null }[];
    assert.deepEqual(r.map((x) => x.actionId), ['pip-cache', 'xcode-derived-data']);
  });

  test('#565/AC-9 each old worktree is its own item with last use and git state, run in its own directory', async () => {
    const old = `${ROOT}/old-one`;
    const fresh = `${ROOT}/fresh-one`;
    const dirty = `${ROOT}/old-dirty`;
    const { calls, deps } = setup(
      {
        [sizeKey(old)]: ok('300\t.\n'),
        [statusKey(old)]: ok(''),
        [unpushedKey(old)]: ok('0\n'),
        [sizeKey(dirty)]: ok('900\t.\n'),
        [statusKey(dirty)]: ok(' M a.ts\n'),
        [unpushedKey(dirty)]: ok('2\n'),
      },
      {
        dirs: { [ROOT]: ['old-one', 'fresh-one', 'old-dirty'], [old]: [], [fresh]: [], [dirty]: [] },
        mtimes: { [old]: NOW_MS - 30 * DAY, [fresh]: NOW_MS - 1 * DAY, [dirty]: NOW_MS - 20 * DAY },
      },
    );
    const r = await collect(new LinuxDiagnosisCollector(deps), 'known-caches');
    assert.deepEqual(r, [
      { id: 'worktree', path: old, bytes: 300 * 1024, lastUsedAt: new Date(NOW_MS - 30 * DAY).toISOString(), hasUncommitted: false, hasUnpushed: false, actionId: null },
      { id: 'worktree', path: dirty, bytes: 900 * 1024, lastUsedAt: new Date(NOW_MS - 20 * DAY).toISOString(), hasUncommitted: true, hasUnpushed: true, actionId: null },
    ]);
    const git = calls.filter((x) => x.command === 'git');
    assert.equal(git.length, 4);
    assert.ok(git.every((x) => x.options.cwd?.startsWith(ROOT) && x.args.every((a) => !a.includes('/'))));
    assert.ok(calls.every((x) => !x.args.some((a) => a.includes('old-') || a.includes('worktrees'))));
  });

  test('#565/AC-6 a missing git does not drop the worktree: the unknown state counts as not safe to remove', async () => {
    const old = `${ROOT}/old-one`;
    const { deps } = setup({ [sizeKey(old)]: ok('300\t.\n') }, { dirs: { [ROOT]: ['old-one'], [old]: [] }, mtimes: { [old]: NOW_MS - 30 * DAY } });
    const r = (await collect(new LinuxDiagnosisCollector(deps), 'known-caches')) as { hasUncommitted: boolean; hasUnpushed: boolean }[];
    assert.deepEqual([r[0].hasUncommitted, r[0].hasUnpushed], [true, true]);
  });

  test('worktree roots are found by the core under each repository of the workspace', async () => {
    const fs: DiagnosisFs = {
      isDirectory: async (p) => p.endsWith('/.claude/worktrees') && p.includes('/repo-a/'),
      listDirs: async (p) => ({ [`${HOME}/Workspace`]: ['org'], [`${HOME}/Workspace/org`]: ['repo-a', 'repo-b'] })[p] ?? [],
      modifiedAtMs: async () => null,
    };
    assert.deepEqual(await defaultWorktreeRoots(fs, HOME), [`${HOME}/Workspace/org/repo-a/.claude/worktrees`]);
  });
});

// ---- the catalog ----------------------------------------------------------------------------------------

describe('diagnosis catalog', () => {
  test('#565/AC-7 only read-only commands, fixed argv, every entry with a timeout and an output bound', () => {
    const allowed = new Set(['ps', 'sysctl', 'df', 'du', 'docker', 'journalctl', 'git']);
    for (const [id, entry] of Object.entries(CATALOG)) {
      assert.ok(allowed.has(entry.command), id);
      assert.ok(entry.timeoutMs > 0 && entry.timeoutMs <= 15_000, id);
      assert.ok(entry.maxBytes > 0 && entry.maxBytes <= 8 * 1024 * 1024, id);
      assert.ok(entry.args.every((a) => !/[;&|$`<>]/.test(a) || a.startsWith('{{')), id);
    }
    assert.deepEqual(CATALOG['git-status'].args.slice(0, 1), ['status']);
    assert.deepEqual(CATALOG['git-unpushed'].args.slice(0, 1), ['rev-list']);
    assert.deepEqual(CATALOG['docker-df'].args.slice(0, 2), ['system', 'df']);
  });
});
