// Instalar o Ahrena Framework num repositório pelo console, por PR (#184): a prévia (C36), o bloqueio
// (C37) e o PR. O domínio está em src/framework-install; as escritas no GitHub, em
// src/github/pull-request-writer.ts.
//
// | Rota                                                                  | O quê |
// | --------------------------------------------------------------------- | ----- |
// | `GET /api/framework-install/<owner>/<repo>/plan?platforms=&plugins=`  | `FrameworkInstallPlan`: o que achamos, as escolhas e o plano com o diff. Não escreve |
// | `POST /api/framework-install/<owner>/<repo>`                          | Abre o PR: `{ platforms, plugins, planHash, title?, issue? }` → `InstallAnswer` |
// | `GET /api/framework-install/<owner>/<repo>/pull-request`              | `{ state, error, pullRequest }`: o PR de instalação, ou `null` |
//
// `platforms` e `plugins` são listas separadas por vírgula (no `POST`, listas JSON). Vazias, o padrão:
// `claude,codex` e os plugins base mais os sugeridos. Os base (`ahrena-foundation`,
// `ahrena-contributing`, `ahrena-engineering-fundamentals`) entram sempre. `cursor` (a confirmar), uma
// plataforma ou um plugin que não existem dão 400. `<owner>` e `<repo>` passam pelo padrão de nome do
// GitHub antes de qualquer coisa; fora dele, 400. `?refresh=1` no plano relê ignorando o TTL.
//
// ## O contrato para a tela
//
// ```ts
// FrameworkInstallPlan = {
//   state: 'ready' | 'loading' | 'error' | 'not-found' | 'no-github', error: string | null,
//   readAt: string | null, repo: 'owner/repo', frameworkRepo: 'owner/repo', catalogCommit: string | null,
//   canWrite: boolean, writeBlockedReason: string | null, installed: boolean,
//   found: { languages: string[], frameworks: string[], tests: string | false, ci: string | false,
//            files: { 'CLAUDE.md': boolean, 'AGENTS.md': boolean, '.claude/settings.json': boolean } },
//   platforms: [{ id: 'claude' | 'codex' | 'cursor', label, detail, available, checked, note: 'a confirmar' | null }],
//   plugins: [{ name, description, group: 'base' | 'suggested' | 'other', why: string | null, checked, locked }],
//   choice: { platforms: string[], plugins: string[] },
//   files: [{ path, action: 'create' | 'merge' | 'unchanged' | 'refused', why, add, del, diff }],
//   blocked: null | { kind: 'invalid-json' | 'unpaired-markers' | 'unreadable' | 'no-write' | 'empty-repository'
//                            | 'nothing-to-do' | 'branch-exists', message, path: string | null, url: string | null },
//   branch: 'chore/install-ahrena-framework', title: 'chore: install the Ahrena Framework',
//   planHash: string | null, pullRequest: PullRequestState | null }
// PullRequestState = { number, url, title, branch, base, state: 'open' | 'merged' | 'closed',
//   checks: 'pending' | 'success' | 'failure' | null, review: 'approved' | 'changes_requested' | 'review_required' | null, updatedAt }
// InstallAnswer = { status: 'opened' | 'already-open', pullRequest: PullRequestState }   // 201 opened, 200 already-open
// erro = { error: string, code: string, planHash?: string }
// ```
//
// `blocked`, conferido nesta ordem: um arquivo recusado (`invalid-json`: o `.claude/settings.json` não
// dá para mesclar; `unpaired-markers`: os marcadores do framework desemparelhados; `unreadable`: o
// arquivo existe mas o GitHub não o entregou inteiro, binário ou cortado; `path` diz qual), `no-write`,
// `empty-repository`, `nothing-to-do` e `branch-exists` (o branch `chore/install-ahrena-framework`
// sobrou sem PR aberto e fora do HEAD do padrão; `url` é o link do branch no GitHub, para a pessoa
// apagá-lo ou abrir um PR dele). `url` é `null` nos outros. Um branch vazio no HEAD do padrão, deixado pelo próprio console
// numa falha, é reaproveitado e não bloqueia. O console nunca apaga nem força um branch.
//
// Os erros do `POST`, todos antes de qualquer escrita: 400 `bad-request` (corpo, título, plataforma
// ou plugin), 415 sem JSON, 422 `invalid-issue` (a issue não é número), 403 `no-write` (a conta não
// escreve no repositório), 422 `invalid-json`, `unpaired-markers` ou `unreadable` (um arquivo
// recusado), 409 `plan-changed` (o plano mudou desde a prévia; o corpo traz o `planHash` novo), 422
// `nothing-to-do`, 422 `empty-repository`, 409 `branch-exists`, 404 `not-found`, 503 `no-github`,
// 502 `github-error`.
//
// ## Nunca espera o GitHub
//
// Como a das instruções (api/agent-instructions.ts): o plano sai do que está em memória; vencido (60 s)
// ou ausente, a leitura roda por trás e o pedido volta na hora com `state: 'loading'`. Quando a leitura
// muda o que o plano mostra, e quando o PR abre ou muda (CI, review, merge), o núcleo registra
// `{ type: 'framework-install', key: '<owner>/<repo>' }` em minúsculas no cursor de mudanças, e a tela
// relê. Com um PR aberto e alguém olhando nos últimos 15 min, o estado do PR é relido a cada 30 s.
// O `POST` é a exceção: relê o repositório na hora (TTL zero) e recalcula o plano antes de escrever.
//
// ## Cache (decisão 0001)
//
// - `repo-files:<owner>/<repo>`: a descoberta, a mesma da aba Instruções (#183), TTL de 15 min;
// - `framework-install:tree:<owner>/<repo>`: os caminhos da árvore que a detecção usa
//   (`isDetectionPath`), com ETag e TTL de 15 min, relida quando a árvore do commit é outra;
// - `blob:<oid>`: o texto do `CLAUDE.md`, do `AGENTS.md` e dos manifestos (`package.json`,
//   `pyproject.toml`, `requirements.txt`), o mesmo cache da #183. O `.claude/settings.json` não vai
//   para o cache do banco (a #183 só guarda a forma dele): o texto fica só em memória, pelo `oid`;
// - `framework-install:target:<owner>/<repo>`: permissão, HEAD do padrão e o PR do branch, TTL de 60 s;
// - `framework-install:catalog:<framework>`: o catálogo (marketplace e regras), TTL de 1 h.
// Todas as chamadas passam pela fila do GitHub do núcleo, uma de cada vez.
//
// ## Segurança
//
// A escrita aceita a própria `/ui`: `Origin` exatamente `http://<Host>` com o nosso Host, só no
// caminho exato do `POST` (`frameworkInstallWriteFromSameOrigin`, chamada em server.ts), e o pedido
// sem `Origin` de 127.0.0.1, como as outras escritas (decisão 0003). Pede `Content-Type:
// application/json`. Nenhum token entra na resposta, nos erros ou no log; o branch padrão nunca é
// escrito. O diff mostra 3 linhas de contexto em volta do que muda.

