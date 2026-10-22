// How the core's GitHub-backed screens reach GitHub (#241, decision 0011 §5): one access object, the
// credential provider (the connection's `token()`) plus, for tests, the transport. The demo keeps
// each screen's fake GitHub (`fetch` and an address that does not resolve) but its credential comes
// from the provider too. `--no-github` builds no transport at all.

import { GithubReposSource } from '../github/repos-source.ts';
import { requireGithubToken, type GithubAccess } from '../github/github-source.ts';

export type { GithubAccess } from '../github/github-source.ts';

export interface GithubReposTransportOptions {
  demo: boolean;
  noGithub: boolean;
  /** Required outside the demo and `--no-github`. */
  github?: GithubAccess | null;
  /** The demo's fake GitHub for this screen. */
  demoFetch: () => typeof fetch;
  /** The demo's base address (does not resolve: even if the fake failed, nothing reaches GitHub). */
  demoBase: string;
}

/** The REST + GraphQL transport of a screen, or `null` under `--no-github`. */
export function githubReposTransport({ demo, noGithub, github, demoFetch, demoBase }: GithubReposTransportOptions): GithubReposSource | null {
  if (demo) return new GithubReposSource({ token: github?.token ?? 'demo', fetch: demoFetch(), url: `${demoBase}/graphql`, api: demoBase });
  if (noGithub) return null;
  if (!github) throw new TypeError('a GitHub-backed screen needs the github access (credential provider)');
  return new GithubReposSource({
    token: requireGithubToken(github.token),
    ...(github.fetch ? { fetch: github.fetch } : {}),
    ...(github.url ? { url: github.url } : {}),
    ...(github.api ? { api: github.api } : {}),
  });
}
