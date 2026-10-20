// As instruções dos agentes de um repositório (#183): a aba Instruções de /ui/repos/<owner>/<repo>.
//
// | Rota                                                         | Resposta (src/agent-instructions/model.ts) |
// | ------------------------------------------------------------ | ------------------------------------------- |
// | `GET /api/agent-instructions/<owner>/<repo>`                 | `AgentInstructions`, sem o texto dos arquivos |
// | `GET /api/agent-instructions/<owner>/<repo>/file?path=`      | `InstructionFileView`: o arquivo e os imports já lidos |
//
// `?refresh=1` é o Atualizar: relê a descoberta e a árvore ignorando o TTL, com o mínimo de 30 s do
// cache (decisão 0001). `<owner>` e `<repo>` passam pelo padrão de nome do GitHub antes de qualquer
// coisa; fora dele, 400. A rota do arquivo só serve um arquivo de instrução que a leitura listou
// (`files[].path`); qualquer outro caminho, mesmo existente no repositório, dá 404.
//
// ## Nunca espera o GitHub
//
// Como a de repositórios (api/repos.ts): a lista sai do que está em memória; vencida (60 s) ou
// ausente, a montagem roda por trás e o pedido volta na hora com `state: 'loading'`. Quando a
// montagem muda a resposta, o núcleo registra `{ type: 'agent-instructions', key: '<owner>/<repo>' }`
// em minúsculas no cursor de mudanças, e a tela relê. A rota do arquivo é aberta a partir da lista:
// sem montagem pronta, ela espera a que está rodando.
//
// ## Cache (decisão 0001; estudo, "Como a leitura entra no cache")
//
// - `repo-files:<owner>/<repo>`: a descoberta (commit, raiz, `.claude/`), TTL de 15 min;
// - `instructions:tree:<owner>/<repo>`: os caminhos que interessam da árvore recursiva (instruções,
//   `.claude/`, `.mcp.json` e os `.md`, alvos prováveis de import), com ETag,
//   TTL de 15 min, relida na hora quando a árvore do commit mudou;
// - `blob:<oid>`: o texto de cada arquivo, sem TTL (o hash do Git é o conteúdo);
// - `instructions:paths:<owner>/<repo>:<commit>`: onde cada import fora desses caminhos caiu
//   (o `oid`, ou `null` quando não existe), sem TTL (o commit não muda).
// Com o GitHub fora ou limitado, serve o que há no cache com a hora da leitura (`readAt`) e o motivo
// (`error`). Todas as chamadas passam pela fila do GitHub do núcleo, uma de cada vez.
//
// ## Segurança
//
// O texto do repositório é dado: só sai na rota do arquivo, para a tela mostrar. Dos hooks sai o
// evento, o matcher e a quantidade, nunca o comando. Nenhum token entra na resposta, nem nos erros.

import type { ServerResponse } from 'node:http';
import { importsOf, importTarget, isInstructionFile, MAX_IMPORT_DEPTH } from '../agent-instructions/imports.ts';
import type { AgentInstructions, InstructionFileView, InstructionsContent, InstructionsState } from '../agent-instructions/model.ts';
import { neededPaths, readInstructions, withTexts } from '../agent-instructions/read.ts';
import { GithubCache, MemoryCacheStore, NoDataError, type CacheResult } from '../github/cache.ts';
import { GithubCallQueue } from '../github/call-queue.ts';
import { isInterestingPath, MAX_TREE_PATHS, RepoFilesSource, validPath, type BlobRequest, type RepoBlob, type RepoFilesDiscovery, type RepoTreeSummary } from '../github/repo-files-source.ts';
import { GithubReposSource, NOME_DO_DONO, NOME_DO_REPO, SemGithubError } from '../github/repos-source.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { CursorDeMudancas } from '../mudancas/cursor.ts';
import { criarGithubFalso, DADOS_DA_DEMO } from '../simulador/github-falso.ts';

export const AGENT_INSTRUCTIONS_ROUTE = '/api/agent-instructions';