import { githubReposTransport, type GithubAccess } from './github-access.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AVAILABLE_PLATFORMS,
  BASE_PLUGINS,
  DEFAULT_FRAMEWORK_REPO,
  INSTALL_BRANCH,
  INSTALL_TITLE,
  InstallRefused,
  PLATFORM_IDS,
  type Catalog,
  type Choice,
  type PlanFile,
  type PlatformId,
  type PullRequestState,
} from '../framework-install/model.ts';
import { buildCatalog, isCatalogPath, MARKETPLACE_PATH } from '../framework-install/catalog.ts';
import { detect, DETECTION_TEXTS, isDetectionPath } from '../framework-install/detect.ts';
import { unifiedDiff } from '../framework-install/diff.ts';
import { isInstalled, plan, planHash } from '../framework-install/plan.ts';
import { branchExistsMessage, openInstallPullRequest, parseIssue, pullRequestBody } from '../framework-install/pull-request.ts';
import { GithubCache, MemoryCacheStore, NoDataError, type CacheResult } from '../github/cache.ts';
import { GithubCallQueue } from '../github/call-queue.ts';
import { PullRequestWriter, type InstallTarget } from '../github/pull-request-writer.ts';
import { RepoFilesSource, type BlobRequest, type GithubTransport, type RepoFilesDiscovery, type RepoTreeSummary } from '../github/repo-files-source.ts';
import { GithubReposSource, NOME_DO_DONO, NOME_DO_REPO, SemGithubError } from '../github/repos-source.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { ChangeCursor } from '../changes/cursor.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, fakeFrameworkRepo, type PullRequestTimeline } from '../simulator/fake-github.ts';
import { repoKey } from './agent-instructions.ts';

export const FRAMEWORK_INSTALL_ROUTE = '/api/framework-install';
/** A variável que troca o repositório do framework (decisão 1 de 20/10). */
export const FRAMEWORK_REPO_ENV = 'AHRENA_CONSOLE_FRAMEWORK_REPO';

export const FRAMEWORK_INSTALL_TTL = {
  discovery: 15 * 60_000,
  tree: 15 * 60_000,
  /** Permissão, HEAD do padrão e o PR de instalação. */
  target: 60_000,
  /** O catálogo do framework. */
  catalog: 60 * 60_000,
} as const;

/** Repositórios guardados em memória; acima disso sai o lido há mais tempo. */
export const MAX_FRAMEWORK_INSTALL_ENTRIES = 50;
/** O corpo do `POST`: listas curtas, o hash, o título e a issue. */
export const MAX_INSTALL_BODY = 16 * 1024;
/** Depois do último pedido, por quanto tempo o PR aberto continua sendo relido. */
export const PULL_REQUEST_WATCH_MS = 15 * 60_000;

const PLATFORM_LABELS: Record<PlatformId, { label: string; detail: string }> = {
  claude: { label: 'Claude Code', detail: 'plugins no .claude/settings.json e o índice das regras pelo @AGENTS.md do CLAUDE.md' },
  codex: { label: 'Codex', detail: 'só o AGENTS.md; habilitar plugins pelo .codex/config.toml fica a confirmar' },
  cursor: { label: 'Cursor', detail: 'uma regra .cursor/rules/*.mdc por regra de julgamento' },
};

const NO_WRITE = 'Sua conta não tem permissão de escrita neste repositório: peça a quem administra para instalar.';
const NO_GITHUB = 'sem GitHub neste núcleo';

export type FrameworkInstallState = 'ready' | 'loading' | 'error' | 'not-found' | 'no-github';

/** Por que a instalação não pode seguir, na ordem em que é conferida. */
export type BlockedKind = 'invalid-json' | 'unpaired-markers' | 'unreadable' | 'no-write' | 'empty-repository' | 'nothing-to-do' | 'branch-exists';

export interface PlanFileView {
  path: string;
  action: PlanFile['action'];
  why: string;
  add: number;
  del: number;
  diff: string;
}

export interface FrameworkInstallPlan {
  state: FrameworkInstallState;
  error: string | null;
  readAt: string | null;
  repo: string;
  frameworkRepo: string;
  catalogCommit: string | null;
  canWrite: boolean;
  writeBlockedReason: string | null;
  installed: boolean;
  found: {
    languages: string[];
    frameworks: string[];
    tests: string | false;
    ci: string | false;
    files: { 'CLAUDE.md': boolean; 'AGENTS.md': boolean; '.claude/settings.json': boolean };
  };
  platforms: { id: PlatformId; label: string; detail: string; available: boolean; checked: boolean; note: 'a confirmar' | null }[];
  plugins: { name: string; description: string; group: 'base' | 'suggested' | 'other'; why: string | null; checked: boolean; locked: boolean }[];
  choice: { platforms: PlatformId[]; plugins: string[] };
  files: PlanFileView[];
  blocked: null | { kind: BlockedKind; message: string; path: string | null; url: string | null };
  branch: string;
  title: string;
  planHash: string | null;
  pullRequest: PullRequestState | null;
}

