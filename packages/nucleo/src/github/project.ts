// Kanban de um GitHub Project v2 (item 5.3): os itens agrupados pelo campo Status, com as
// raias na ordem das opções do Project, e mover um card muda o Status no GitHub.
// Segue a decisão 0001:
// - leitura com `fieldValueByName(name: "Status")`, 100 itens por página (custo 1);
// - TTL de 2 min (o delta das issues não vê mudança só de campo do Project);
// - mover é uma mutação que devolve o item, e o cache é atualizado por `patch`, sem reler.
//
// | Operação       | O que faz                                              | Custo |
// | -------------- | ------------------------------------------------------ | ----: |
// | ProjectBoard   | projeto, opções do Status e 100 itens com o Status     | 1     |
// | ProjectMove    | `updateProjectV2ItemFieldValue`, devolve o item         | 1     |

import { GITHUB_TTL, RateLimitedError, type GithubCache } from './cache.ts';
import { ghCliToken, githubGraphql, GithubScopeError, type GithubGraphqlSourceOptions } from './github-source.ts';
import { workKey } from './work.ts';

/** Qual Project: dono (organização ou pessoa) e número, como na URL `.../projects/3`. */
export interface ProjectRef {
  owner: string;
  number: number;
  /** Campo de seleção que vira as raias. Padrão: `Status`. */
  field?: string;
}

export interface ProjectLane {
  /** Id da opção do campo; `null` na raia dos itens sem Status. */
  id: string | null;
  name: string;
  /** Cor do GitHub (`GRAY`, `GREEN`…); `null` na raia sem Status. */
  color: string | null;
}

export type ProjectItemKind = 'Issue' | 'PullRequest' | 'DraftIssue';

export interface ProjectCard {
  /** Id do item no Project (o que a mutação usa). */
  itemId: string;
  kind: ProjectItemKind;
  /** `dono/repo#número`; `null` num rascunho. */
  key: string | null;
  repo: string | null;
  number: number | null;
  title: string;
  url: string | null;
  /** `OPEN`, `CLOSED` ou `MERGED`; rascunho é `OPEN`. */
  state: string;
  updatedAt: string;
  /** Tipo de issue (`Epic`, `Tech Task`…); `null` se não tiver ou não for issue. */
  type: string | null;
  /** Chave do pai, se a issue tiver. */
  parent: string | null;
  /** Id da opção de Status; `null` sem Status. */
  statusId: string | null;
}

export interface ProjectBoardValue {
  /** Id do Project (o que a mutação usa). */
  projectId: string;
  /** Id do campo das raias. */
  fieldId: string;
  field: string;
  title: string;
  url: string;
  /** Opções do campo, na ordem do Project. */
  options: ProjectLane[];
  /** Na ordem do Project. */
  items: ProjectCard[];
}

export interface BoardLane extends ProjectLane {
  items: ProjectCard[];
}

export interface ProjectBoard {
  owner: string;
  number: number;
  title: string;
  url: string;
  field: string;
  /** Raias na ordem do Project; a de "Sem status" só aparece se houver item sem Status, e vem primeiro, como no GitHub. */
  lanes: BoardLane[];
  count: number;
  fetchedAt: number;
  stale: boolean;
  staleReason: string | null;
}

/** Porta da fonte do Project: o adaptador local chama o GitHub; o do hub (7.9) lerá de lá. */
export interface ProjectSource {
  board(ref: ProjectRef): Promise<ProjectBoardValue>;
  /** Muda o campo do item para a opção e devolve o Status que o GitHub gravou. */
  move(input: { projectId: string; itemId: string; fieldId: string; optionId: string; field: string }): Promise<{ itemId: string; statusId: string | null }>;
}

/** Até quantas páginas de 100 itens a leitura busca. */
export const MAX_PROJECT_PAGES = 5;
export const DEFAULT_PROJECT_FIELD = 'Status';
/** Nome da raia dos itens sem valor no campo. */
export const NO_STATUS_LANE = 'Sem status';

const CONTENT = `content { __typename
  ... on Issue { number title url state updatedAt repository { nameWithOwner } issueType { name } parent { number repository { nameWithOwner } } }
  ... on PullRequest { number title url state updatedAt repository { nameWithOwner } }
  ... on DraftIssue { title updatedAt } }`;
const STATUS_VALUE = '... on ProjectV2ItemFieldSingleSelectValue { optionId }';