export const AGENT_INSTRUCTIONS_TTL = {
  /** A descoberta (commit, raiz e `.claude/`). */
  discovery: 15 * 60_000,
  /** A árvore recursiva; o 304 do ETag não gasta o limite primário. */
  tree: 15 * 60_000,
} as const;

/** Repositórios guardados em memória; acima disso sai o lido há mais tempo. */
export const MAX_AGENT_INSTRUCTIONS_ENTRIES = 50;

const NO_GITHUB = 'sem GitHub neste núcleo';

interface StoredBlob {
  text: string;
  bytes: number;
}

interface Entry {
  value: AgentInstructions | null;
  /** O texto dos arquivos da última montagem, para a rota do arquivo (nunca vai na lista). */
  texts: Map<string, string>;
  at: number;
  running: Promise<void> | null;
  force: boolean;
}

const newEntry = (): Entry => ({ value: null, texts: new Map(), at: -Infinity, running: null, force: false });

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A chave da mudança e do cache: `owner/repo` em minúsculas. */
export const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

const EMPTY_CONTENT: InstructionsContent = {
  truncated: false,
  empty: true,
  files: [],
  rules: [],
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  plugins: [],
  marketplaces: [],
  mcp: [],
  settings: 'none',
  warnings: [],
};

export function emptyInstructions(repo: string, state: InstructionsState, error: string | null): AgentInstructions {
  return { state, error, repo, commit: null, readAt: null, ...structuredClone(EMPTY_CONTENT), empty: state === 'ready' };
}

export interface AgentInstructionsOptions {
  /** `null`: núcleo sem GitHub; as respostas vêm com `state: 'no-github'`. */
  source: RepoFilesSource | null;
  cache?: GithubCache;
  changes?: CursorDeMudancas | null;
  now?: () => number;
  /** Validade da resposta montada. Padrão 60 s. */
  validityMs?: number;
  /** A fila das chamadas ao GitHub, dividida com os repositórios no núcleo. */
  queue?: GithubCallQueue;
  log?: (message: string) => void;
}

export type FileAnswer = { status: 200; body: InstructionFileView } | { status: 400 | 404 | 503; body: { error: string } };

export class AgentInstructionsService {
  private readonly source: RepoFilesSource | null;
  private readonly cache: GithubCache;
  private readonly changes: CursorDeMudancas | null;
  private readonly now: () => number;
  private readonly validityMs: number;
  private readonly queue: GithubCallQueue;
  private readonly log: (message: string) => void;
  private readonly entries = new Map<string, Entry>();
  private noToken: string | null = null;
  /** Chamadas que passaram pelo cache até a fonte (medição e testes). */
  calls = { source: 0 };

  constructor({ source, cache, changes = null, now = Date.now, validityMs = 60_000, queue = new GithubCallQueue(), log = () => {} }: AgentInstructionsOptions) {
    this.source = source;
    this.cache = cache ?? new GithubCache({ store: new MemoryCacheStore(), now });
    this.changes = changes;
    this.now = now;
    this.validityMs = validityMs;
    this.queue = queue;
    this.log = log;
  }

  /** A lista como está agora; dispara a montagem por trás se venceu. Nunca espera o GitHub. */
  async overview(owner: string, repo: string, { refresh = false } = {}): Promise<AgentInstructions> {
    if (!this.source) return emptyInstructions(`${owner}/${repo}`, 'no-github', null);
    const e = this.entry(repoKey(owner, repo));
    if (refresh && !e.running) {
      e.at = -Infinity;
      e.force = true;
    }
    this.trigger(e, owner, repo);
    return e.value ?? emptyInstructions(`${owner}/${repo}`, 'loading', null);
  }

