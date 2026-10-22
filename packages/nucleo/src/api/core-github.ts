// The core's GitHub, wired once (#241, decision 0011): the console's own connection, the credential
// provider every GitHub source takes its token from, and the GitHub-backed screens
// (src/api/github-screens.ts). cli.ts builds it for the real core and for --demo; the credential leak
// test builds it the same way, with the fake GitHub as the transport.
//
// - Every status transition of the connection is a `connections` change (`key: 'github'`), so the /ui
//   long-polls /api/changes for it (kept out of MCP: src/changes/mcp.ts).
// - An identity change (disconnect, another login, another source) clears `github_cache` and rebuilds
//   every screen (decision 0011 §4): nothing read with the previous credential is served afterwards.
// - `connected()` is the 409 `github-not-connected` gate of server.ts; `null` under --no-github, whose
//   screens keep their own off / no-github answers.

import type { ChangeCursor } from '../changes/cursor.ts';
import type { GithubConnection } from '../github/connection/connection.ts';
import type { GithubAccess } from '../github/github-source.ts';
import { createGithubScreens, type GithubScreens, type GithubScreensOptions } from './github-screens.ts';

export interface CoreGithubOptions extends Omit<GithubScreensOptions, 'github' | 'changes'> {
  changes: ChangeCursor;
  /** Builds the connection with the hooks this wiring needs (the real one, or the demo's). */
  connection: (hooks: { onChange: () => void; onIdentityChange: () => void }) => GithubConnection | Promise<GithubConnection>;
  /** Tests: the transport (fetch and addresses) of every screen; the credential is always the connection's. */
  transport?: Omit<GithubAccess, 'token'>;
}

export interface CoreGithub {
  connection: GithubConnection;
  /** The credential provider; `null` under --no-github. */
  access: GithubAccess | null;
  screens: GithubScreens;
  /** The 409 gate; `null` under --no-github. */
  connected: (() => Promise<boolean>) | null;
  /** Resolves when the last identity reset finished (tests). */
  settled(): Promise<void>;
}

export async function createCoreGithub(o: CoreGithubOptions): Promise<CoreGithub> {
  const { connection: build, transport, ...screenOptions } = o;
  const log = o.log ?? (() => undefined);
  let screens: GithubScreens | null = null;
  let resetting: Promise<void> = Promise.resolve();
  const connection = await build({
    onChange: () => void o.changes.record({ type: 'connections', key: 'github', sessionId: null, accountId: null }),
    onIdentityChange: () => {
      resetting = resetting
        .then(() => screens?.resetIdentity())
        .catch((e: unknown) => log(`github: could not reset the screens (${(e as Error).message})`));
    },
  });
  const access: GithubAccess | null = o.noGithub ? null : { ...transport, token: () => connection.token() };
  screens = createGithubScreens({ ...screenOptions, github: access });
  return {
    connection,
    access,
    screens,
    connected: o.noGithub ? null : () => connection.connected(),
    settled: () => resetting,
  };
}