export const PROJECT_QUERIES = {
  board: `query ProjectBoard($o: String!, $n: Int!, $f: String!, $after: String) { rateLimit { cost remaining resetAt }
  repositoryOwner(login: $o) { ... on ProjectV2Owner { projectV2(number: $n) { id title url
    field(name: $f) { ... on ProjectV2SingleSelectField { id name options { id name color } } }
    items(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { id isArchived fieldValueByName(name: $f) { ${STATUS_VALUE} } ${CONTENT} } } } } } }`,
  move: `mutation ProjectMove($p: ID!, $i: ID!, $fid: ID!, $v: String!, $f: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $fid, value: { singleSelectOptionId: $v } }) {
    projectV2Item { id fieldValueByName(name: $f) { ${STATUS_VALUE} } } } }`,
} as const;

/** Mensagem para quando o token do `gh` não pode ler ou mexer no Project. */
export const PROJECT_SCOPE_HINT = 'o token do `gh` precisa do escopo `project`: rode `gh auth refresh -s project`';

export class ProjectPermissionError extends Error {
  constructor(detail: string) {
    super(`sem permissão no GitHub Project (${PROJECT_SCOPE_HINT}). ${detail}`);
    this.name = 'ProjectPermissionError';
  }
}

// Formas cruas do GraphQL.
interface RawRepoRef {
  nameWithOwner: string;
}
interface RawContent {
  __typename: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  updatedAt?: string;
  repository?: RawRepoRef;
  issueType?: { name: string } | null;
  parent?: { number: number; repository?: RawRepoRef } | null;
}
export interface RawProjectItem {
  id: string;
  isArchived: boolean;
  fieldValueByName: { optionId?: string } | null;
  content: RawContent | null;
}
interface RawProject {
  id: string;
  title: string;
  url: string;
  field: { id?: string; name?: string; options?: { id: string; name: string; color: string }[] } | null;
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawProjectItem[] };
}

/** Item cru → card. Arquivado, sem conteúdo ou de tipo desconhecido fica de fora (`null`). */
export function toProjectCard(raw: RawProjectItem): ProjectCard | null {
  const c = raw.content;
  if (raw.isArchived || !c || !['Issue', 'PullRequest', 'DraftIssue'].includes(c.__typename)) return null;
  const repo = c.repository?.nameWithOwner ?? null;
  return {
    itemId: raw.id,
    kind: c.__typename as ProjectItemKind,
    key: repo && c.number !== undefined ? workKey(repo, c.number) : null,
    repo,
    number: c.number ?? null,
    title: c.title ?? '',
    url: c.url ?? null,
    state: c.state ?? 'OPEN',
    updatedAt: c.updatedAt ?? '',
    type: c.issueType?.name ?? null,
    parent: c.parent ? workKey(c.parent.repository?.nameWithOwner ?? repo ?? '', c.parent.number) : null,
    statusId: raw.fieldValueByName?.optionId ?? null,
  };
}

/** Agrupa os itens nas raias, na ordem das opções; item com opção que sumiu cai em "Sem status". */
export function toLanes(value: ProjectBoardValue): BoardLane[] {
  const known = new Set(value.options.map((o) => o.id));
  const lanes: BoardLane[] = value.options.map((o) => ({ ...o, items: value.items.filter((i) => i.statusId === o.id) }));
  const none = value.items.filter((i) => !i.statusId || !known.has(i.statusId));
  return none.length ? [{ id: null, name: NO_STATUS_LANE, color: null, items: none }, ...lanes] : lanes;
}

const permission = (err: unknown): never => {
  if (err instanceof GithubScopeError) throw new ProjectPermissionError(err.message);
  if (err instanceof Error && /resource not accessible|must have (admin|write)|does not have permission|FORBIDDEN/i.test(err.message))
    throw new ProjectPermissionError(err.message);
  throw err;
};

/** Adaptador GraphQL do Project, com o token do `gh`. */
export class GithubProjectSource implements ProjectSource {
  private readonly opts: GithubGraphqlSourceOptions;
  private tokenValue: string | null = null;

  constructor(opts: GithubGraphqlSourceOptions) {
    this.opts = opts;
  }

