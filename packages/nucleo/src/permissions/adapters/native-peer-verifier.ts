/* The production `PeerVerifier` (#619, layer 2): asks the installed app's own executable, in its `--verify-window-peer` mode, whether
   the process at the other end of the channel is that app. The channel is the helper's stdin and the answer is its exit code
   (100 match, 101 mismatch, 102 unavailable: not 0, 1 and 2, because an installed app from before this mode ignores the argument and a second instance of it exits 0, which must never read as a match); the helper writes nothing, and nothing it could write is read. Any other outcome (no such file,
   a signal, a timeout, another code, a platform that is not macOS) is `unavailable`, which holds no credential. */
import { spawn as nodeSpawn } from 'node:child_process';
import type { PeerVerdict, PeerVerifier } from '../window-channel.ts';

/** The one place the installed app is looked for; never an option, an environment variable or a file (#619). */
export const INSTALLED_APP_PATH = '/Applications/Ahrena Console.app/Contents/MacOS/ahrena-console-desktop';

const HELPER_ARGS = ['--verify-window-peer'];
const DEFAULT_TIMEOUT_MS = 5_000;
const VERDICT_BY_EXIT: Readonly<Record<number, PeerVerdict>> = { 100: 'match', 101: 'mismatch', 102: 'unavailable' };

/** What the adapter uses of a spawned process; a real child process satisfies it (#619). */
export interface HelperProcess {
  once(event: 'error', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal: 'SIGKILL'): unknown;
}

export interface HelperSpawnOptions {
  stdio: [number, 'ignore', 'ignore'];
  shell: false;
  windowsHide: true;
}

export interface NativePeerVerifierDeps {
  /** Injected by tests; production spawns the process (#619). */
  spawn?: (file: string, args: string[], options: HelperSpawnOptions) => HelperProcess;
  appPath?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export class NativePeerVerifier implements PeerVerifier {
  private readonly spawn: NonNullable<NativePeerVerifierDeps['spawn']>;
  private readonly appPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;

  constructor(deps: NativePeerVerifierDeps = {}) {
    this.spawn = deps.spawn ?? nodeSpawn;
    this.appPath = deps.appPath ?? INSTALLED_APP_PATH;
    this.platform = deps.platform ?? process.platform;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  verify(fd: number): Promise<PeerVerdict> {
    if (this.platform !== 'darwin') return Promise.resolve('unavailable');
    return new Promise<PeerVerdict>((resolve) => {
      let helper: HelperProcess;
      try {
        helper = this.spawn(this.appPath, [...HELPER_ARGS], { stdio: [fd, 'ignore', 'ignore'], shell: false, windowsHide: true });
      } catch {
        /* The cause's text stays out of everything: the verdict is all that is recorded (#619). */
        resolve('unavailable');
        return;
      }
      const timer = setTimeout(() => {
        helper.kill('SIGKILL');
        resolve('unavailable');
      }, this.timeoutMs);
      const settle = (verdict: PeerVerdict): void => {
        clearTimeout(timer);
        resolve(verdict);
      };
      helper.once('error', () => settle('unavailable'));
      helper.once('exit', (code) => settle(code === null ? 'unavailable' : (VERDICT_BY_EXIT[code] ?? 'unavailable')));
    });
  }
}
