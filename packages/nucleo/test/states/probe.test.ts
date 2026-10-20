import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { dirsFromLsof, isClaude, pidsFromPs, systemProcessProbe, fixedProbe } from '../../src/states/index.ts';

describe('reading the output', () => {
  test('recognizes Claude Code by the binary or by the npm package', () => {
    assert.equal(isClaude('claude'), true);
    assert.equal(isClaude('/opt/homebrew/bin/claude --resume abc'), true);
    assert.equal(isClaude('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), true);
    assert.equal(isClaude('/Applications/Claude.app/Contents/MacOS/Claude'), false);
    assert.equal(isClaude('vim claude.md'), false);
    // Claude Desktop runs its own binary, on a path with a space.
    assert.equal(isClaude('/Users/dev/Library/Application Support/Claude/claude-code/2.1.0/abc/claude.app/Contents/MacOS/claude --output-format stream-json --verbose'), true);
    assert.equal(isClaude('/usr/bin/grep claude'), false);
  });

  test('ps → pids', () => {
    const output = ['  101 /usr/local/bin/claude', '  202 vim notas.txt', '303 node /x/@anthropic-ai/claude-code/cli.js -c', ''].join('\n');
    assert.deepEqual(pidsFromPs(output), [101, 303]);
  });

  test('lsof → directories', () => {
    assert.deepEqual(dirsFromLsof('p101\nfcwd\nn/repo/app\np303\nfcwd\nn/repo/api/\n'), ['/repo/app', '/repo/api']);
  });
});

describe('systemProcessProbe', () => {
  test('macOS: ps and then lsof only with the Claude pids', async () => {
    const calls: string[][] = [];
    const probe = systemProcessProbe({
      platform: 'darwin',
      inContainer: false,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'ps') return '  101 claude\n  202 bash\n';
        return 'p101\nfcwd\nn/repo/app\n';
      },
    });
    assert.deepEqual([...(await probe.liveDirs())!], ['/repo/app']);
    assert.deepEqual(calls[1], ['lsof', '-Fn', '-a', '-d', 'cwd', '-p', '101']);
  });

  test('macOS with no Claude running: empty set, without calling lsof', async () => {
    let lsof = false;
    const probe = systemProcessProbe({
      platform: 'darwin',
      inContainer: false,
      run: async (cmd) => {
        if (cmd === 'lsof') lsof = true;
        return '  1 launchd\n';
      },
    });
    assert.equal((await probe.liveDirs())?.size, 0);
    assert.equal(lsof, false);
  });

  test('a failing command becomes "don\'t know" (null)', async () => {
    const probe = systemProcessProbe({ platform: 'darwin', inContainer: false, run: async () => Promise.reject(new Error('no ps')) });
    assert.equal(await probe.liveDirs(), null);
  });

  test('Linux: reads /proc', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'cwd-'));
      for (const [pid, cmd] of [['10', 'claude\0--resume\0'], ['20', 'bash\0']] as const) {
        mkdirSync(join(proc, pid));
        writeFileSync(join(proc, pid, 'cmdline'), cmd);
        symlinkSync(cwd, join(proc, pid, 'cwd'));
      }
      mkdirSync(join(proc, 'self'));
      const live = await systemProcessProbe({ platform: 'linux', inContainer: false, proc }).liveDirs();
      assert.deepEqual([...live!], [cwd]);
      rmSync(cwd, { recursive: true });
    } finally {
      rmSync(proc, { recursive: true });
    }
  });

  test('off on Windows and in a container', async () => {
    assert.equal(await systemProcessProbe({ platform: 'win32', inContainer: false }).liveDirs(), null);
    assert.equal(await systemProcessProbe({ platform: 'darwin', inContainer: true }).liveDirs(), null);
  });

  test('fixedProbe', async () => {
    assert.deepEqual([...(await fixedProbe(['/a/']).liveDirs())!], ['/a']);
    assert.equal(await fixedProbe(null).liveDirs(), null);
  });
});