  async board({ owner, number, field = DEFAULT_PROJECT_FIELD }: ProjectRef): Promise<ProjectBoardValue> {
    let value: ProjectBoardValue | null = null;
    let after: string | null = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      type Data = { repositoryOwner: { projectV2?: RawProject | null } | null };
      const data: Data = await this.call<Data>('ProjectBoard', PROJECT_QUERIES.board, { o: owner, n: number, f: field, after });
      const p = data.repositoryOwner?.projectV2;
      if (!p) throw new Error(`Project não encontrado: ${owner}/${number}`);
      if (!p.field?.id || !p.field.options) throw new Error(`o Project ${owner}/${number} não tem o campo de seleção "${field}"`);
      value ??= {
        projectId: p.id,
        fieldId: p.field.id,
        field: p.field.name ?? field,
        title: p.title,
        url: p.url,
        options: p.field.options.map((o) => ({ id: o.id, name: o.name, color: o.color })),
        items: [],
      };
      for (const raw of p.items.nodes) {
        const card = toProjectCard(raw);
        if (card) value.items.push(card);
      }
      if (!p.items.pageInfo.hasNextPage) break;
      after = p.items.pageInfo.endCursor;
    }
    return value!;
  }

  async move({ projectId, itemId, fieldId, optionId, field }: Parameters<ProjectSource['move']>[0]) {
    type Data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: string; fieldValueByName: { optionId?: string } | null } | null } | null };
    const data = await this.call<Data>('ProjectMove', PROJECT_QUERIES.move, { p: projectId, i: itemId, fid: fieldId, v: optionId, f: field });
    const item = data.updateProjectV2ItemFieldValue?.projectV2Item;
    if (!item) throw new Error(`o GitHub não devolveu o item ${itemId}`);
    return { itemId: item.id, statusId: item.fieldValueByName?.optionId ?? null };
  }

  private async call<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.tokenValue) {
      const t = this.opts.token;
      this.tokenValue = typeof t === 'string' ? t : await t();
    }
    return githubGraphql<T>({ ...this.opts, token: this.tokenValue }, operation, query, variables).catch(permission);
  }
}

export interface GithubProjectOptions {
  source: ProjectSource;
  cache: GithubCache;
  project: ProjectRef;
}

export const projectCacheKey = ({ owner, number, field = DEFAULT_PROJECT_FIELD }: ProjectRef) => `github:project:${owner}/${number}:${field}`;

/** O que o painel e o MCP usam para o kanban de um Project. */
export class GithubProject {
  readonly project: Required<ProjectRef>;
  private readonly source: ProjectSource;
  private readonly cache: GithubCache;

  constructor({ source, cache, project }: GithubProjectOptions) {
    this.source = source;
    this.cache = cache;
    this.project = { field: DEFAULT_PROJECT_FIELD, ...project };
  }

  private get key(): string {
    return projectCacheKey(this.project);
  }

  /** O quadro, pelo cache (TTL de 2 min). `force` é o botão de atualizar (mínimo de 30 s). */
  async board({ force = false }: { force?: boolean } = {}): Promise<ProjectBoard> {
    const r = await this.cache.get<ProjectBoardValue>(this.key, GITHUB_TTL.project, async () => ({ value: await this.source.board(this.project) }), { force });
    return this.view(r.value, r.fetchedAt, r.stale, r.staleReason);
  }

  /**
   * Move um card para a raia `optionId`: uma mutação, e o cache é atualizado com o que ela
   * devolveu, sem reler. Só lê o Project se ainda não houver nada no cache.
   */
  async move(itemId: string, optionId: string): Promise<ProjectBoard> {
    const wait = this.cache.pauseLeftMs();
    if (wait > 0) throw new RateLimitedError('GitHub limitou as chamadas; tente de novo em instantes', wait);
    if (!(await this.cache.peek(this.key))) await this.board();
    const cur = (await this.cache.peek<ProjectBoardValue>(this.key))!.value;
    if (!cur.options.some((o) => o.id === optionId)) throw new Error(`opção de ${this.project.field} desconhecida: ${optionId}`);
    if (!cur.items.some((i) => i.itemId === itemId)) throw new Error(`item fora do Project: ${itemId}`);
    let moved: { itemId: string; statusId: string | null };
    try {
      moved = await this.source.move({ projectId: cur.projectId, itemId, fieldId: cur.fieldId, optionId, field: this.project.field });
    } catch (err) {
      if (err instanceof RateLimitedError) this.cache.pause(err.retryAfterMs);
      throw err;
    }
    await this.cache.patch<ProjectBoardValue>(this.key, (v) => ({
      ...v,
      items: v.items.map((i) => (i.itemId === moved.itemId ? { ...i, statusId: moved.statusId } : i)),
    }));
    const after = (await this.cache.peek<ProjectBoardValue>(this.key))!;
    return this.view(after.value, after.fetchedAt, false, null);
  }

  private view(value: ProjectBoardValue, fetchedAt: number, stale: boolean, staleReason: string | null): ProjectBoard {
    return {
      owner: this.project.owner,
      number: this.project.number,
      title: value.title,
      url: value.url,
      field: value.field,
      lanes: toLanes(value),
      count: value.items.length,
      fetchedAt,
      stale,
      staleReason,
    };
  }
}

export interface CreateGithubProjectOptions extends Partial<GithubGraphqlSourceOptions> {
  project: ProjectRef;
  cache: GithubCache;
}

/** Monta o kanban do Project com o adaptador GraphQL (token do `gh` por padrão), sobre o cache dado. */
export function createGithubProject({ project, cache, token = () => ghCliToken(), ...rest }: CreateGithubProjectOptions): GithubProject {
  return new GithubProject({ source: new GithubProjectSource({ token, ...rest }), cache, project });
}
