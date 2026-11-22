// Whether the LaunchAgent is loaded (#740): `launchctl print <target>` exits 0 only for a loaded service, as upstream's `start_launchd` reads it.
import { execFile } from 'node:child_process';

const LAUNCHCTL = '/bin/launchctl';
const PROBE_TIMEOUT_MS = 3_000;

export type LaunchctlExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
  done: (error: Error | null) => void,
) => void;

const realExec: LaunchctlExec = (file, args, options, done) => {
  execFile(file, [...args], options, (error) => done(error));
};

// (#740) The fixed argv `launchctl print <target>`, no shell, output discarded: any error, a non-zero exit included, is "not loaded".
export function launchdLoaded(target: string, exec: LaunchctlExec = realExec): Promise<boolean> {
  return new Promise((resolve) => {
    exec(LAUNCHCTL, ['print', target], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error) => resolve(error === null));
  });
}
