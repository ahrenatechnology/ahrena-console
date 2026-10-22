// The Projects (v2) the account sees, to choose the kanban's (#241, decision 0011 §7): the person's
// own (`viewer.projectsV2`) and their organizations' (`organizations { projectsV2 }`), one GraphQL
// query of cost 1 to 2. Read through the 0001 cache with the "projects and fields" TTL (1 h) under a
// single key (one credential per installation; the cache is cleared on an identity change) and
// through the single call queue.

import type { GithubCallQueue } from './call-queue.ts';
import { GITHUB_TTL, type GithubCache } from './cache.ts';
import { githubGraphql, requireGithubToken, resolveGithubToken, retryOnGateway, type GithubGraphqlSourceOptions } from './github-source.ts';

export interface ProjectOption {
  owner: string;
  ownerType: 'user' | 'organization';
  number: number;
  title: string;
  url: string;
  /** How many items the Project has. */
  items: number;
  /** Whether it has a field named Status (the kanban's default columns). */
  hasStatusField: boolean;
  closed: boolean;
}

const NODE = `number title url closed owner { __typename ... on User { login } ... on Organization { login } } items { totalCount } field(name: "Status") { __typename }`;

export const PROJECT_OPTIONS_QUERY = `query ProjectOptions {
  rateLimit { cost remaining resetAt }
  viewer {
    login
    projectsV2(first: 50) { nodes { ${NODE} } }
    organizations(first: 50) { nodes { login projectsV2(first: 50) { nodes { ${NODE} } } } }
  }
}`;

export const PROJECT_OPTIONS_CACHE_KEY = 'github:project-options';

interface RawProjectOption {
  number?: number;
  title?: string;
  url?: string;
  closed?: boolean;
  owner?: { __typename?: string; login?: string } | null;
  items?: { totalCount?: number } | null;
  field?: { __typename?: string } | null;
}

export function toProjectOption(raw: RawProjectOption | null | undefined): ProjectOption | null {
  if (!raw || typeof raw.number !== 'number' || typeof raw.owner?.login !== 'string') return null;
  return {
    owner: raw.owner.login,
    ownerType: raw.owner.__typename === 'Organization' ? 'organization' : 'user',
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url ?? '',
    items: raw.items?.totalCount ?? 0,
    hasStatusField: Boolean(raw.field),
    closed: raw.closed === true,
  };
}

export interface ProjectOptionsReader {
  list(): Promise<ProjectOption[]>;
}

/** The GraphQL adapter; the credential comes from the provider on every request. */
export class GithubProjectOptionsSource implements ProjectOptionsReader {
  private readonly opts: GithubGraphqlSourceOptions;

  constructor(opts: GithubGraphqlSourceOptions) {
    requireGithubToken(opts?.token);
    this.opts = opts;
  }

  async list(): Promise<ProjectOption[]> {
    type Nodes = { nodes: (RawProjectOption | null)[] } | null;
    type Data = { viewer: { projectsV2: Nodes; organizations: { nodes: ({ login: string; projectsV2: Nodes } | null)[] } | null } };
    const token = await resolveGithubToken(this.opts.token);
    const data = await retryOnGateway(() => githubGraphql<Data>({ ...this.opts, token }, 'ProjectOptions', PROJECT_OPTIONS_QUERY, {}), { sleep: this.opts.sleep });
    const raws = [
      ...(data.viewer.projectsV2?.nodes ?? []),
      ...(data.viewer.organizations?.nodes ?? []).flatMap((o) => o?.projectsV2?.nodes ?? []),
    ];
    const seen = new Map<string, ProjectOption>();
    for (const raw of raws) {
      const p = toProjectOption(raw);
      if (p) seen.set(`${p.owner.toLowerCase()}/${p.number}`, p);
    }
    return [...seen.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.number - b.number);
  }
}

export interface ProjectOptionsList {
  projects: ProjectOption[];
  /** When it came from GitHub (ISO). */
  fetchedAt: string;
  stale: boolean;
  /** Why it is stale (pt-BR, may reach the screen), or null. */
  reason: string | null;
}

/** The list behind GET /api/project/options: cache, TTL and queue of decision 0001. */
export class ProjectOptions {
  private readonly source: ProjectOptionsReader;
  private readonly cache: GithubCache;
  private readonly queue: GithubCallQueue;

  constructor({ source, cache, queue }: { source: ProjectOptionsReader; cache: GithubCache; queue: GithubCallQueue }) {
    this.source = source;
    this.cache = cache;
    this.queue = queue;
  }

  /** `refresh`: the person asked again (ignores the TTL, respecting the 30 s minimum). Without data and with GitHub failing: `NoDataError`. */
  async list({ refresh = false }: { refresh?: boolean } = {}): Promise<ProjectOptionsList> {
    const r = await this.cache.get<ProjectOption[]>(
      PROJECT_OPTIONS_CACHE_KEY,
      GITHUB_TTL.projects,
      async () => ({ value: await this.queue.run(() => this.source.list()), etag: null }),
      { force: refresh },
    );
    return { projects: r.value, fetchedAt: new Date(r.fetchedAt).toISOString(), stale: r.stale, reason: r.staleReason };
  }
}
