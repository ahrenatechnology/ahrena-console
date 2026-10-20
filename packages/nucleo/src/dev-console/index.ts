// Dev Console in the núcleo (#177, decision 0008 section 4): contexts, merge queue, issue board
// and depends-on-you, derived from GitHub (the 0001 cache) and from the sessions.

import type { Git } from '../api/trabalho.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import type { GithubCache } from '../github/cache.ts';
import type { LeituraDaFrota } from '../mcp/frota.ts';
import type { StoragePort } from '../storage-port.ts';
import { DevConsoleContexts, defaultDevConsoleFile, type DevConsoleContext } from './contexts.ts';
import { DevConsoleGithub } from './reader.ts';
import { DevConsole } from './service.ts';
import { DevConsoleSessions, gitLocator, recentRepos } from './sessions.ts';
import type { DevConsoleSource } from './source.ts';

export * from './model.ts';
export * from './contexts.ts';
export * from './source.ts';
export * from './reader.ts';
export * from './sessions.ts';
export * from './service.ts';

export interface CreateDevConsoleOptions {
  storage: Pick<StoragePort, 'listSessions'>;
  frota: LeituraDaFrota;
  source: DevConsoleSource;
  cache: GithubCache;
  decisions?: Pick<DecisionPort, 'listDecisions'> | null;
  /** The `dev-console.json`; `null` turns the file off. Defaults to `~/.ahrena-console/dev-console.json`. */
  file?: string | null;
  /** Contexts given up front (the simulator), instead of the file. */
  contexts?: readonly DevConsoleContext[] | null;
  git?: Git;
  now?: () => number;
}

/** Builds the Dev Console from the núcleo's parts. */
export function createDevConsole({ storage, frota, source, cache, decisions = null, file = defaultDevConsoleFile(), contexts: fixed = null, git, now = frota.agora }: CreateDevConsoleOptions): DevConsole {
  const sessions = new DevConsoleSessions({ frota, decisions, locate: gitLocator({ git, now }) });
  const contexts = new DevConsoleContexts({
    file,
    fixed,
    now,
    recentRepos: () => recentRepos(storage, (s) => sessions.where(s), { now: now() }),
  });
  return new DevConsole({ contexts, github: new DevConsoleGithub({ source, cache, now }), sessions, now });
}
