// Shared by the Update button's tests (issue 462): a scenario file for the fake ssh, a machines.json-shaped
// connection, and the lines the script would print. Placeholders only: no real host, token or user code.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionConfig } from '../../src/telemetry/machines-config.ts';

export const FAKE_SSH = fileURLToPath(new URL('./fake-update-ssh.mjs', import.meta.url));
export const SCRIPT_TEXT = '// the packaged script, as the fake sees it on stdin\nexport {};\n';

export const phase = (p: string) => `${JSON.stringify({ v: 1, event: 'phase', phase: p })}\n`;
export const result = (exit: number, extra: Partial<Record<'reason' | 'backup' | 'oldCommit' | 'newCommit', string | null>> = {}) =>
  `${JSON.stringify({ v: 1, event: 'result', exit, reason: null, backup: null, oldCommit: null, newCommit: null, ...extra })}\n`;

export interface Step {
  out?: string;
  sleep?: number;
  big?: number;
}

export class Scenario {
  readonly dir = mkdtempSync(join(tmpdir(), 'ahrena-core-update-'));
  readonly file = join(this.dir, 'scenario.json');
  readonly record = join(this.dir, 'record.ndjson');

  set(s: { steps?: Step[]; exit?: number; noRead?: boolean; real?: boolean; check?: { steps?: Step[]; exit?: number } }): void {
    writeFileSync(this.file, JSON.stringify({ record: this.record, ...s }));
  }

  runs(): { argv: string[]; script: string; pid: number }[] {
    try {
      return readFileSync(this.record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  /** The `connection` of a machine whose update runs the fake ssh. */
  connection(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
    return {
      start: { command: ['/bin/true'], timeoutSeconds: 60 },
      credential: { command: ['/bin/true'], timeoutSeconds: 20 },
      update: { command: [process.execPath, FAKE_SSH, this.file, '--checkout', '/srv/ahrena-console', '--port', '4720'], timeoutSeconds: 60 },
      ...over,
    };
  }

  /**
   * The `credential` of a machine whose SSH prefix runs the fake ssh (issue 484, decision 0024 section 1): with no
   * `connection.update`, the núcleo derives `[node, FAKE_SSH, file, '/opt/node/bin/node',
   * '--disable-warning=ExperimentalWarning', '--input-type=module', '-', '--checkout', '/srv/ahrena-console', '--port', '4720']`.
   */
  derivableCredential(): { command: string[]; timeoutSeconds: number } {
    return { command: [process.execPath, FAKE_SSH, this.file, '/opt/node/bin/node', '/srv/ahrena-console/packages/nucleo/src/owner/cli.ts', 'remote-credential', '--port', '4720'], timeoutSeconds: 20 };
  }

  /** The `connection` of a machine with only a derivable credential: no `connection.update`. (issue 484) */
  derivedConnection(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
    return this.connection({ update: undefined, credential: this.derivableCredential(), ...over });
  }

  close(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
