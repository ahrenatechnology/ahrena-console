// The ready-made `"update": { … }` block the screen offers when the machine has a `connection.credential` but no
// valid `connection.update` (issue 462, decision 0022 section 1). The núcleo never writes machines.json: it only
// builds this text, and the person pastes it once.
//
// It is built from what the user already wrote: the SSH prefix of the `credential` command is copied as it is, and
// its tail (`<node> <checkout>/packages/nucleo/src/owner/cli.ts remote-credential --port <n>`) is replaced by
// `<node> --disable-warning=ExperimentalWarning --input-type=module - --checkout <checkout> --port <n>`. The
// checkout is `connection.checkout` or the one the credential's `cli.ts` path implies. A block that the validator
// (`parseUpdate`) would refuse is not offered.
//
// Since decision 0024 (issue 484) the same command is also what runs when no `connection.update` is declared
// (`resolveUpdateCommand`): a valid declared update wins; an invalid declared one runs nothing and never falls back
// to the derived command (the text the person wrote explicitly wins, and hiding its error would run what they did
// not want); otherwise the command derived from the credential, or nothing.

import { DEFAULT_UPDATE_TIMEOUT_SECONDS, parseCheckout, parseUpdate, type ConnectionConfig, type ReconnectConfig } from './machines-config.ts';

const OWNER_CLI_SUFFIX = '/packages/nucleo/src/owner/cli.ts';
const PORT = /^\d{1,5}$/;

export interface UpdateBlock {
  /** The text to paste inside `connection` (`"update": { … }`, no trailing comma). */
  text: string;
  command: string[];
  timeoutSeconds: number;
}

/** The block for a machine, or `null` when its credential command is not the known shape or the result would be invalid. Pure. */
export function buildUpdateBlock(credential: ReconnectConfig | null | undefined, checkout: string | null | undefined): UpdateBlock | null {
  if (!credential) return null;
  const c = credential.command;
  const cli = c.findIndex((item, i) => item.endsWith('/owner/cli.ts') && c[i + 1] === 'remote-credential');
  if (cli < 1) return null;
  const portAt = c.indexOf('--port', cli + 2);
  const port = portAt >= 0 ? c[portAt + 1] : undefined;
  if (port === undefined || !PORT.test(port)) return null;
  const cliPath = c[cli]!;
  const fromCli = cliPath.endsWith(OWNER_CLI_SUFFIX) ? cliPath.slice(0, -OWNER_CLI_SUFFIX.length) : null;
  const where = checkout ?? fromCli;
  if (!where || typeof parseCheckout(where) !== 'string') return null;
  const node = c[cli - 1]!;
  const command = [...c.slice(0, cli - 1), node, '--disable-warning=ExperimentalWarning', '--input-type=module', '-', '--checkout', where, '--port', port];
  const parsed = parseUpdate({ command, timeoutSeconds: DEFAULT_UPDATE_TIMEOUT_SECONDS });
  if ('problem' in parsed) return null;
  const lines = JSON.stringify({ update: { command, timeoutSeconds: DEFAULT_UPDATE_TIMEOUT_SECONDS } }, null, 2).split('\n');
  return { text: lines.slice(1, -1).map((l) => l.slice(2)).join('\n'), command, timeoutSeconds: DEFAULT_UPDATE_TIMEOUT_SECONDS };
}

/** Where the update command came from (decision 0024 section 1). */
export type UpdateSource = 'declared' | 'derived';

/**
 * The update command of a machine: the valid declared `connection.update`; nothing when the declared one is invalid
 * (never the derived one); else the command derived from `connection.credential`; else nothing. Pure.
 */
export function resolveUpdateCommand(conn: ConnectionConfig | null | undefined): { config: ReconnectConfig; source: UpdateSource } | null {
  if (!conn) return null;
  if (conn.update) return { config: conn.update, source: 'declared' };
  if (conn.updateProblem) return null;
  const block = buildUpdateBlock(conn.credential, conn.checkout);
  return block ? { config: { command: block.command, timeoutSeconds: block.timeoutSeconds }, source: 'derived' } : null;
}
