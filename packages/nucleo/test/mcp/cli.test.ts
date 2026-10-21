// The MCP stdio bridge's options (src/mcp/cli.ts): the English names; the old Portuguese ones left
// in phase 6 of #173. The bridge runs with HOME on a temp dir (no lock
// to adopt) and the port on a closed one, so every tools/call comes back with the "how to start" hint.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/mcp/cli.ts');

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

let home: string;
let port: number;
before(async () => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-mcp-cli-'));
  port = await closedPort();
});
after(() => rmSync(home, { recursive: true, force: true }));

/** Runs the bridge, sends one tools/call and returns the answer text, stderr and the exit code. */
function bridge(args: string[]): Promise<{ text: string | null; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      env: { ...process.env, HOME: home, AHRENA_CONSOLE_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find(Boolean);
      const text = line ? (JSON.parse(line).result?.content?.[0]?.text ?? null) : null;
      resolve({ text, stderr, code });
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet_overview', arguments: {} } })}\n`);
  });
}

describe('MCP CLI options', () => {
  test('--port names the core in the hint', async () => {
    const r = await bridge(['--port', String(port)]);
    assert.match(r.text ?? '', new RegExp(`127\\.0\\.0\\.1:${port}/mcp`));
    assert.match(r.text ?? '', new RegExp(`npm run api -- --port ${port}`));
  });

  test('--no-start only adopts: the hint says how to start the core', async () => {
    const r = await bridge(['--no-start']);
    // No live core in the registry and no start: no port to name (#221), just how to start one.
    assert.match(r.text ?? '', /npm run core -- start/);
  });

  test('an invalid port is refused; the old --porta and --sem-subir are unknown options', async () => {
    assert.match((await bridge(['--port', 'x'])).stderr, /invalid --port: x/);
    for (const old of [['--porta', String(port)], ['--sem-subir']]) {
      const r = await bridge(old);
      assert.notEqual(r.code, 0, old.join(' '));
      assert.match(r.stderr, /Unknown option/, old.join(' '));
    }
  });
});
