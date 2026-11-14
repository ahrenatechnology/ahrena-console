/*
 * The per-OS read-only diagnosis collectors (#565): parsers on captured outputs, and the collectors
 * driven with a recording command runner, so no real tool runs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CATALOG } from '../src/diagnosis/adapters/catalog.ts';
import { DiagnosisCollector, stripControlCharacters, LARGEST_FOLDERS_BUDGET_MS, LARGEST_FOLDERS_CONCURRENCY, type DiagnosisDeps, type DiagnosisFs, type RunOptions, type RunResult } from '../src/diagnosis/adapters/common.ts';
import { DarwinDiagnosisCollector } from '../src/diagnosis/adapters/darwin.ts';
import { LinuxDiagnosisCollector } from '../src/diagnosis/adapters/linux.ts';
import { parseDockerDf, parseDuSize, parseJournalUsage, parsePsProcesses } from '../src/diagnosis/adapters/parsers.ts';
import type { SectionId } from '../src/diagnosis/model.ts';
import { systemFs, systemReadFile, worktreeRootsOf } from '../src/diagnosis/adapters/system.ts';

const HOME = '/home/dev';
const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 86_400_000;

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

interface Call {
  command: string;
  args: readonly string[];
  options: RunOptions;
}
type Answer = RunResult | ((call: Call) => RunResult);
const ok = (stdout: string): RunResult => ({ ok: true, stdout });
const fail = (why: Extract<RunResult, { ok: false }>['why']): RunResult => ({ ok: false, why });

function setup(answers: Record<string, Answer>, over: { files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number>; exists?: string[] } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const dirs = over.dirs ?? {};
  const fs: DiagnosisFs = {
    isDirectory: async (p) => p in dirs || Object.values(dirs).some((l) => l.includes(p)),
    listDirs: async (p) => dirs[p] ?? [],
    modifiedAtMs: async (p) => over.mtimes?.[p] ?? null,
    exists: async (p) => (over.exists ?? []).includes(p) || p in dirs,
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
    log: (message) => logs.push(message),
  };
  return { calls, deps, logs };
}
const ctx = (mount: string | null = null, signal = new AbortController().signal) => ({ mount, signal });
const collect = <K extends SectionId>(c: DiagnosisCollector, id: K, mount: string | null = null) => c.collect(id, ctx(mount));

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

  test('du size reads the total of the working directory', () => {
    assert.equal(parseDuSize('57344\t.\n'), 57344 * 1024);
    assert.equal(parseDuSize(''), null);
  });
});

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
    assert.ok(!Array.isArray(r) && 'unavailable' in r);
  });

  test('#565/AC-6 a missing, slow or aborted tool makes only its section unavailable, with a short reason', async () => {
    const { deps } = setup({});
    const missing = await collect(new DarwinDiagnosisCollector(deps), 'processes-by-rss');
    assert.deepEqual(missing, { unavailable: true, reason: 'ps not found' });
    const slow = setup({ [['ps', ...CATALOG.ps.args].join(' ')]: fail('timeout') });
    assert.deepEqual(await collect(new LinuxDiagnosisCollector(slow.deps), 'processes-by-cpu'), { unavailable: true, reason: 'ps timed out' });
    const aborted = setup({ [['ps', ...CATALOG.ps.args].join(' ')]: fail('aborted') });
    const r = await collect(new LinuxDiagnosisCollector(aborted.deps), 'processes-by-cpu');
    assert.ok(!Array.isArray(r) && 'unavailable' in r);
  });

  test('#565/AC-6 ps output that cannot be parsed is unavailable, not an empty ok section', async () => {
    for (const out of ['', 'garbage\nmore garbage\n']) {
      const { deps } = setup({ [['ps', ...CATALOG.ps.args].join(' ')]: ok(out) });
      assert.deepEqual(await collect(new LinuxDiagnosisCollector(deps), 'processes-by-rss'), { unavailable: true, reason: 'ps output not understood' });
    }
  });

  test('#565/AC-6 docker system df output that cannot be parsed is unavailable, not an empty ok section', async () => {
    for (const out of ['', 'Cannot connect to the Docker daemon\n']) {
      const { deps } = setup({ [['docker', ...CATALOG['docker-df'].args].join(' ')]: ok(out) });
      assert.deepEqual(await collect(new LinuxDiagnosisCollector(deps), 'docker-df'), { unavailable: true, reason: 'docker output not understood' });
    }
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

describe('volume sections', () => {
  const dfKey = ['df', ...CATALOG.df.args].join(' ');
  const folderKey = (cwd: string) => `du ${CATALOG['du-folder'].args.join(' ')} @${cwd}`;
  const byPath = (items: unknown) => [...(items as { path: string; bytes: number }[])].sort((x, y) => x.path.localeCompare(y.path));

  test('#565/AC-3 the largest folders are measured one by one under the mount, each as the working directory, and the big ones are opened', async () => {
    const { calls, deps } = setup(
      { [dfKey]: ok(DF), [folderKey('/data/a')]: ok('1000\t.\n'), [folderKey('/data/b')]: ok('500\t.\n'), [folderKey('/data/a/x')]: ok('600\t.\n'), [folderKey('/data/a/y')]: ok('300\t.\n') },
      { dirs: { '/data': ['a', 'b'], '/data/a': ['x', 'y'], '/data/b': [] } },
    );
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.deepEqual(byPath(r), [
      { path: '/data/a/x', bytes: 600 * 1024 },
      { path: '/data/a/y', bytes: 300 * 1024 },
      { path: '/data/b', bytes: 500 * 1024 },
    ]);
    const du = calls.filter((x) => x.command === 'du');
    assert.ok(du.length > 0 && du.every((x) => x.args.join(' ') === CATALOG['du-folder'].args.join(' ') && x.options.cwd?.startsWith('/data/')));
  });

  test('#565/AC-3 a folder that does not finish is left out and logged, the others still answer', async () => {
    const { deps, logs } = setup(
      { [dfKey]: ok(DF), [folderKey('/data/a')]: ok('1000\t.\n'), [folderKey('/data/b')]: fail('timeout') },
      { dirs: { '/data': ['a', 'b'], '/data/a': [], '/data/b': [] } },
    );
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.deepEqual(r, { items: [{ path: '/data/a', bytes: 1000 * 1024 }], partial: { reason: 'some folders could not be measured' } });
    assert.ok(logs.some((l) => l.includes('/data/b') && l.includes('du') && l.includes('timed out')));
  });

  test('#565/AC-3 a folder opened only in part keeps its own measured size and the section is marked partial', async () => {
    const { deps } = setup(
      { [dfKey]: ok(DF), [folderKey('/data/a')]: ok('1000\t.\n'), [folderKey('/data/b')]: ok('500\t.\n'), [folderKey('/data/a/x')]: ok('600\t.\n'), [folderKey('/data/a/y')]: fail('failed') },
      { dirs: { '/data': ['a', 'b'], '/data/a': ['x', 'y'], '/data/b': [] } },
    );
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.ok(!Array.isArray(r) && 'partial' in r);
    assert.deepEqual(byPath(r.items), [
      { path: '/data/a', bytes: 1000 * 1024 },
      { path: '/data/b', bytes: 500 * 1024 },
    ]);
    assert.ok(r.partial.reason.length > 0 && r.partial.reason.length <= 120);
  });

  test('#565/AC-3 a scan that hits its budget while opening a folder keeps the parent and is marked partial', async () => {
    const { deps } = setup(
      { [dfKey]: ok(DF), [folderKey('/data/a')]: ok('1000\t.\n') },
      { dirs: { '/data': ['a'], '/data/a': ['x'] } },
    );
    deps.largestFoldersBudgetMs = 40;
    const inner = deps.run;
    deps.run = (command, args, options) =>
      command === 'du' && options.cwd === '/data/a/x' ? new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(fail('aborted')))) : inner(command, args, options);
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.ok(!Array.isArray(r) && 'partial' in r);
    assert.deepEqual(r.items, [{ path: '/data/a', bytes: 1000 * 1024 }]);
  });

  test('#565/AC-3 a scan that finds everything is not marked partial', async () => {
    const { deps } = setup({ [dfKey]: ok(DF), [folderKey('/data/a')]: ok('1000\t.\n') }, { dirs: { '/data': ['a'], '/data/a': [] } });
    assert.ok(Array.isArray(await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data')));
  });

  test('#565/AC-6 the df call of largest-folders runs inside the section deadline', async () => {
    const { deps } = setup({}, { dirs: { '/data': ['a'] } });
    deps.largestFoldersBudgetMs = 40;
    let dfSignal: AbortSignal | undefined;
    deps.run = (command, _args, options) => {
      if (command !== 'df') return Promise.resolve(fail('missing'));
      dfSignal = options.signal;
      return new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(fail('aborted'))));
    };
    const controller = new AbortController();
    const started = Date.now();
    const r = await new LinuxDiagnosisCollector(deps).collect('largest-folders', { mount: '/data', signal: controller.signal });
    assert.deepEqual(r, { unavailable: true, reason: 'df aborted' });
    assert.ok(Date.now() - started < 2_000);
    assert.notEqual(dfSignal, controller.signal);
    assert.equal(controller.signal.aborted, false);
  });

  test('#565/AC-6 df, the first pass and the opening pass all share one deadline counted from the section start', async () => {
    const { deps } = setup({ [dfKey]: ok(DF), [folderKey('/data/a')]: ok('1\t.\n') }, { dirs: { '/data': ['a'], '/data/a': [] } });
    deps.largestFoldersBudgetMs = 100;
    const signals: AbortSignal[] = [];
    const inner = deps.run;
    deps.run = (command, args, options) => (signals.push(options.signal), inner(command, args, options));
    await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(signals.length >= 2 && signals.every((s) => s.aborted), 'every subprocess signal is bound to the section deadline');
  });

  test('#565/AC-3 when no folder could be measured the section is unavailable', async () => {
    const { deps } = setup({ [dfKey]: ok(DF) }, { dirs: { '/data': ['a'] } });
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.ok(!Array.isArray(r) && 'unavailable' in r);
  });

  test('#565/AC-3 another mount under the volume is not scanned as part of it', async () => {
    const { calls, deps } = setup({ [dfKey]: ok(DF), [folderKey('/usr')]: ok('10\t.\n') }, { dirs: { '/': ['usr', 'data'], '/usr': [] } });
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/');
    assert.deepEqual(r, [{ path: '/usr', bytes: 10 * 1024 }]);
    assert.ok(calls.every((x) => x.options.cwd !== '/data'));
  });

  test('#565/AC-3 at most the bounded number of measurements run at once', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const { deps } = setup({ [dfKey]: ok(DF) }, { dirs: { '/data': names } });
    let inFlight = 0;
    let peak = 0;
    const inner = deps.run;
    deps.run = async (command, args, options) => {
      if (command !== 'du') return inner(command, args, options);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return ok('1\t.\n');
    };
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.ok(Array.isArray(r) && r.length === 20);
    assert.ok(peak > 1 && peak <= LARGEST_FOLDERS_CONCURRENCY, String(peak));
  });

  test('#565/AC-3 the scan stops at its own budget, which stays inside the section timeout the route uses', async () => {
    assert.ok(LARGEST_FOLDERS_BUDGET_MS <= 15_000);
    const { deps } = setup({ [dfKey]: ok(DF) }, { dirs: { '/data': ['a', 'b'] } });
    deps.largestFoldersBudgetMs = 40;
    const inner = deps.run;
    deps.run = (command, args, options) =>
      command !== 'du' ? inner(command, args, options) : new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(fail('aborted'))));
    const started = Date.now();
    const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.ok(!Array.isArray(r) && 'unavailable' in r);
    assert.ok(Date.now() - started < 2_000);
  });

  test('#565/AC-7 a mount the core did not enumerate is unavailable and never reaches a command', async () => {
    for (const hostile of ['/etc/../root', '/; rm -rf /', '/nope', '', null]) {
      const { calls, deps } = setup({ [dfKey]: ok(DF) });
      const r = await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', hostile);
      assert.ok(!Array.isArray(r) && 'unavailable' in r, String(hostile));
      assert.ok(calls.every((x) => x.command === 'df' && !x.options.cwd && !x.args.some((a) => a.includes('rm'))));
    }
  });

  test('#565/AC-6 docker missing or journalctl missing is unavailable while others still answer', async () => {
    const { deps } = setup({ [['du', ...CATALOG['du-folder'].args].join(' ') + ' @/x']: ok('1\t.\n'), [dfKey]: ok(DF) }, { dirs: { '/': ['x'] } });
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
    assert.ok(!Array.isArray(r) && 'unavailable' in r);
  });
});

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
        exists: [`${old}/.git`, `${fresh}/.git`, `${dirty}/.git`],
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
    const { deps } = setup({ [sizeKey(old)]: ok('300\t.\n') }, { dirs: { [ROOT]: ['old-one'], [old]: [] }, mtimes: { [old]: NOW_MS - 30 * DAY }, exists: [`${old}/.git`] });
    const r = (await collect(new LinuxDiagnosisCollector(deps), 'known-caches')) as { hasUncommitted: boolean; hasUnpushed: boolean }[];
    assert.deepEqual([r[0].hasUncommitted, r[0].hasUnpushed], [true, true]);
  });

  test('#565/AC-9 a folder under worktrees without its own .git is not a worktree and is never run in', async () => {
    const stray = `${ROOT}/stray`;
    const { calls, deps } = setup({ [sizeKey(stray)]: ok('300\t.\n') }, { dirs: { [ROOT]: ['stray'], [stray]: [] }, mtimes: { [stray]: NOW_MS - 30 * DAY } });
    assert.deepEqual(await collect(new LinuxDiagnosisCollector(deps), 'known-caches'), []);
    assert.ok(calls.every((x) => x.options.cwd !== stray));
  });

  test('#565/AC-11 a cache whose size cannot be read is dropped and logged with its tool and reason', async () => {
    const { deps, logs } = setup({ [sizeKey(`${HOME}/.npm`)]: fail('timeout') }, { dirs: { [`${HOME}/.npm`]: [] } });
    assert.deepEqual(await collect(new LinuxDiagnosisCollector(deps), 'known-caches'), []);
    assert.ok(logs.some((l) => l.includes(`${HOME}/.npm`) && l.includes('du') && l.includes('timed out')));
  });

  test('#565/AC-9 a worktree whose size cannot be read is dropped and logged with its tool and reason', async () => {
    const old = `${ROOT}/old-one`;
    const { deps, logs } = setup({ [sizeKey(old)]: fail('failed') }, { dirs: { [ROOT]: ['old-one'], [old]: [] }, mtimes: { [old]: NOW_MS - 30 * DAY }, exists: [`${old}/.git`] });
    assert.deepEqual(await collect(new LinuxDiagnosisCollector(deps), 'known-caches'), []);
    assert.ok(logs.some((l) => l.includes(old) && l.includes('du') && l.includes('did not answer')));
  });

  test('#565/AC-9 the worktree roots come from the repository folders the caller passes', () => {
    assert.deepEqual(worktreeRootsOf(['/w/org/repo-a', '/w/org/repo-b']), ['/w/org/repo-a/.claude/worktrees', '/w/org/repo-b/.claude/worktrees']);
  });
});

describe('the real file reads', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const failing = (code: string) => ({
    stat: async () => {
      throw errno(code);
    },
    readdir: async () => {
      throw errno(code);
    },
    readFile: async () => {
      throw errno(code);
    },
  });

  test('#565/AC-11 an absent path (ENOENT, ENOTDIR) answers no, empty or null without a log line', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const logs: string[] = [];
      const fs = systemFs((m) => logs.push(m), failing(code));
      assert.equal(await fs.isDirectory('/x'), false);
      assert.deepEqual(await fs.listDirs('/x'), []);
      assert.equal(await fs.modifiedAtMs('/x'), null);
      assert.equal(await fs.exists('/x'), false);
      assert.equal(await systemReadFile((m) => logs.push(m), failing(code))('/x'), null);
      assert.deepEqual(logs, []);
    }
  });

  test('#565/AC-11 any other error (EACCES) is logged with the path and the code, and the path counts as absent', async () => {
    const logs: string[] = [];
    const fs = systemFs((m) => logs.push(m), failing('EACCES'));
    assert.equal(await fs.isDirectory('/secret'), false);
    assert.deepEqual(await fs.listDirs('/secret'), []);
    assert.equal(await fs.modifiedAtMs('/secret'), null);
    assert.equal(await fs.exists('/secret'), false);
    assert.equal(await systemReadFile((m) => logs.push(m), failing('EACCES'))('/secret'), null);
    assert.equal(logs.length, 5);
    assert.ok(logs.every((l) => l.includes('/secret') && l.includes('EACCES')));
  });

  test('#565/AC-11 a path with a line break cannot forge a log line', async () => {
    const logs: string[] = [];
    await systemFs((m) => logs.push(m), failing('EACCES')).isDirectory('/a\nforged line');
    assert.equal(logs.length, 1);
    assert.ok(!/[\x00-\x1f\x7f]/.test(logs[0]));
  });
});

describe('what a diagnosis log line may carry', () => {
  const dfKey = ['df', ...CATALOG.df.args].join(' ');

  test('#565/AC-3 control characters are stripped from a text before it is logged', () => {
    assert.equal(stripControlCharacters('a\nb\r\tc\u0000d\u007fe'), 'abcde');
  });

  test('#565/AC-3 the C1 range, the next line, and the line and paragraph separators are stripped too', () => {
    assert.equal(stripControlCharacters('a\u0080b\u0085c\u009fd'), 'abcd');
    assert.equal(stripControlCharacters('a\u2028b'), 'ab');
    assert.equal(stripControlCharacters('a\u2029b'), 'ab');
    assert.equal(stripControlCharacters('caf\u00e9 \u00a0ok'), 'caf\u00e9 \u00a0ok');
  });

  test('#565/AC-3 a folder name with a line break does not forge a log line when its measurement fails', async () => {
    const evil = 'x\n2026-11-14 forged entry';
    const { deps, logs } = setup({ [dfKey]: ok(DF) }, { dirs: { '/data': [evil] } });
    await collect(new LinuxDiagnosisCollector(deps), 'largest-folders', '/data');
    assert.ok(logs.length > 0);
    assert.ok(logs.every((l) => !/[\x00-\x1f\x7f]/.test(l)));
    assert.ok(logs.some((l) => l.includes('forged entry')));
  });

  test('#565/AC-11 a cache path with a line break does not forge a log line when its size cannot be read', async () => {
    const { deps, logs } = setup({}, { dirs: { '/home/de\nv/.npm': [] } });
    await collect(new LinuxDiagnosisCollector({ ...deps, home: '/home/de\nv' }), 'known-caches');
    assert.ok(logs.some((l) => l.includes('/home/dev/.npm')));
    assert.ok(logs.every((l) => !/[\x00-\x1f\x7f]/.test(l)));
  });

  test('#565/AC-9 a rejecting worktreeRoots is logged and the measured caches survive', async () => {
    const sizeKey = (cwd: string) => `du ${CATALOG['du-size'].args.join(' ')} @${cwd}`;
    const { deps, logs } = setup({ [sizeKey(`${HOME}/.npm`)]: ok('2048\t.\n') }, { dirs: { [`${HOME}/.npm`]: [] } });
    deps.worktreeRoots = async () => {
      throw new Error('sessions store unreadable');
    };
    const r = await collect(new LinuxDiagnosisCollector(deps), 'known-caches');
    assert.deepEqual(r, [{ id: 'npm-cache', path: `${HOME}/.npm`, bytes: 2048 * 1024, actionId: 'npm-cache' }]);
    assert.ok(logs.some((l) => l.includes('diagnosis worktree roots failed') && l.includes('sessions store unreadable')));
  });
});

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