  /** Um arquivo de instrução listado, com a árvore de imports e o texto de cada import achado. */
  async file(owner: string, repo: string, path: string): Promise<FileAnswer> {
    if (!validPath(path)) return { status: 400, body: { error: 'path: o caminho de um arquivo do repositório' } };
    if (!this.source) return { status: 503, body: { error: NO_GITHUB } };
    const e = this.entry(repoKey(owner, repo));
    this.trigger(e, owner, repo);
    if ((!e.value || e.value.state === 'loading') && e.running) await e.running;
    const v = e.value;
    if (!v || v.state === 'loading') return { status: 503, body: { error: 'a leitura do repositório ainda não terminou' } };
    if (v.state === 'not-found') return { status: 404, body: { error: 'repositório não encontrado' } };
    if (v.state !== 'ready') return { status: 503, body: { error: v.error ?? NO_GITHUB } };
    const file = v.files.find((f) => f.path === path);
    if (!file) return { status: 404, body: { error: 'não é um arquivo de instrução deste repositório' } };
    const read = (p: string) => e.texts.get(p);
    return {
      status: 200,
      body: { state: v.state, error: v.error, repo: v.repo, readAt: v.readAt, path: file.path, kind: file.kind, text: read(file.path) ?? '', tree: withTexts(file.tree, read) },
    };
  }