export interface PullRequestAnswer {
  state: FrameworkInstallState;
  error: string | null;
  pullRequest: PullRequestState | null;
}

/** O que a leitura junta do GitHub; o plano de cada escolha sai daqui sem chamar nada. */
interface Inputs {
  repo: string;
  commit: string | null;
  readAt: string;
  /** Os caminhos da detecção (texto `''`) e os textos lidos. */
  files: Record<string, string>;
  /** Arquivos de instrução que existem mas não vieram inteiros do GitHub (binário, cortado, outro tamanho). */
  unreadable: string[];
  target: InstallTarget;
  catalog: Catalog;
}

interface Loaded {
  state: FrameworkInstallState;
  error: string | null;
  inputs: Inputs | null;
}

interface Entry {
  owner: string;
  repo: string;
  loaded: Loaded | null;
  at: number;
  running: Promise<void> | null;
  force: boolean;
  /** O último pedido de alguém (a releitura do PR só roda com alguém olhando). */
  askedAt: number;
  /** As instalações deste repositório, uma de cada vez. */
  lock: Promise<unknown>;
  /** Instalações na fila ou em andamento: o despejo não larga a entrada (nem a trava) enquanto houver alguma. */
  installing: number;
  /** Sobe a cada publicação da instalação: a leitura de fundo que começou antes descarta o que leu. */
  generation: number;
}

