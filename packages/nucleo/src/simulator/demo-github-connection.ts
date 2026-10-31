// The console's GitHub connection under --demo (#241, decision 0011): the same `GithubConnection` the
// real core runs, against the fake GitHub (fake-github-auth.ts), with an in-memory vault, the client id
// `demo-client-id` and a fake `gh`. `--demo-github <state>` boots it in each state the /ui is built
// against. Nothing here reaches the real GitHub, the real Keychain or the real `gh`.
//
// | State                  | What the /ui sees                                                         |
// | ---------------------- | ------------------------------------------------------------------------- |
// | `connected` (default)  | `dev-sintetico`, every scope, no blocked organization                     |
// | `disconnected`         | Connect → a code; the fake approves after 3 polls at 1 s → connected     |
// | `pending`              | Boots with a code the fake never approves; Cancel → disconnected          |
// | `denied`               | Boots with a code the first poll refuses → disconnected, `lastError: denied` (Connect repeats it) |
// | `expired`              | Boots with a code that expires after 5 s → disconnected, `lastError: expired` (Connect repeats it) |
// | `revoked`              | Boots with a stored credential GitHub refuses (401) → `lastError: revoked` (#372); Reconnect → connected |
// | `missing-scopes`       | Connected with `repo` only: `read:org` and `project` missing (Reconnect)  |
// | `blocked-orgs`         | Connected; `estudio-ficticio` restricts OAuth Apps                        |
// | `no-client-id`         | Unavailable, `no-client-id` (the OAuth App is not configured)             |
// | `no-vault`             | Unavailable, `no-vault` (nowhere safe to keep the credential)             |
// | `gh`                   | The `gh` source (chosen in the settings), connected with a fake `gh`      |
// | `gh-not-authenticated` | The `gh` source, unavailable `gh-not-authenticated`                       |
//
// `gh` counts as installed in every state, so the /ui can offer it; its credential is the fake one.

import { GithubCallQueue } from '../github/call-queue.ts';
import { GithubConnection } from '../github/connection/connection.ts';
import { MemoryVault } from '../github/connection/vault.ts';
import type { InstallationSettings } from '../settings/installation-settings.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, FAKE_GITHUB_BASE, type FakeGithub, type FakeGithubAuth } from './fake-github.ts';

export const DEMO_GITHUB_STATES = ['connected', 'disconnected', 'pending', 'denied', 'expired', 'revoked', 'missing-scopes', 'blocked-orgs', 'no-client-id', 'no-vault', 'gh', 'gh-not-authenticated'] as const;
export type DemoGithubState = (typeof DEMO_GITHUB_STATES)[number];

/** The credential a `revoked` demo boots with: the fake GitHub refuses it. */
const DEMO_REVOKED_TOKEN = 'gho_DEMO0revoked0000000000000000000000';
/** An obviously fake credential: the demo's only one. */
export const DEMO_GITHUB_TOKEN = 'gho_DEMO0not0a0real0token000000000000';
export const DEMO_GITHUB_CLIENT_ID = 'demo-client-id';
/** The fake GitHub's address (does not resolve: even if the fake failed, nothing reaches GitHub). */
export const DEMO_GITHUB_BASE = FAKE_GITHUB_BASE;
const DEMO_LOGIN = DEMO_GITHUB_DATA.login;

/** `--demo-github`: absent → `connected`; an unknown state throws. */
export function parseDemoGithubState(value: string | undefined): DemoGithubState {
  if (value === undefined) return 'connected';
  if ((DEMO_GITHUB_STATES as readonly string[]).includes(value)) return value as DemoGithubState;
  throw new Error(`--demo-github: one of ${DEMO_GITHUB_STATES.join(', ')}`);
}

export interface DemoGithubConnectionOptions {
  settings: InstallationSettings;
  queue?: GithubCallQueue;
  onChange?: () => void;
  onIdentityChange?: () => void;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DemoGithubConnection {
  connection: GithubConnection;
  /** The fake GitHub behind the connection (its `calls` and device codes). */
  fake: FakeGithub;
}

export async function createDemoGithubConnection(state: DemoGithubState, o: DemoGithubConnectionOptions): Promise<DemoGithubConnection> {
  const connectedAtBoot = state === 'connected' || state === 'missing-scopes' || state === 'blocked-orgs';
  const auth: FakeGithubAuth = {
    clientId: DEMO_GITHUB_CLIENT_ID,
    token: DEMO_GITHUB_TOKEN,
    scopes: state === 'missing-scopes' ? ['repo'] : ['repo', 'read:org', 'project'],
    login: DEMO_LOGIN,
    interval: 1,
    approveAfterPolls: 3,
    ...(state === 'pending' ? { neverApprove: true } : {}),
    ...(state === 'denied' ? { deny: true } : {}),
    ...(state === 'expired' ? { expiresIn: 5, neverApprove: true } : {}),
    ...(state === 'blocked-orgs' ? { blockedOrgs: ['estudio-ficticio'] } : {}),
  };
  const fake = createFakeGithub(DEMO_GITHUB_DATA, { auth, ...(o.now ? { now: o.now } : {}) });
  if (connectedAtBoot || state === 'revoked') o.settings.set('github.login', DEMO_LOGIN);
  if (state === 'gh' || state === 'gh-not-authenticated') o.settings.set('github.source', 'gh');
  const connection = new GithubConnection({
    vault: state === 'no-vault' ? null : new MemoryVault(connectedAtBoot ? { [DEMO_LOGIN]: DEMO_GITHUB_TOKEN } : state === 'revoked' ? { [DEMO_LOGIN]: DEMO_REVOKED_TOKEN } : {}),
    settings: o.settings,
    clientId: state === 'no-client-id' ? null : DEMO_GITHUB_CLIENT_ID,
    fetch: fake.fetch,
    oauthUrl: DEMO_GITHUB_BASE,
    apiUrl: DEMO_GITHUB_BASE,
    env: {},
    ghInstalled: () => true,
    ghToken: state === 'gh-not-authenticated' ? () => Promise.reject(new Error('the demo gh has no login')) : async () => DEMO_GITHUB_TOKEN,
    minIntervalS: 1,
    ...(o.queue ? { queue: o.queue } : {}),
    ...(o.onChange ? { onChange: o.onChange } : {}),
    ...(o.onIdentityChange ? { onIdentityChange: o.onIdentityChange } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.setTimer ? { setTimer: o.setTimer } : {}),
    ...(o.clearTimer ? { clearTimer: o.clearTimer } : {}),
  });
  if (state === 'pending' || state === 'denied' || state === 'expired') await connection.start();
  else await connection.status();
  return { connection, fake };
}
