// `start` as a function, for the command (cli.ts) and for whoever talks to the core from another
// process (the MCP stdio bridge, the extension): adopts the live core or starts one in the
// background and waits for it to answer.

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSAO_DA_API } from '../api/versao.ts';
import { registerClient } from './clients.ts';
import { codeCommit, isOlderCommit } from './commit.ts';
import { codeWarning, examine, planStart } from './owner.ts';
import { sleep, probeCore } from './probe.ts';
import { defaultDir, prepareDir, type Lock } from './lock.ts';

/**
 * The `--json` line of `start` and `status`. Its keys and values stay in Portuguese on purpose: the
 * desktop app parses them (`estado`, `porta`, `subiu`, `motivo`), and `motivo`/`aviso` show on screen.
 */
export interface StartOutput {
  estado: 'de-pe' | 'parado';
  url?: string;
  porta?: number;
  pid?: number | null;
  versao?: string;
  commit?: string | null;
  inicio?: string;
  pai?: number | null;
  /** `true` if this call started the core; `false` if it adopted one already up. */
  subiu?: boolean;
  aviso?: string;
  motivo?: string;
}

export interface StartOptions {
  dir?: string;
  /** The port to start on, if nobody is up. If there is a core, its port wins. */
  port: number;
  parent?: number | null;
  replace?: boolean;
  /** Extra options for the API (`src/api/cli.ts`). */
  apiArgs?: string[];
  log?: (m: string) => void;
  timeoutMs?: number;
}

/** The output for a core that is up, from its lock. */
export const runningOutput = (t: Lock, extra: Partial<StartOutput> = {}): StartOutput => ({
  estado: 'de-pe',
  url: `http://127.0.0.1:${t.port}`,
  porta: t.port,
  pid: t.pid,
  versao: t.version,
  inicio: t.startedAt,
  pai: t.parent,
  ...extra,
});

export async function startOrAdopt(o: StartOptions): Promise<StartOutput> {
  const dir = o.dir ?? defaultDir();
  const parent = o.parent ?? null;
  const code = { version: VERSAO_DA_API, commit: codeCommit(), isOlderCommit };
  const adopted = (s: StartOutput): StartOutput => {
    if (parent !== null) registerClient(parent, dir);
    if (s.aviso) o.log?.(`warning: ${s.aviso}`);
    return s;
  };

  const plan = await planStart({ dir, ...code, replace: o.replace, log: o.log });
  if (plan.action === 'adopt') {
    return adopted(runningOutput(plan.lock, { subiu: false, commit: plan.view.commit, ...(plan.warning ? { aviso: plan.warning } : {}) }));
  }

  // The core runs on its own, without holding the caller or the terminal.
  prepareDir(dir);
  const logFile = join(dir, 'nucleo.log');
  const out = openSync(logFile, 'a', 0o600);
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'cli.ts');
  const args = ['--disable-warning=ExperimentalWarning', api, '--porta', String(o.port), ...(parent !== null ? ['--pai', String(parent)] : []), ...(o.apiArgs ?? [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] });
  let exitCode: number | null = null;
  child.on('exit', (c) => (exitCode = c ?? 1));
  child.unref();

  const end = Date.now() + (o.timeoutMs ?? 60_000);
  while (Date.now() < end) {
    const ex = await examine(dir);
    if (ex.state === 'alive') {
      const started = ex.lock.pid === child.pid;
      const extra = { subiu: started, commit: ex.view.commit };
      // Another one started at the same time and won the port: this call adopts, as the child did.
      if (started) return runningOutput(ex.lock, extra);
      const warning = codeWarning({ version: ex.lock.version, commit: ex.view.commit, pid: ex.lock.pid }, code);
      return adopted(runningOutput(ex.lock, { ...extra, ...(warning ? { aviso: warning } : {}) }));
    }
    if (exitCode !== null && exitCode !== 0) return { estado: 'parado', motivo: `o núcleo saiu com código ${exitCode}; veja ${logFile}` };
    // The child adopted a core without a lock (a --demo or --sem-trava, or one from before #86).
    if (exitCode === 0) {
      const v = await probeCore(o.port);
      if (v) {
        const warning = [
          'o núcleo nesta porta não tem trava (uma --demo, uma --sem-trava ou um núcleo de antes da #86)',
          codeWarning(v, code),
        ].filter(Boolean).join('; ');
        return adopted({ estado: 'de-pe', url: `http://127.0.0.1:${o.port}`, porta: o.port, pid: v.pid, versao: v.version, commit: v.commit, subiu: false, aviso: warning });
      }
    }
    await sleep(100);
  }
  return { estado: 'parado', motivo: `o núcleo não respondeu em ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s; veja ${logFile}` };
}