interface StoredBlob {
  text: string;
  bytes: number;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** O repositório do framework: `AHRENA_CONSOLE_FRAMEWORK_REPO` com o padrão de nome do GitHub, ou o padrão. */
export function frameworkRepoFrom(value: string | undefined, log: (m: string) => void = () => {}): string {
  if (!value) return DEFAULT_FRAMEWORK_REPO;
  const [owner, name, extra] = value.trim().split('/');
  if (extra === undefined && owner && name && NOME_DO_DONO.test(owner) && NOME_DO_REPO.test(name)) return `${owner}/${name}`;
  log(`framework-install: ${FRAMEWORK_REPO_ENV} inválido (${value.slice(0, 80)}); usando ${DEFAULT_FRAMEWORK_REPO}`);
  return DEFAULT_FRAMEWORK_REPO;
}

/** Uma escolha pedida: listas (ou texto separado por vírgula); vazias, o padrão. */
export function parseChoice(platforms: unknown, plugins: unknown, catalog: Catalog, suggested: readonly string[]): Choice | { error: string } {
  const list = (v: unknown, what: string): string[] | { error: string } => {
    if (v === null || v === undefined) return [];
    if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map((x) => x.trim()).filter(Boolean);
    return { error: `${what}: uma lista de nomes` };
  };
  const p = list(platforms, 'platforms');
  if ('error' in p) return p;
  const g = list(plugins, 'plugins');
  if ('error' in g) return g;
  for (const id of p) {
    if (!PLATFORM_IDS.includes(id as PlatformId)) return { error: `platforms: ${id.slice(0, 40)} não existe (use ${AVAILABLE_PLATFORMS.join(', ')})` };
    if (!AVAILABLE_PLATFORMS.includes(id as PlatformId)) return { error: `platforms: ${id} fica a confirmar e ainda não é instalado pelo console` };
  }
  const names = new Set(catalog.plugins.map((x) => x.name));
  for (const n of g) if (!names.has(n)) return { error: `plugins: ${n.slice(0, 80)} não está no catálogo do framework` };
  const chosenPlatforms = p.length ? AVAILABLE_PLATFORMS.filter((x) => p.includes(x)) : [...AVAILABLE_PLATFORMS];
  const wanted = new Set([...BASE_PLUGINS, ...(g.length ? g : suggested)]);
  return { platforms: chosenPlatforms, plugins: displayOrder(catalog, suggested).filter((n) => wanted.has(n)) };
}

/** Base, sugeridos (na ordem dos sinais) e os outros (na ordem do catálogo). */
function displayOrder(catalog: Catalog, suggested: readonly string[]): string[] {
  const all = catalog.plugins.map((p) => p.name);
  const base = BASE_PLUGINS.filter((b) => all.includes(b));
  const sug = suggested.filter((s) => all.includes(s) && !base.includes(s as (typeof BASE_PLUGINS)[number]));
  return [...base, ...sug, ...all.filter((n) => !base.includes(n as (typeof BASE_PLUGINS)[number]) && !sug.includes(n))];
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json'] as const;

/** Só os arquivos que o plano mescla, para o plano não ver os caminhos da detecção como "existe". */
const planFilesOf = (files: Record<string, string>) => Object.fromEntries(INSTRUCTION_FILES.filter((p) => Object.hasOwn(files, p)).map((p) => [p, files[p]]));

/** O plano de uma escolha sobre o que foi lido; nunca chama o GitHub. */
export function planView(inputs: Inputs, choice: Choice, frameworkRepo: string): FrameworkInstallPlan {
  const detection = detect(inputs.files);
  const files = plan(planFilesOf(inputs.files), inputs.catalog, choice, { frameworkRepo, unreadable: inputs.unreadable });
  const refused = files.find((f) => f.action === 'refused');
  const target = inputs.target;
  const nothing = files.every((f) => f.action === 'unchanged');
  // O branch de instalação sobrou com commits e sem PR aberto (PR fechado ou mergeado, commit sem PR):
  // não é sobrescrito. Vazio, no HEAD do padrão, ele é reaproveitado e não bloqueia.
  const leftover = target.branchHead !== null && !target.openPullRequest && target.branchHead !== target.defaultBranch?.oid;
  const blocked: FrameworkInstallPlan['blocked'] = refused
    ? { kind: refused.refusal ?? 'invalid-json', message: `${refused.path}: ${refused.why}. Nada será escrito.`, path: refused.path, url: null }
    : !target.canWrite
      ? { kind: 'no-write', message: NO_WRITE, path: null, url: null }
      : !inputs.commit || !target.defaultBranch
        ? { kind: 'empty-repository', message: 'O repositório ainda não tem commit: não há de onde criar o branch.', path: null, url: null }
        : nothing
          ? { kind: 'nothing-to-do', message: 'O framework já está instalado com esta escolha: nada a mudar.', path: null, url: null }
          : leftover
            ? { kind: 'branch-exists', message: branchExistsMessage(INSTALL_BRANCH), path: null, url: `https://github.com/${inputs.repo}/tree/${INSTALL_BRANCH}` }
            : null;
  const order = displayOrder(inputs.catalog, detection.suggested.map((s) => s.name));
  const why = new Map(detection.suggested.map((s) => [s.name, s.why]));
  return {
    state: 'ready',
    error: null,
    readAt: inputs.readAt,
    repo: inputs.repo,
    frameworkRepo,
    catalogCommit: inputs.catalog.commit,
    canWrite: target.canWrite,
    writeBlockedReason: target.canWrite ? null : NO_WRITE,
    installed: isInstalled(planFilesOf(inputs.files)),
    found: {
      languages: detection.languages,
      frameworks: detection.frameworks,
      tests: detection.tests,
      ci: detection.ci,
      files: {
        'CLAUDE.md': Object.hasOwn(inputs.files, 'CLAUDE.md'),
        'AGENTS.md': Object.hasOwn(inputs.files, 'AGENTS.md'),
        '.claude/settings.json': Object.hasOwn(inputs.files, '.claude/settings.json'),
      },
    },
    platforms: PLATFORM_IDS.map((id) => ({
      id,
      ...PLATFORM_LABELS[id],
      available: AVAILABLE_PLATFORMS.includes(id),
      checked: choice.platforms.includes(id),
      note: AVAILABLE_PLATFORMS.includes(id) ? null : 'a confirmar',
    })),
    plugins: order.map((name) => {
      const p = inputs.catalog.plugins.find((x) => x.name === name)!;
      const base = (BASE_PLUGINS as readonly string[]).includes(name);
      return {
        name,
        description: p.description,
        group: base ? 'base' : why.has(name) ? 'suggested' : 'other',
        why: base ? 'base: sempre instalado' : (why.get(name) ?? null),
        checked: choice.plugins.includes(name),
        locked: base,
      };
    }),
    choice: { platforms: choice.platforms, plugins: choice.plugins },
    files: files.map((f) => {
      const d = f.action === 'refused' ? { text: '', add: 0, del: 0 } : unifiedDiff(f.path, f.before, f.after);
      return { path: f.path, action: f.action, why: f.why, add: d.add, del: d.del, diff: d.text };
    }),
    blocked,
    branch: INSTALL_BRANCH,
    title: INSTALL_TITLE,
    planHash: planHash(files, choice),
    pullRequest: target.latestPullRequest,
  };
}

export function emptyPlan(repo: string, frameworkRepo: string, state: FrameworkInstallState, error: string | null): FrameworkInstallPlan {
  return {
    state,
    error,
    readAt: null,
    repo,
    frameworkRepo,
    catalogCommit: null,
    canWrite: false,
    writeBlockedReason: null,
    installed: false,
    found: { languages: [], frameworks: [], tests: false, ci: false, files: { 'CLAUDE.md': false, 'AGENTS.md': false, '.claude/settings.json': false } },
    platforms: PLATFORM_IDS.map((id) => ({ id, ...PLATFORM_LABELS[id], available: AVAILABLE_PLATFORMS.includes(id), checked: AVAILABLE_PLATFORMS.includes(id), note: AVAILABLE_PLATFORMS.includes(id) ? null : 'a confirmar' })),
    plugins: [],
    choice: { platforms: [...AVAILABLE_PLATFORMS], plugins: [...BASE_PLUGINS] },
    files: [],
    blocked: null,
    branch: INSTALL_BRANCH,
    title: INSTALL_TITLE,
    planHash: null,
    pullRequest: null,
  };
}

export type PlanAnswer = { status: 200; body: FrameworkInstallPlan } | { status: 400; body: { error: string; code: string } };
export type InstallAnswer =
  | { status: 200 | 201; body: { status: 'opened' | 'already-open'; pullRequest: PullRequestState } }
  | { status: 400 | 403 | 404 | 409 | 422 | 502 | 503; body: { error: string; code: string; planHash?: string } };

export interface InstallRequest {
  platforms?: unknown;
  plugins?: unknown;
  planHash?: unknown;
  title?: unknown;
  issue?: unknown;
}

export interface FrameworkInstallOptions {
  /** O transporte do GitHub (token do `gh`, ou o falso); `null`: núcleo sem GitHub. */
  transport: GithubTransport | null;
  cache?: GithubCache;
  changes?: ChangeCursor | null;
  now?: () => number;
  /** Validade do que está em memória. Padrão 60 s. */
  validityMs?: number;
  queue?: GithubCallQueue;
  /** `dono/repo` do framework. Padrão `ahrenatechnology/ahrena-framework`. */
  frameworkRepo?: string;
  /** De quanto em quanto tempo o PR aberto é relido; 0 desliga (testes chamam `pollPullRequests`). Padrão 30 s. */
  pullRequestPollMs?: number;
  log?: (message: string) => void;
}

export class FrameworkInstallService {
  private readonly source: RepoFilesSource | null;
  private readonly writer: PullRequestWriter | null;
  private readonly cache: GithubCache;
  private readonly changes: ChangeCursor | null;
  private readonly now: () => number;
  private readonly validityMs: number;
  private readonly queue: GithubCallQueue;
  private readonly log: (message: string) => void;
  private readonly entries = new Map<string, Entry>();
  /** O texto do `.claude/settings.json` pelo `oid`, só em memória (nunca no cache do banco). */
  private readonly settingsTexts = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval> | null;
  readonly frameworkRepo: string;
  /** Chamadas que passaram pelo cache até a fonte de leitura (medição e testes). */
  calls = { source: 0 };

  constructor({ transport, cache, changes = null, now = Date.now, validityMs = 60_000, queue = new GithubCallQueue(), frameworkRepo = DEFAULT_FRAMEWORK_REPO, pullRequestPollMs = 30_000, log = () => {} }: FrameworkInstallOptions) {
    this.source = transport ? new RepoFilesSource(transport) : null;
    this.writer = transport ? new PullRequestWriter(transport, queue) : null;
    this.cache = cache ?? new GithubCache({ store: new MemoryCacheStore(), now });
    this.changes = changes;
    this.now = now;
    this.validityMs = validityMs;
    this.queue = queue;
    this.frameworkRepo = frameworkRepo;
    this.log = log;
    this.timer = transport && pullRequestPollMs > 0 ? setInterval(() => void this.pollPullRequests(), pullRequestPollMs) : null;
    this.timer?.unref();
  }

  /** Para a releitura periódica do PR (testes e o fim do núcleo). */
  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** O plano de uma escolha, como está agora; dispara a leitura por trás se venceu. Nunca espera o GitHub. */
  async plan(owner: string, repo: string, { platforms = null as unknown, plugins = null as unknown, refresh = false } = {}): Promise<PlanAnswer> {
    const label = `${owner}/${repo}`;
    if (!this.source) return { status: 200, body: emptyPlan(label, this.frameworkRepo, 'no-github', null) };
    const e = this.touch(owner, repo);
    if (refresh && !e.running) {
      e.at = -Infinity;
      e.force = true;
    }
    this.trigger(e);
    const l = e.loaded;
    if (!l || !l.inputs) return { status: 200, body: emptyPlan(label, this.frameworkRepo, l?.state ?? 'loading', l?.error ?? null) };
    const choice = parseChoice(platforms, plugins, l.inputs.catalog, detect(l.inputs.files).suggested.map((s) => s.name));
    if ('error' in choice) return { status: 400, body: { error: choice.error, code: 'bad-request' } };
    return { status: 200, body: { ...planView(l.inputs, choice, this.frameworkRepo), error: l.error } };
  }

  /** O PR de instalação, como está agora. Nunca espera o GitHub. */
  async pullRequest(owner: string, repo: string): Promise<PullRequestAnswer> {
    if (!this.source) return { state: 'no-github', error: null, pullRequest: null };
    const e = this.touch(owner, repo);
    this.trigger(e);
    const l = e.loaded;
    return { state: l?.state ?? 'loading', error: l?.error ?? null, pullRequest: l?.inputs?.target.latestPullRequest ?? null };
  }

  /** Abre o PR (o `POST`). Relê o repositório agora, recalcula o plano e só escreve se nada mudou desde a prévia. */
  async install(owner: string, repo: string, request: InstallRequest): Promise<InstallAnswer> {
    const e = this.touch(owner, repo);
    e.installing++;
    const turn = e.lock.then(() => this.installNow(e, request)).finally(() => {
      e.installing--;
    });
    e.lock = turn.catch(() => undefined);
    return turn;
  }

  /** Espera as leituras em andamento (testes e o primeiro desenho). */
  async wait(): Promise<void> {
    for (;;) {
      const running = [...this.entries.values()].map((e) => e.running).filter(Boolean);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  /** Relê o PR aberto dos repositórios que alguém olhou nos últimos 15 min; registra a mudança quando ele muda. */
  async pollPullRequests(): Promise<void> {
    if (!this.writer) return;
    for (const e of this.entries.values()) {
      const inputs = e.loaded?.inputs;
      if (!inputs || inputs.target.latestPullRequest?.state !== 'open' || this.now() - e.askedAt > PULL_REQUEST_WATCH_MS || e.running) continue;
      try {
        const key = repoKey(e.owner, e.repo);
        const t = await this.cache.get(`framework-install:target:${key}`, 0, async () => ({ value: await this.writer!.target(e.owner, e.repo, INSTALL_BRANCH) }));
        if (t.value && !t.stale && e.loaded?.inputs) this.publish(e, { ...e.loaded, inputs: { ...e.loaded.inputs, target: t.value } });
      } catch (err) {
        this.log(`framework-install: a releitura do PR de ${e.owner}/${e.repo} falhou: ${reason(err)}`);
      }
    }
  }

  private async installNow(e: Entry, request: InstallRequest): Promise<InstallAnswer> {
    const { owner, repo } = e;
    let issue: number | null;
    try {
      issue = parseIssue(request.issue);
    } catch (err) {
      return { status: 422, body: { error: reason(err), code: 'invalid-issue' } };
    }
    if (request.title !== undefined && request.title !== null && (typeof request.title !== 'string' || /[\r\n]/.test(request.title) || request.title.trim().length > 256)) {
      return { status: 400, body: { error: 'title: uma linha de até 256 caracteres', code: 'bad-request' } };
    }
    const title = typeof request.title === 'string' && request.title.trim() ? request.title.trim() : INSTALL_TITLE;
    if (typeof request.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(request.planHash)) return { status: 400, body: { error: 'planHash: o hash da prévia', code: 'bad-request' } };
    if (!this.source || !this.writer) return { status: 503, body: { error: NO_GITHUB, code: 'no-github' } };

    // Relê agora (TTL zero), por cima de qualquer leitura em andamento.
    if (e.running) await e.running;
    const loaded = await this.load(owner, repo, { fresh: true });
    e.generation++;
    this.publish(e, loaded);
    e.at = this.now();
    if (loaded.state === 'not-found') return { status: 404, body: { error: 'repositório não encontrado', code: 'not-found' } };
    if (loaded.state === 'no-github') return { status: 503, body: { error: loaded.error ?? NO_GITHUB, code: 'no-github' } };
    if (!loaded.inputs || loaded.error) return { status: 502, body: { error: `não deu para ler o repositório agora: ${loaded.error ?? 'sem dados'}`, code: 'github-error' } };
    const inputs = loaded.inputs;
    const choice = parseChoice(request.platforms, request.plugins, inputs.catalog, detect(inputs.files).suggested.map((s) => s.name));
    if ('error' in choice) return { status: 400, body: { error: choice.error, code: 'bad-request' } };
    const view = planView(inputs, choice, this.frameworkRepo);
    if (!inputs.target.canWrite) return { status: 403, body: { error: NO_WRITE, code: 'no-write' } };
    // Com o PR aberto, ele volta como está, mesmo que o plano tenha mudado desde a prévia.
    const open = inputs.target.openPullRequest;
    if (open) return { status: 200, body: { status: 'already-open', pullRequest: open } };
    const kind = view.blocked?.kind;
    if (kind === 'invalid-json' || kind === 'unpaired-markers' || kind === 'unreadable') return { status: 422, body: { error: view.blocked!.message, code: kind } };
    const changed = { status: 409 as const, body: { error: 'o repositório mudou desde a prévia: confira o plano de novo', code: 'plan-changed', planHash: view.planHash! } };
    if (view.planHash !== request.planHash) return changed;
    if (view.blocked?.kind === 'empty-repository') return { status: 422, body: { error: view.blocked.message, code: 'empty-repository' } };
    // O branch nasce do HEAD lido no alvo; se o padrão andou entre a descoberta e o alvo, o plano é de outro commit.
    if (inputs.commit !== inputs.target.defaultBranch?.oid) return changed;
    if (view.blocked?.kind === 'nothing-to-do') return { status: 422, body: { error: view.blocked.message, code: 'nothing-to-do' } };
    if (view.blocked?.kind === 'branch-exists') return { status: 409, body: { error: view.blocked.message, code: 'branch-exists' } };

    const files = plan(planFilesOf(inputs.files), inputs.catalog, choice, { frameworkRepo: this.frameworkRepo, unreadable: inputs.unreadable });
    let outcome: Awaited<ReturnType<typeof openInstallPullRequest>>;
    try {
      outcome = await openInstallPullRequest(this.writer.port(inputs.target), { files, title, body: pullRequestBody(files, choice.plugins, issue) });
    } catch (err) {
      if (err instanceof InstallRefused) return { status: err.code === 'branch-exists' ? 409 : 422, body: { error: err.message, code: err.code } };
      this.log(`framework-install: o PR de ${owner}/${repo} falhou: ${reason(err)}`);
      // O branch pode ter sido criado antes da falha: a prévia relê o alvo em vez de usar o guardado.
      await this.cache.invalidate(`framework-install:target:${repoKey(owner, repo)}`);
      e.at = -Infinity;
      return { status: 502, body: { error: `o GitHub recusou: ${reason(err)}`, code: 'github-error' } };
    }
    if (outcome.status === 'nothing-to-do') return { status: 422, body: { error: 'O framework já está instalado com esta escolha: nada a mudar.', code: 'nothing-to-do' } };
    if (outcome.status === 'already-open') return { status: 200, body: { status: 'already-open', pullRequest: outcome.pullRequest } };
    this.log(`framework-install: PR #${outcome.pullRequest.number} aberto em ${inputs.repo} (${INSTALL_BRANCH})`);
    // O console acabou de escrever: o PR entra no que está guardado na hora, sem reler.
    const target: InstallTarget = { ...inputs.target, branchHead: outcome.commit, openPullRequest: outcome.pullRequest, latestPullRequest: outcome.pullRequest };
    await this.cache.patch<InstallTarget | null>(`framework-install:target:${repoKey(owner, repo)}`, () => target);
    e.generation++;
    this.publish(e, { ...loaded, inputs: { ...inputs, target } });
    return { status: 201, body: { status: 'opened', pullRequest: outcome.pullRequest } };
  }

  private touch(owner: string, repo: string): Entry {
    const key = repoKey(owner, repo);
    let e = this.entries.get(key);
    if (e) this.entries.delete(key);
    else e = { owner, repo, loaded: null, at: -Infinity, running: null, force: false, askedAt: 0, lock: Promise.resolve(), installing: 0, generation: 0 };
    e.askedAt = this.now();
    this.entries.set(key, e);
    if (this.entries.size > MAX_FRAMEWORK_INSTALL_ENTRIES) {
      // Uma entrada com instalação na fila não sai: largá-la soltaria a trava e deixaria duas instalações correrem juntas.
      const idle = [...this.entries].find(([, x]) => x !== e && !x.installing && !x.running) ?? [...this.entries].find(([, x]) => x !== e && !x.installing);
      if (idle) this.entries.delete(idle[0]);
    }
    return e;
  }

  private trigger(e: Entry): void {
    if (e.running || this.now() - e.at < this.validityMs) return;
    const force = e.force;
    const generation = e.generation;
    e.running = this.load(e.owner, e.repo, { force })
      .then((loaded) => {
        // Uma instalação publicou no meio: o que esta leitura trouxe é mais velho (apagaria o PR recém-aberto).
        if (e.generation === generation) this.publish(e, loaded);
      })
      .catch((err: unknown) => {
        const msg = reason(err);
        this.log(`framework-install: a leitura de ${e.owner}/${e.repo} falhou: ${msg}`);
        if (e.generation !== generation) return;
        this.publish(e, e.loaded?.inputs ? { ...e.loaded, error: msg } : { state: 'error', error: msg, inputs: null });
      })
      .finally(() => {
        e.at = this.now();
        e.force = false;
        e.running = null;
      });
  }

  private publish(e: Entry, loaded: Loaded): void {
    const before = e.loaded === null ? null : JSON.stringify(e.loaded);
    e.loaded = loaded;
    if (before !== JSON.stringify(loaded)) this.changes?.record({ type: 'framework-install', key: repoKey(e.owner, e.repo), sessionId: null, accountId: null });
  }

  /** Uma leitura da fonte, contada e posta na fila do GitHub. */
  private call<T>(fn: (source: RepoFilesSource) => Promise<T>): Promise<T> {
    this.calls.source++;
    return this.queue.run(() => fn(this.source!));
  }

  /** Erro de token (o `gh` sem login) vira `no-github`; o resto, `error`. */
  private failure(err: unknown): Loaded {
    const cause = err instanceof NoDataError ? err.cause : err;
    if (cause instanceof SemGithubError) return { state: 'no-github', error: cause.message, inputs: null };
    return { state: 'error', error: reason(err), inputs: null };
  }

  private async load(owner: string, repo: string, { fresh = false, force = false } = {}): Promise<Loaded> {
    const key = repoKey(owner, repo);
    const ttl = (normal: number) => (fresh ? 0 : normal);
    const errors: string[] = [];
    const note = (r: CacheResult<unknown>) => {
      if (r.stale && r.staleReason) errors.push(r.staleReason);
    };
    let discovery: CacheResult<RepoFilesDiscovery | null>;
    let target: CacheResult<InstallTarget | null>;
    let catalog: CacheResult<Catalog>;
    try {
      discovery = await this.cache.get(`repo-files:${key}`, ttl(FRAMEWORK_INSTALL_TTL.discovery), async () => ({ value: await this.call((s) => s.discover(owner, repo)) }), { force });
      note(discovery);
      if (!discovery.value) return { state: 'not-found', error: null, inputs: null };
      target = await this.cache.get(`framework-install:target:${key}`, ttl(FRAMEWORK_INSTALL_TTL.target), async () => ({ value: await this.writer!.target(owner, repo, INSTALL_BRANCH) }), { force });
      note(target);
      if (!target.value) return { state: 'not-found', error: null, inputs: null };
      catalog = await this.cache.get(`framework-install:catalog:${this.frameworkRepo.toLowerCase()}`, FRAMEWORK_INSTALL_TTL.catalog, async () => ({ value: await this.readCatalog() }), { force });
      note(catalog);
    } catch (err) {
      return this.failure(err);
    }
    const d = discovery.value;
    const readAt = new Date(discovery.fetchedAt).toISOString();
    const base = { repo: d.nameWithOwner, commit: d.commit, readAt, target: target.value, catalog: catalog.value };
    if (!d.commit) return { state: 'ready', error: errors[0] ?? null, inputs: { ...base, files: {}, unreadable: [] } };

    // Os caminhos da detecção: a árvore (relida na hora quando a árvore do commit é outra) e a descoberta.
    const known = new Map(d.files.filter((f) => isDetectionPath(f.path)).map((f) => [f.path, f.oid] as const));
    const treeKey = `framework-install:tree:${key}`;
    try {
      const cached = (await this.cache.store.get(treeKey))?.value as RepoTreeSummary | undefined;
      const treeTtl = cached?.sha && d.tree && cached.sha !== d.tree ? 0 : FRAMEWORK_INSTALL_TTL.tree;
      const tree = await this.cache.get<RepoTreeSummary>(
        treeKey,
        treeTtl,
        async ({ etag }) => {
          const r = await this.call((s) => s.tree(owner, repo, etag, isDetectionPath));
          return r.state === 'not-modified' ? { notModified: true } : { value: r.value, etag: r.etag };
        },
        { force },
      );
      note(tree);
      for (const f of tree.value.files) if (!known.has(f.path)) known.set(f.path, f.oid);
    } catch (err) {
      errors.push(reason(err));
    }

    // Os textos: os de instrução e os manifestos pelo cache (`blob:<oid>`); o settings.json sempre lido, nunca guardado.
    const files: Record<string, string> = Object.fromEntries([...known.keys()].map((p) => [p, '']));
    const wanted = [...INSTRUCTION_FILES, ...DETECTION_TEXTS].filter((p) => known.has(p));
    const requests: BlobRequest[] = [];
    const forPath: string[] = [];
    for (const p of wanted) {
      const oid = known.get(p)!;
      // Do cache só o texto inteiro: a #183 guarda o `''` de um binário e o texto cortado com o `byteSize` do arquivo.
      const stored = p === '.claude/settings.json' ? undefined : ((await this.cache.store.get(`blob:${oid}`))?.value as StoredBlob | undefined);
      const hit = p === '.claude/settings.json' ? this.settingsTexts.get(oid) : stored && Buffer.byteLength(stored.text) === stored.bytes ? stored.text : undefined;
      if (hit !== undefined) {
        files[p] = hit;
        continue;
      }
      requests.push({ oid });
      forPath.push(p);
    }
    // Um arquivo de instrução que existe e não veio inteiro: o plano o recusa, nunca o trata como vazio.
    const unreadable: string[] = [];
    if (requests.length) {
      let blobs;
      try {
        blobs = await this.call((s) => s.blobs(owner, repo, requests));
      } catch (err) {
        return { state: 'error', error: `não deu para ler os arquivos do repositório: ${reason(err)}`, inputs: null };
      }
      for (let i = 0; i < forPath.length; i++) {
        const b = blobs[i];
        if (!b || !b.complete) {
          if ((INSTRUCTION_FILES as readonly string[]).includes(forPath[i])) unreadable.push(forPath[i]);
          continue;
        }
        files[forPath[i]] = b.text;
        if (forPath[i] !== '.claude/settings.json') await this.cache.put(`blob:${b.oid}`, { text: b.text, bytes: b.bytes } satisfies StoredBlob);
        else {
          this.settingsTexts.delete(b.oid);
          this.settingsTexts.set(b.oid, b.text);
          if (this.settingsTexts.size > MAX_FRAMEWORK_INSTALL_ENTRIES) this.settingsTexts.delete(this.settingsTexts.keys().next().value!);
        }
      }
    }
    return { state: 'ready', error: errors[0] ?? null, inputs: { ...base, files, unreadable } };
  }

  /** O catálogo do repositório do framework: o marketplace e as regras de cada plugin (frontmatter). */
  private async readCatalog(): Promise<Catalog> {
    const [owner, name] = this.frameworkRepo.split('/');
    const d = await this.call((s) => s.discover(owner, name));
    if (!d || !d.commit) throw new Error(`o repositório do framework (${this.frameworkRepo}) não foi encontrado`);
    const tree = await this.call((s) => s.tree(owner, name, null, isCatalogPath));
    const paths = tree.state === 'ok' ? tree.value.files : [];
    const market = paths.find((f) => f.path === MARKETPLACE_PATH);
    if (!market) throw new Error(`o repositório do framework (${this.frameworkRepo}) não tem ${MARKETPLACE_PATH}`);
    const texts = new Map<string, string>();
    const missing: { path: string; oid: string }[] = [];
    for (const f of paths) {
      const hit = (await this.cache.store.get(`blob:${f.oid}`))?.value as StoredBlob | undefined;
      if (hit) texts.set(f.path, hit.text);
      else missing.push(f);
    }
    if (missing.length) {
      const blobs = await this.call((s) => s.blobs(owner, name, missing.map((f) => ({ oid: f.oid }))));
      for (let i = 0; i < missing.length; i++) {
        const b = blobs[i];
        if (!b) continue;
        texts.set(missing[i].path, b.text);
        await this.cache.put(`blob:${b.oid}`, { text: b.text, bytes: b.bytes } satisfies StoredBlob);
      }
    }
    const marketText = texts.get(MARKETPLACE_PATH)!;
    texts.delete(MARKETPLACE_PATH);
    return buildCatalog(this.frameworkRepo, d.commit.slice(0, 7), marketText, texts);
  }
}

/** O caminho exato do `POST` (sem query): `/api/framework-install/<owner>/<repo>`. */
const INSTALL_WRITE = /^\/api\/framework-install\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** O `POST` da própria `/ui`: `Origin` exatamente `http://<Host>`, com o nosso Host, no caminho exato (decisão 0003). */
export function frameworkInstallWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (req.method !== 'POST' || typeof origin !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (!INSTALL_WRITE.test(req.url ?? '')) return false;
  return origin === `http://${host}`;
}

/** O corpo, ou `null` assim que passa do limite. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return resolve(null);
    const parts: Buffer[] = [];
    let size = 0;
    const onData = (part: Buffer) => {
      size += part.length;
      if (size <= max) return void parts.push(part);
      req.off('data', onData);
      req.pause();
      resolve(null);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** As rotas de `/api/framework-install`, registradas no servidor (`OpcoesDaApi.frameworkInstall`). O servidor já conferiu Host e Origin. */
export type FrameworkInstallRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function createFrameworkInstallRoute(service: FrameworkInstallService): FrameworkInstallRoute {
  return async (req, res, url) => {
    const m = /^\/api\/framework-install\/([^/]+)\/([^/]+)(\/plan|\/pull-request)?\/?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: 'não encontrado' });
    let owner: string;
    let repo: string;
    try {
      owner = decodeURIComponent(m[1]);
      repo = decodeURIComponent(m[2]);
    } catch {
      return send(res, 400, { error: 'repositório inválido', code: 'bad-request' });
    }
    if (!NOME_DO_DONO.test(owner) || !NOME_DO_REPO.test(repo)) return send(res, 400, { error: 'repositório inválido: use <dono>/<repo> com o nome do GitHub', code: 'bad-request' });
    if (m[3] === '/plan') {
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      const a = await service.plan(owner, repo, { platforms: url.searchParams.get('platforms'), plugins: url.searchParams.get('plugins'), refresh: url.searchParams.get('refresh') === '1' });
      return send(res, a.status, a.body);
    }
    if (m[3] === '/pull-request') {
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      return send(res, 200, await service.pullRequest(owner, repo));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    if (/^(cross-site|same-site)$/i.test(String(req.headers['sec-fetch-site'] ?? ''))) return send(res, 403, { error: 'origem não permitida' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json', code: 'bad-request' });
    const text = await readBody(req, MAX_INSTALL_BODY);
    if (text === null) {
      res.setHeader('connection', 'close');
      return send(res, 413, { error: 'corpo grande demais', code: 'bad-request' });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return send(res, 400, { error: 'JSON inválido no corpo', code: 'bad-request' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'o corpo é um objeto: { platforms, plugins, planHash, title?, issue? }', code: 'bad-request' });
    const a = await service.install(owner, repo, body as InstallRequest);
    send(res, a.status, a.body);
  };
}

export interface CoreFrameworkInstallOptions {
  /** Demonstração: o GitHub falso (src/simulator/fake-github.ts), nunca a API real. */
  demo: boolean;
  /** `--no-github`: as respostas vêm com `state: 'no-github'`. */
  noGithub: boolean;
  cache: GithubCache;
  changes: ChangeCursor;
  queue: GithubCallQueue;
  /** O valor de `AHRENA_CONSOLE_FRAMEWORK_REPO`. */
  frameworkRepo?: string;
  log?: (message: string) => void;
  /** The credential provider and transport (#241). Required outside the demo and `--no-github`; the demo takes only its token. */
  github?: GithubAccess | null;
}

/** Na demo, o PR aberto evolui sozinho: o CI passa em 20 s e o review aprova em 45 s. */
export const DEMO_PULL_REQUEST_TIMELINE: PullRequestTimeline = { checksAfterMs: 20_000, approvedAfterMs: 45_000 };

/** Monta o serviço e a rota como o núcleo usa (cli.ts): a credencial do provedor (#241), cache no banco, a fila do núcleo. */
export function createCoreFrameworkInstall({ demo, noGithub, cache, changes, queue, frameworkRepo, log, github }: CoreFrameworkInstallOptions): { service: FrameworkInstallService; route: FrameworkInstallRoute } {
  const repo = frameworkRepoFrom(frameworkRepo, log);
  // A demo aponta para um endereço que não resolve: mesmo que o falso falhasse, nada sai para o GitHub.
  const transport = githubReposTransport({
    demo,
    noGithub,
    github,
    demoFetch: () =>
      createFakeGithub({ ...DEMO_GITHUB_DATA, repos: [...DEMO_GITHUB_DATA.repos, fakeFrameworkRepo(repo)] }, { delayMs: 120, pullRequestTimeline: DEMO_PULL_REQUEST_TIMELINE }).fetch,
    demoBase: 'https://github-falso.invalid',
  });
  const service = new FrameworkInstallService({ transport, cache, changes, queue, frameworkRepo: repo, pullRequestPollMs: demo ? 5_000 : 30_000, ...(log ? { log } : {}) });
  return { service, route: createFrameworkInstallRoute(service) };
}
