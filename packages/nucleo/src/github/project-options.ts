// The Projects (v2) the account sees, to choose the kanban's (#241, decision 0011 §7): the person's
// own (`viewer.projectsV2`) and their organizations' (`organizations { projectsV2 }`), one GraphQL
// query of cost 1 to 2. GitHub answers it in part when an organization refuses the credential (OAuth
// App access restrictions, SAML): that owner comes back blocked, with the reason, and the others keep
// their Projects (#340). Read through the 0001 cache with the "projects and fields" TTL (1 h) under a
// single key (one credential per installation; the cache is cleared on an identity change) and
// through the single call queue.

import type { GithubCallQueue } from './call-queue.ts';
import { GITHUB_TTL, type GithubCache } from './cache.ts';
import { githubGraphqlPartial, GraphqlResponseError, requireGithubToken, resolveGithubToken, retryOnGateway, type GithubGraphqlSourceOptions } from './github-source.ts';

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

/** Why GitHub refused an owner's Projects. */
export type OwnerBlockReason = 'oauth-restricted' | 'saml' | 'forbidden';

/** One owner of Projects the account sees: the person or one of their organizations. */
export interface ProjectOwner {
  login: string;
  ownerType: 'user' | 'organization';
  /** How many Projects GitHub says the owner has (it says so even when it refuses them), or null. */
  projects: number | null;
  /** null when GitHub gave the Projects; otherwise why it did not. */
  blocked: { reason: OwnerBlockReason; message: string } | null;
}

const NODE = `number title url closed owner { __typename ... on User { login } ... on Organization { login } } items { totalCount } field(name: "Status") { __typename }`;

export const PROJECT_OPTIONS_QUERY = `query ProjectOptions {
  rateLimit { cost remaining resetAt }
  viewer {
    login
    projectsV2(first: 50) { totalCount nodes { ${NODE} } }
    organizations(first: 50) { nodes { login projectsV2(first: 50) { totalCount nodes { ${NODE} } } } }
  }
}`;

// v2: the value became `{ projects, owners }` (#340); an old array under the first key is never read.
export const PROJECT_OPTIONS_CACHE_KEY = 'github:project-options:v2';

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

/** The list and who it came from. */
export interface ProjectOptionsRead {
  projects: ProjectOption[];
  owners: ProjectOwner[];
}

export interface ProjectOptionsReader {
  list(): Promise<ProjectOptionsRead>;
}

/** GitHub's message for an owner it refused → the reason the screen explains. */
export function blockReasonOf(message: string): OwnerBlockReason {
  if (/OAuth App access restrictions/i.test(message)) return 'oauth-restricted';
  if (/SAML/i.test(message)) return 'saml';
  return 'forbidden';
}

type Nodes = { totalCount?: number; nodes?: (RawProjectOption | null)[] | null } | null;
type Data = { viewer: { login?: string; projectsV2: Nodes; organizations: { nodes: ({ login: string; projectsV2: Nodes } | null)[] } | null } };

/** The GraphQL adapter; the credential comes from the provider on every request. */
export class GithubProjectOptionsSource implements ProjectOptionsReader {
  private readonly opts: GithubGraphqlSourceOptions;

  constructor(opts: GithubGraphqlSourceOptions) {
    requireGithubToken(opts?.token);
    this.opts = opts;
  }

  async list(): Promise<ProjectOptionsRead> {
    const token = await resolveGithubToken(this.opts.token);
    const { data, errors } = await retryOnGateway(() => githubGraphqlPartial<Data>({ ...this.opts, token }, 'ProjectOptions', PROJECT_OPTIONS_QUERY, {}), { sleep: this.opts.sleep });
    // Each error belongs to the person's Projects (`viewer.projectsV2…`) or to one organization's
    // (`viewer.organizations.nodes.<i>…`); any other one leaves the list without an owner to blame.
    const userErrors: string[] = [];
    const orgErrors = new Map<number, string>();
    for (const e of errors) {
      const path = e.path ?? [];
      if (path[0] === 'viewer' && path[1] === 'projectsV2') userErrors.push(e.message);
      else if (path[0] === 'viewer' && path[1] === 'organizations' && path[2] === 'nodes' && typeof path[3] === 'number' && path[4] === 'projectsV2') {
        if (!orgErrors.has(path[3])) orgErrors.set(path[3], e.message);
      } else throw new GraphqlResponseError(`GitHub: ${e.message}`, errors.map((x) => String(x.path?.[0] ?? '')));
    }
    const blocked = (message: string | undefined) => (message === undefined ? null : { reason: blockReasonOf(message), message });
    const count = (n: Nodes) => (typeof n?.totalCount === 'number' ? n.totalCount : null);
    const owners: ProjectOwner[] = [];
    if (typeof data.viewer.login === 'string') owners.push({ login: data.viewer.login, ownerType: 'user', projects: count(data.viewer.projectsV2), blocked: blocked(userErrors[0]) });
    (data.viewer.organizations?.nodes ?? []).forEach((o, i) => {
      if (o && typeof o.login === 'string') owners.push({ login: o.login, ownerType: 'organization', projects: count(o.projectsV2), blocked: blocked(orgErrors.get(i)) });
    });
    const raws = [
      ...(data.viewer.projectsV2?.nodes ?? []),
      ...(data.viewer.organizations?.nodes ?? []).flatMap((o) => o?.projectsV2?.nodes ?? []),
    ];
    const seen = new Map<string, ProjectOption>();
    for (const raw of raws) {
      const p = toProjectOption(raw);
      if (p) seen.set(`${p.owner.toLowerCase()}/${p.number}`, p);
    }
    return { projects: [...seen.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.number - b.number), owners };
  }
}

export interface ProjectOptionsList {
  projects: ProjectOption[];
  /** The person and each organization the token sees, with the ones GitHub refused (#340). */
  owners: ProjectOwner[];
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
    const r = await this.cache.get<ProjectOptionsRead>(
      PROJECT_OPTIONS_CACHE_KEY,
      GITHUB_TTL.projects,
      async () => ({ value: await this.queue.run(() => this.source.list()), etag: null }),
      { force: refresh },
    );
    return { projects: r.value.projects, owners: r.value.owners, fetchedAt: new Date(r.fetchedAt).toISOString(), stale: r.stale, reason: r.staleReason };
  }
}