  /** Espera as montagens em andamento (testes e o primeiro desenho). */
  async wait(): Promise<void> {
    for (;;) {
      const running = [...this.entries.values()].map((e) => e.running).filter(Boolean);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (e) this.entries.delete(key);
    else e = newEntry();
    this.entries.set(key, e);
    if (this.entries.size > MAX_AGENT_INSTRUCTIONS_ENTRIES) {
      const [old] = [...this.entries].find(([, x]) => !x.running) ?? [...this.entries][0];
      this.entries.delete(old);
    }
    return e;
  }

  private trigger(e: Entry, owner: string, repo: string): void {
    if (e.running || this.now() - e.at < this.validityMs) return;
    const key = repoKey(owner, repo);
    e.running = this.build(e, owner, repo)
      .catch((err: unknown) => {
        const msg = reason(err);
        this.log(`agent-instructions: a montagem de ${key} falhou: ${msg}`);
        const previous = e.value && e.value.state === 'ready' ? e.value : null;
        this.publish(e, previous ? { ...previous, error: msg } : emptyInstructions(`${owner}/${repo}`, 'error', msg), key, e.texts);
      })
      .finally(() => {
        e.at = this.now();
        e.force = false;
        e.running = null;
      });
  }

  private publish(e: Entry, value: AgentInstructions, key: string, texts: Map<string, string>): void {
    const before = e.value === null ? null : JSON.stringify(e.value);
    e.value = value;
    e.texts = texts;
    if (before !== JSON.stringify(value)) this.changes?.registrar({ type: 'agent-instructions', key, sessionId: null, accountId: null });
  }

  /** Uma chamada à fonte, contada e posta na fila do GitHub. O token que falta vira `no-github`. */
  private call<T>(fn: (source: RepoFilesSource) => Promise<T>): Promise<T> {
    this.calls.source++;
    return this.queue.run(async () => {
      try {
        const v = await fn(this.source!);
        this.noToken = null;
        return v;
      } catch (err) {
        if (err instanceof SemGithubError) this.noToken = err.message;
        throw err;
      }
    });
  }

  private async build(e: Entry, owner: string, repo: string): Promise<void> {
    const key = repoKey(owner, repo);
    const label = `${owner}/${repo}`;
    let discovery: CacheResult<RepoFilesDiscovery | null>;
    try {
      discovery = await this.cache.get(`repo-files:${key}`, AGENT_INSTRUCTIONS_TTL.discovery, async () => ({ value: await this.call((s) => s.discover(owner, repo)) }), { force: e.force });
    } catch (err) {
      const noToken = this.noToken ?? (err instanceof NoDataError && err.cause instanceof SemGithubError ? err.cause.message : null);
      const msg = noToken ?? reason(err);
      const previous = e.value && e.value.state === 'ready' ? e.value : null;
      this.publish(e, previous ? { ...previous, error: msg } : emptyInstructions(label, noToken ? 'no-github' : 'error', msg), key, e.texts);
      return;
    }
    const d = discovery.value;
    if (!d) {
      this.publish(e, emptyInstructions(label, 'not-found', null), key, new Map());
      return;
    }
    const errors: string[] = discovery.stale && discovery.staleReason ? [discovery.staleReason] : [];
    const readAt = new Date(discovery.fetchedAt).toISOString();
    if (!d.commit) {
      this.publish(e, { ...emptyInstructions(d.nameWithOwner, 'ready', errors[0] ?? null), commit: null, readAt }, key, new Map());
      return;
    }

    // As subpastas: a árvore recursiva, relida na hora quando a árvore do commit é outra.
    const known = new Map(d.files.map((f) => [f.path, f.oid] as const));
    let truncated = false;
    let treeComplete = false;
    const treeKey = `instructions:tree:${key}`;
    try {
      const cached = (await this.cache.store.get(treeKey))?.value as RepoTreeSummary | undefined;
      const ttl = cached?.sha && d.tree && cached.sha !== d.tree ? 0 : AGENT_INSTRUCTIONS_TTL.tree;
      const tree = await this.cache.get<RepoTreeSummary>(
        treeKey,
        ttl,
        async ({ etag }) => {
          const r = await this.call((s) => s.tree(owner, repo, etag));
          return r.state === 'not-modified' ? { notModified: true } : { value: r.value, etag: r.etag };
        },
        { force: e.force },
      );
      if (tree.stale && tree.staleReason) errors.push(tree.staleReason);
      truncated = tree.value.truncated;
      treeComplete = tree.value.sha !== null && !truncated && tree.value.files.length < MAX_TREE_PATHS;
      for (const f of tree.value.files) if (!known.has(f.path)) known.set(f.path, f.oid);
    } catch (err) {
      errors.push(reason(err));
    }

    const texts = await this.readTexts(owner, repo, key, d.commit, known, treeComplete, errors);
    const found = [...texts.paths];
    const content = readInstructions(found, (p) => texts.text.get(p), { truncated });
    this.publish(e, { state: 'ready', error: errors[0] ?? null, repo: d.nameWithOwner, commit: d.commit, readAt, ...content }, key, texts.text);
  }

  /**
   * O texto dos arquivos que a leitura usa e dos `@imports` deles, até a profundidade máxima. Do
   * cache pelo `oid` quando há; o resto em lotes de 50. Um import fora dos caminhos que a árvore guarda
   * (`isInterestingPath`: instruções, `.claude/`, `.mcp.json` e os `.md`) é pedido pelo caminho no
   * lote seguinte, e o resultado (achado ou não) fica guardado para o commit.
   */
  private async readTexts(
    owner: string,
    repo: string,
    key: string,
    commit: string,
    known: Map<string, string>,
    treeComplete: boolean,
    errors: string[],
  ): Promise<{ text: Map<string, string>; paths: Set<string> }> {
    const text = new Map<string, string>();
    const pathsKey = `instructions:paths:${key}:${commit}`;
    const located: Record<string, string | null> = { ...(((await this.cache.store.get(pathsKey))?.value as Record<string, string | null> | undefined) ?? {}) };
    let locatedChanged = false;
    const oidOf = (p: string) => known.get(p) ?? located[p];

    const ensure = async (paths: readonly string[]) => {
      const requests: BlobRequest[] = [];
      const forPath: string[] = [];
      for (const p of paths) {
        if (text.has(p)) continue;
        const oid = oidOf(p);
        if (oid === null) continue;
        // Com a árvore inteira, um `.md` que não está nela não existe: nada a pedir.
        if (oid === undefined && treeComplete && isInterestingPath(p)) continue;
        if (oid !== undefined) {
          const hit = (await this.cache.store.get(`blob:${oid}`))?.value as StoredBlob | undefined;
          if (hit) {
            text.set(p, hit.text);
            continue;
          }
          requests.push({ oid });
        } else {
          requests.push({ commit, path: p });
        }
        forPath.push(p);
      }
      if (!requests.length) return;
      let blobs: (RepoBlob | null)[];
      try {
        blobs = await this.call((s) => s.blobs(owner, repo, requests));
      } catch (err) {
        errors.push(reason(err));
        return;
      }
      for (let i = 0; i < forPath.length; i++) {
        const p = forPath[i];
        const b = blobs[i];
        if ('path' in requests[i]) {
          located[p] = b?.oid ?? null;
          locatedChanged = true;
        }
        if (!b) continue;
        text.set(p, b.text);
        await this.cache.put(`blob:${b.oid}`, { text: b.text, bytes: b.bytes } satisfies StoredBlob);
      }
    };

    await ensure(neededPaths([...known.keys()]));
    // Os imports, um salto por lote: os alvos de cada arquivo já lido entram no lote seguinte.
    const expanded = new Set<string>();
    let frontier = [...known.keys()].filter(isInstructionFile);
    for (let depth = 0; depth < MAX_IMPORT_DEPTH && frontier.length; depth++) {
      const targets = new Set<string>();
      for (const p of frontier) {
        if (expanded.has(p)) continue;
        expanded.add(p);
        const t = text.get(p);
        if (t === undefined) continue;
        for (const ref of importsOf(t)) {
          const target = importTarget(p, ref);
          if (target && validPath(target) && !expanded.has(target)) targets.add(target);
        }
      }
      await ensure([...targets]);
      frontier = [...targets].filter((p) => text.has(p));
    }
    if (locatedChanged) await this.cache.put(pathsKey, located);

    const paths = new Set(known.keys());
    for (const [p, oid] of Object.entries(located)) if (oid) paths.add(p);
    return { text, paths };
  }
}

/** A rota de `/api/agent-instructions`, registrada no servidor (`OpcoesDaApi.agentInstructions`). Responde só a `GET`. */
export type AgentInstructionsRoute = (res: ServerResponse, url: URL) => Promise<void>;

export function createAgentInstructionsRoute(service: AgentInstructionsService): AgentInstructionsRoute {
  return async (res, url) => {
    const m = /^\/api\/agent-instructions\/([^/]+)\/([^/]+)(\/file)?\/?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: 'não encontrado' });
    let owner: string;
    let repo: string;
    try {
      owner = decodeURIComponent(m[1]);
      repo = decodeURIComponent(m[2]);
    } catch {
      return send(res, 400, { error: 'repositório inválido' });
    }
    if (!NOME_DO_DONO.test(owner) || !NOME_DO_REPO.test(repo)) return send(res, 400, { error: 'repositório inválido: use <dono>/<repo> com o nome do GitHub' });
    if (m[3]) {
      const path = url.searchParams.get('path');
      if (!path) return send(res, 400, { error: 'path: o caminho do arquivo de instrução' });
      const answer = await service.file(owner, repo, path);
      return send(res, answer.status, answer.body);
    }
    send(res, 200, await service.overview(owner, repo, { refresh: url.searchParams.get('refresh') === '1' }));
  };
}

export interface CoreAgentInstructionsOptions {
  /** Demonstração: o GitHub falso (src/simulador/github-falso.ts), nunca a API real. */
  demo: boolean;
  /** `--sem-github`: as respostas vêm com `state: 'no-github'`. */
  noGithub: boolean;
  /** O cache do GitHub do núcleo, o mesmo dos repositórios e do trabalho. */
  cache: GithubCache;
  changes: CursorDeMudancas;
  /** A fila das chamadas ao GitHub, a mesma dos repositórios. */
  queue: GithubCallQueue;
  log?: (message: string) => void;
}

/** Monta o serviço e a rota como o núcleo usa (cli.ts): token do `gh`, cache no banco, a fila do núcleo. */
export function createCoreAgentInstructions({ demo, noGithub, cache, changes, queue, log }: CoreAgentInstructionsOptions): { service: AgentInstructionsService; route: AgentInstructionsRoute } {
  // A demo aponta para um endereço que não resolve: mesmo que o falso falhasse, nada sai para o GitHub.
  const transport = demo
    ? new GithubReposSource({ token: 'demo', fetch: criarGithubFalso(DADOS_DA_DEMO, { atrasoMs: 120 }).fetch, url: 'https://github-falso.invalid/graphql', api: 'https://github-falso.invalid' })
    : noGithub
      ? null
      : new GithubReposSource();
  const service = new AgentInstructionsService({ source: transport ? new RepoFilesSource(transport) : null, cache, changes, queue, ...(log ? { log } : {}) });
  return { service, route: createAgentInstructionsRoute(service) };
}
