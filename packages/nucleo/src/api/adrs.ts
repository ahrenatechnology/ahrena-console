// Os registros de decisão dos repositórios (#174): as ADRs (arquitetura) e as PDRs (produto), C28 a
// C31 e C38. As duas famílias de rotas leem a mesma lista; as de PDR filtram por `kind: pdr`.
//
// | Rota                                         | Resposta (src/adrs/model.ts) |
// | -------------------------------------------- | ---------------------------- |
// | `GET /api/adrs?q=&status=&repo=`             | `DecisionList`: todos os repositórios da conta, sem o texto |
// | `GET /api/adrs/<owner>/<repo>?kind=`         | `RepoDecisions`: um repositório, as pastas e a hora da leitura |
// | `GET /api/adrs/<owner>/<repo>/<id>`          | `DecisionRecordView`: o registro estruturado e o Markdown original |
// | `GET /api/pdrs…`                             | as mesmas três, com `kind: pdr` |
//
// - `q`: busca no título e no texto, sem acento e sem caixa, no núcleo (a busca de código do GitHub
//   tem limite próprio e não indexa todo repositório). `status`: um dos seis normalizados. `repo`:
//   `<owner>/<repo>`, ou só `<owner>` para uma organização (ou a conta). Fora disso, 400.
// - `?kind=` só na rota de um repositório: `adr`, `pdr` ou `all` (a aba ADRs, "Todas"); o padrão é o
//   tipo da família da rota.
// - `?refresh=1` é o Atualizar: relê a descoberta ignorando o TTL, com o mínimo de 30 s do cache.
// - `<owner>` e `<repo>` passam pelo padrão de nome do GitHub antes de qualquer coisa; fora dele, 400.
//
// ## Nunca espera o GitHub
//
// Como a das instruções (api/agent-instructions.ts): a resposta sai do que está em memória; vencida
// (60 s) ou ausente, a montagem roda por trás e o pedido volta na hora com `state: 'loading'`. Quando a
// montagem muda a resposta, o núcleo registra `{ type: 'adrs', key: '<owner>/<repo>' }` (minúsculas)
// e `{ type: 'adrs', key: 'list' }` no cursor de mudanças, e a tela relê. A rota do registro espera a
// montagem que está rodando: o texto veio no lote, abrir um registro não chama o GitHub.
//
// ## Cache (decisão 0001; estudo, "Como a leitura entra no cache")
//
// - `repo-files:<owner>/<repo>`: a descoberta comum (src/github/repo-files-source.ts), a mesma das
//   instruções e da instalação, agora com as 14 pastas de ADR e as 9 de PDR. Os repositórios vencidos
//   vão em lotes de 20, a 1 ponto por lote. TTL de 15 min, e o último push da lista de Repositórios
//   (C22) invalida antes: push depois da leitura, relê. Um valor guardado antes do #174 (sem
//   `decisions`) também é relido;
// - `blob:<oid>`: o texto de cada arquivo, sem TTL (o hash do Git é o conteúdo), em lotes de 50, o
//   mesmo das instruções;
// - `adrs:parsed:<oid>:<EXTRACTOR_VERSION>`: o resultado do extrator, sem TTL. O caminho entra no
//   valor: o mesmo texto noutra pasta é relido (a pasta decide ADR ou PDR).
// Com o GitHub limitando ou fora, serve o que há no cache (até 24 h) com a hora dele (`readAt`), o
// motivo (`error`) e, quando o GitHub disse até quando, `retryAt`. Todas as chamadas passam pela fila
// do GitHub do núcleo, até `GITHUB_CALL_LIMIT` ao mesmo tempo (#341).
//
// ## Segurança
//
// O Markdown do repositório é dado: sai só na rota do registro, para a tela mostrar sem HTML. Nenhum
// token entra na resposta, nem nos erros.

import { githubReposTransport, type GithubAccess } from './github-access.ts';
import type { ServerResponse } from 'node:http';
import { chainOf, chains, linkAll, uniqueIds } from '../adrs/link.ts';
import { DECISION_STATUSES, type ChainNode, type DecisionFormat, type DecisionGroup, type DecisionKind, type DecisionLinkView, type DecisionList, type DecisionRecordView, type DecisionsState, type DecisionStatus, type DecisionSummary, type DecisionTotals, type ParsedDecision, type RepoDecisions, type StatusCounts } from '../adrs/model.ts';
import { EXTRACTOR_VERSION, parseDecision } from '../adrs/parse.ts';
import { GithubCache, MemoryCacheStore, MIN_FORCED_REFRESH_MS, RateLimitedError, type CacheEntry } from '../github/cache.ts';
import { GithubCallQueue } from '../github/call-queue.ts';
import { DISCOVERY_BATCH, RepoFilesSource, type RepoBlob, type RepoFilesDiscovery } from '../github/repo-files-source.ts';
import { GithubReposSource, NOME_DO_DONO, NOME_DO_REPO, SemGithubError } from '../github/repos-source.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { ChangeCursor } from '../changes/cursor.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, FAKE_GITHUB_BASE } from '../simulator/fake-github.ts';

export const ADRS_ROUTE = '/api/adrs';
export const PDRS_ROUTE = '/api/pdrs';

/** A descoberta: a mesma chave e o mesmo TTL das instruções (`repo-files:`). */
export const DECISIONS_DISCOVERY_TTL = 15 * 60_000;
/**
 * Repositórios abertos fora da lista da conta guardados em memória; acima disso sai o lido há mais
 * tempo. Os da lista (até 500, a de C22) nunca saem: a lista geral precisa de todos.
 */
export const MAX_DECISION_REPOS = 200;

/** O `id` de um registro: o nome do arquivo sem `.md`, acento e espaço inclusive; nunca barra nem controle. */
export const RECORD_ID = /^[^/\u0000-\u001f]{1,200}$/u;
/** A chave da mudança da lista inteira. */
export const DECISIONS_LIST_KEY = 'list';

const NO_GITHUB = 'sem GitHub neste núcleo';
const LIMITED = 'GitHub limitou as chamadas';

/** Um repositório da conta, como a lista de Repositórios (C22) o conhece. */
export interface AccountRepo {
  owner: string;
  name: string;
  /** ISO do último push; invalida a descoberta guardada antes dele. */
  lastPush: string | null;
}

/** A lista de repositórios da conta, que a lista de Repositórios já lê (`ReposDoGithub.lista`). */
export interface AccountRepos {
  state: 'ready' | 'loading' | 'no-github' | 'error';
  error: string | null;
  account: string | null;
  repos: AccountRepo[];
}

/** O que a montagem de um repositório guarda em memória. */
interface RepoRead {
  state: DecisionsState;
  error: string | null;
  repo: string;
  commit: string | null;
  readAt: string | null;
  fromCache: boolean;
  folders: string[];
  records: ParsedDecision[];
  /** O Markdown de cada registro, pelo `id`: nunca vai na lista, só na rota do registro e na busca. */
  texts: Map<string, string>;
}

interface Entry<T> {
  value: T | null;
  at: number;
  running: Promise<void> | null;
  force: boolean;
}

interface IndexValue {
  state: DecisionsState;
  error: string | null;
  account: string | null;
  /** As chaves (`owner/repo` em minúsculas) dos repositórios lidos, na ordem da lista da conta. */
  repos: string[];
}

interface StoredBlob {
  text: string;
  bytes: number;
}

interface StoredParse {
  path: string;
  record: ParsedDecision;
}

const newEntry = <T>(): Entry<T> => ({ value: null, at: -Infinity, running: null, force: false });
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A chave da mudança e do cache: `owner/repo` em minúsculas. */
export const decisionsRepoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** Sem acento e sem caixa, para a busca. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const zeroCounts = (): StatusCounts => ({ all: 0, accepted: 0, proposed: 0, superseded: 0, deprecated: 0, rejected: 0, unknown: 0 });

/** O formato mais comum de uma lista de registros. */
function commonFormat(records: ParsedDecision[]): DecisionFormat | null {
  const n = new Map<DecisionFormat, number>();
  for (const r of records) n.set(r.format, (n.get(r.format) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Mais novo primeiro: pelo número; sem número, pela data; por fim, pelo nome do arquivo. */
function byRecency(a: ParsedDecision, b: ParsedDecision): number {
  if (a.number !== null && b.number !== null && a.number !== b.number) return b.number - a.number;
  if (a.date !== b.date) return (b.date ?? '').localeCompare(a.date ?? '');
  return b.id.localeCompare(a.id);
}

function linkViews(r: ParsedDecision, byId: Map<string, ParsedDecision>): DecisionLinkView[] {
  const out: DecisionLinkView[] = [];
  for (const l of r.links) {
    const t = l.target ? byId.get(l.target) : undefined;
    if (!t) continue;
    out.push({ kind: l.kind, target: t.id, via: l.via, number: t.number, title: t.title, targetKind: t.kind, status: t.status });
  }
  return out;
}

function summary(repo: string, r: ParsedDecision, byId: Map<string, ParsedDecision>): DecisionSummary {
  return { repo, id: r.id, path: r.path, number: r.number, title: r.title, kind: r.kind, kindReason: r.kindReason, format: r.format, status: r.status, date: r.date, missing: r.missing, links: linkViews(r, byId) };
}

const emptyTotals = (): DecisionTotals => ({ records: 0, reposWith: 0, reposRead: 0, accepted: 0, proposed: 0, replaced: 0, incomplete: 0 });

export function emptyDecisionList(kind: DecisionKind, state: DecisionsState, error: string | null): DecisionList {
  return { state, error, kind, readAt: null, retryAt: null, account: null, totals: emptyTotals(), counts: zeroCounts(), groups: [], without: [], owners: [], repos: [] };
}

export function emptyRepoDecisions(kind: DecisionKind | 'all', repo: string, state: DecisionsState, error: string | null): RepoDecisions {
  return { state, error, kind, repo, commit: null, readAt: null, retryAt: null, fromCache: false, folders: [], format: null, counts: { adr: 0, pdr: 0, all: 0 }, statusCounts: zeroCounts(), records: [], chains: [] };
}

export interface DecisionFilters {
  q?: string;
  status?: DecisionStatus | null;
  /** `owner/repo` ou só `owner`. */
  repo?: string | null;
}

export interface DecisionsOptions {
  /** `null`: núcleo sem GitHub; as respostas vêm com `state: 'no-github'`. */
  source: RepoFilesSource | null;
  /** A lista de repositórios da conta (a de C22); sem ela, a lista geral fica vazia. */
  accountRepos?: () => Promise<AccountRepos>;
  cache?: GithubCache;
  changes?: ChangeCursor | null;
  now?: () => number;
  /** Validade da resposta montada. Padrão 60 s. */
  validityMs?: number;
  queue?: GithubCallQueue;
  log?: (message: string) => void;
}

/** No 404 de um registro do outro tipo, `kind` diz qual é, para a tela ir para a rota certa. */
export type RecordAnswer = { status: 200; body: DecisionRecordView } | { status: 400 | 404 | 503; body: { error: string; kind?: DecisionKind } };

const KIND_LABEL: Record<DecisionKind, string> = { adr: 'uma ADR', pdr: 'uma PDR' };

export class DecisionsService {
  private readonly source: RepoFilesSource | null;
  private readonly accountRepos: () => Promise<AccountRepos>;
  private readonly cache: GithubCache;
  private readonly changes: ChangeCursor | null;
  private readonly now: () => number;
  private readonly validityMs: number;
  private readonly queue: GithubCallQueue;
  private readonly log: (message: string) => void;
  private readonly index: Entry<IndexValue> = newEntry();
  private readonly repos = new Map<string, Entry<RepoRead>>();
  /** As chaves da lista da conta, da última montagem ou da que está rodando: não saem da memória. */
  private listed = new Set<string>();
  /** O último push de cada repositório da lista, para a aba e o registro também invalidarem por ele. */
  private readonly lastPush = new Map<string, string | null>();
  private noToken: string | null = null;
  /** Chamadas que passaram pelo cache até a fonte (medição e testes). */
  calls = { source: 0 };

  constructor({ source, accountRepos, cache, changes = null, now = Date.now, validityMs = 60_000, queue = new GithubCallQueue(), log = () => {} }: DecisionsOptions) {
    this.source = source;
    this.accountRepos = accountRepos ?? (async () => ({ state: 'ready', error: null, account: null, repos: [] }));
    this.cache = cache ?? new GithubCache({ store: new MemoryCacheStore(), now });
    this.changes = changes;
    this.now = now;
    this.validityMs = validityMs;
    this.queue = queue;
    this.log = log;
  }

  /** A lista de todos os repositórios, do tipo pedido; dispara a montagem por trás se venceu. */
  async list(kind: DecisionKind, filters: DecisionFilters = {}, { refresh = false } = {}): Promise<DecisionList> {
    if (!this.source) return emptyDecisionList(kind, 'no-github', null);
    if (refresh && !this.index.running) {
      this.index.at = -Infinity;
      this.index.force = true;
    }
    this.triggerIndex();
    const idx = this.index.value;
    if (!idx) return emptyDecisionList(kind, 'loading', null);
    if (idx.state !== 'ready') return { ...emptyDecisionList(kind, idx.state, idx.error), account: idx.account };
    return this.compose(kind, idx, filters);
  }

  /** Um repositório, com os dois tipos contados; `kind: 'all'` lista os dois. */
  async repo(kind: DecisionKind | 'all', owner: string, name: string, { refresh = false } = {}): Promise<RepoDecisions> {
    const label = `${owner}/${name}`;
    if (!this.source) return emptyRepoDecisions(kind, label, 'no-github', null);
    const e = this.entry(decisionsRepoKey(owner, name));
    if (refresh && !e.running) {
      e.at = -Infinity;
      e.force = true;
    }
    this.triggerRepo(e, this.ref(owner, name));
    const v = e.value;
    if (!v) return emptyRepoDecisions(kind, label, 'loading', null);
    if (v.state !== 'ready') return { ...emptyRepoDecisions(kind, v.repo, v.state, v.error), readAt: v.readAt };
    const byId = new Map(v.records.map((r) => [r.id, r]));
    const shown = v.records.filter((r) => kind === 'all' || r.kind === kind).sort(byRecency);
    const statusCounts = zeroCounts();
    for (const r of shown) {
      statusCounts.all++;
      statusCounts[r.status]++;
    }
    const inKind = (c: ChainNode[]) => kind === 'all' || c.some((n) => n.kind === kind);
    return {
      state: 'ready',
      error: v.error,
      kind,
      repo: v.repo,
      commit: v.commit,
      readAt: v.readAt,
      retryAt: this.retryAt(),
      fromCache: v.fromCache,
      folders: kind === 'all' ? v.folders : v.folders.filter((f) => shown.some((r) => r.path.startsWith(`${f}/`))),
      format: commonFormat(shown),
      counts: { adr: v.records.filter((r) => r.kind === 'adr').length, pdr: v.records.filter((r) => r.kind === 'pdr').length, all: v.records.length },
      statusCounts,
      records: shown.map((r) => summary(v.repo, r, byId)),
      chains: chains(v.records).filter(inKind),
    };
  }

  /** Um registro, estruturado, com o Markdown original. Espera a montagem que está rodando. */
  async record(kind: DecisionKind, owner: string, name: string, id: string): Promise<RecordAnswer> {
    if (!RECORD_ID.test(id) || id === '.' || id === '..') return { status: 400, body: { error: 'id: o nome do arquivo, sem .md' } };
    if (!this.source) return { status: 503, body: { error: NO_GITHUB } };
    const e = this.entry(decisionsRepoKey(owner, name));
    this.triggerRepo(e, this.ref(owner, name));
    if (!e.value && e.running) await e.running;
    const v = e.value;
    if (!v) return { status: 503, body: { error: 'a leitura do repositório ainda não terminou' } };
    if (v.state === 'not-found') return { status: 404, body: { error: 'repositório não encontrado' } };
    if (v.state !== 'ready') return { status: 503, body: { error: v.error ?? NO_GITHUB } };
    const r = v.records.find((x) => x.id === id);
    if (!r) return { status: 404, body: { error: `registro não encontrado em ${v.repo}` } };
    if (r.kind !== kind) return { status: 404, body: { error: `${id} não é ${KIND_LABEL[kind]}: é ${KIND_LABEL[r.kind]}`, kind: r.kind } };
    const byId = new Map(v.records.map((x) => [x.id, x]));
    return {
      status: 200,
      body: {
        ...summary(v.repo, r, byId),
        state: 'ready',
        error: v.error,
        readAt: v.readAt,
        commit: v.commit,
        language: r.language,
        statusRaw: r.statusRaw,
        dateRaw: r.dateRaw,
        deciders: r.deciders,
        consulted: r.consulted,
        informed: r.informed,
        context: r.context,
        drivers: r.drivers,
        decision: r.decision,
        chosen: r.chosen,
        chosenReason: r.chosenReason,
        options: r.options,
        consequences: r.consequences,
        consequencesGood: r.consequencesGood,
        consequencesBad: r.consequencesBad,
        confirmation: r.confirmation,
        other: r.other,
        statusConflict: r.statusConflict,
        chain: chainOf(v.records, r.id),
        markdown: v.texts.get(r.id) ?? '',
      },
    };
  }

  /** Espera as montagens em andamento (testes e o primeiro desenho). */
  async wait(): Promise<void> {
    for (;;) {
      const running = [this.index.running, ...[...this.repos.values()].map((e) => e.running)].filter(Boolean);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  // ---------- a montagem ----------

  /** O repositório com o último push que a lista da conta conhece (sem lista, `null`: vale o TTL). */
  private ref(owner: string, name: string): AccountRepo {
    return { owner, name, lastPush: this.lastPush.get(decisionsRepoKey(owner, name)) ?? null };
  }

  private retryAt(): string | null {
    return this.cache.pauseLeftMs() > 0 ? new Date(this.cache.pausedUntil).toISOString() : null;
  }

  private entry(key: string): Entry<RepoRead> {
    let e = this.repos.get(key);
    if (e) this.repos.delete(key);
    else e = newEntry<RepoRead>();
    this.repos.set(key, e);
    if (this.repos.size > MAX_DECISION_REPOS + this.listed.size) {
      const old = [...this.repos].find(([k, x]) => !x.running && !this.listed.has(k) && k !== key)?.[0];
      if (old) this.repos.delete(old);
    }
    return e;
  }

  private triggerIndex(): void {
    const e = this.index;
    if (e.running || this.now() - e.at < this.validityMs) return;
    let done = true;
    e.running = this.buildIndex(e.force)
      .then((ok) => {
        done = ok;
      })
      .catch((err: unknown) => {
        const msg = reason(err);
        this.log(`adrs: a montagem da lista falhou: ${msg}`);
        this.publishIndex(e.value && e.value.state === 'ready' ? { ...e.value, error: msg } : { state: 'error', error: msg, account: null, repos: [] });
      })
      .finally(() => {
        // A lista de repositórios ainda carregando: o próximo pedido tenta de novo, sem esperar a validade.
        if (done) e.at = this.now();
        e.force = false;
        e.running = null;
      });
  }

  private triggerRepo(e: Entry<RepoRead>, ref: AccountRepo): void {
    if (e.running || this.now() - e.at < this.validityMs) return;
    e.running = this.readRepos([ref], e.force)
      .catch((err: unknown) => {
        const msg = reason(err);
        this.log(`adrs: a leitura de ${ref.owner}/${ref.name} falhou: ${msg}`);
        this.publishRepo(e, e.value && e.value.state === 'ready' ? { ...e.value, error: msg } : { ...emptyRead(`${ref.owner}/${ref.name}`), state: 'error', error: msg });
      })
      .finally(() => {
        e.at = this.now();
        e.force = false;
        e.running = null;
      });
  }

  /** `false` quando a lista de repositórios da conta ainda não veio. */
  private async buildIndex(force: boolean): Promise<boolean> {
    const list = await this.accountRepos();
    if (!list.repos.length) {
      if (list.state === 'loading') return false;
      if (list.state !== 'ready') {
        this.publishIndex({ state: list.state === 'no-github' ? 'no-github' : 'error', error: list.error, account: list.account, repos: [] });
        return true;
      }
    }
    const refs = list.repos.filter((r) => NOME_DO_DONO.test(r.owner) && NOME_DO_REPO.test(r.name));
    this.listed = new Set(refs.map((r) => decisionsRepoKey(r.owner, r.name)));
    for (const r of refs) this.lastPush.set(decisionsRepoKey(r.owner, r.name), r.lastPush);
    await this.readRepos(refs, force);
    const errors = refs.map((r) => this.repos.get(decisionsRepoKey(r.owner, r.name))?.value?.error).filter(Boolean);
    this.publishIndex({ state: 'ready', error: list.error ?? (errors[0] as string | undefined) ?? null, account: list.account, repos: refs.map((r) => decisionsRepoKey(r.owner, r.name)) });
    return true;
  }

  private publishIndex(value: IndexValue): void {
    const before = this.index.value === null ? null : JSON.stringify(this.index.value);
    this.index.value = value;
    if (before !== JSON.stringify(value)) this.changes?.record({ type: 'adrs', key: DECISIONS_LIST_KEY, sessionId: null, accountId: null });
  }

  private publishRepo(e: Entry<RepoRead>, value: RepoRead): void {
    const shape = (v: RepoRead | null) => (v ? JSON.stringify({ ...v, texts: [...v.texts.keys()] }) : null);
    const changed = shape(e.value) !== shape(value);
    e.value = value;
    if (!changed) return;
    this.changes?.record({ type: 'adrs', key: value.repo.toLowerCase(), sessionId: null, accountId: null });
    // Um repositório que a lista mostra mudou: a lista também.
    if (this.index.value?.repos.includes(value.repo.toLowerCase())) this.changes?.record({ type: 'adrs', key: DECISIONS_LIST_KEY, sessionId: null, accountId: null });
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
        if (err instanceof RateLimitedError) this.cache.pause(err.retryAfterMs);
        throw err;
      }
    });
  }

  /**
   * A descoberta dos repositórios vencidos, em lotes de 20, e a montagem de cada um. Do cache quando a
   * leitura está dentro do TTL e não houve push depois dela; com o GitHub falhando, o que o cache tiver
   * (até 24 h), com o motivo.
   */
  private async readRepos(refs: AccountRepo[], force: boolean): Promise<void> {
    type Found = { d: RepoFilesDiscovery | null; fetchedAt: number; stale: string | null } | { failed: string };
    const found = new Map<string, Found>();
    const misses: AccountRepo[] = [];
    const now = this.now();
    const ttl = force ? Math.min(DECISIONS_DISCOVERY_TTL, MIN_FORCED_REFRESH_MS) : DECISIONS_DISCOVERY_TTL;
    const usable = (hit: CacheEntry<RepoFilesDiscovery | null> | null): hit is CacheEntry<RepoFilesDiscovery | null> => Boolean(hit && (hit.value === null || Array.isArray(hit.value.decisions)));
    for (const r of refs) {
      const key = decisionsRepoKey(r.owner, r.name);
      const hit = (await this.cache.store.get(`repo-files:${key}`)) as CacheEntry<RepoFilesDiscovery | null> | null;
      const pushed = r.lastPush ? Date.parse(r.lastPush) : NaN;
      if (usable(hit) && now - hit.fetchedAt < ttl && !(pushed > hit.fetchedAt)) found.set(key, { d: hit.value, fetchedAt: hit.fetchedAt, stale: null });
      else misses.push(r);
    }
    for (let i = 0; i < misses.length; i += DISCOVERY_BATCH) {
      const batch = misses.slice(i, i + DISCOVERY_BATCH);
      let result: ({ value: RepoFilesDiscovery | null } | { error: string })[] | null = null;
      let failure: string | null = null;
      if (this.cache.pauseLeftMs() > 0) failure = LIMITED;
      else {
        try {
          // Um repositório com erro não leva o lote: a fonte divide e devolve o erro só dele.
          result = await this.call((s) => s.discoverEach(batch));
        } catch (err) {
          failure = err instanceof SemGithubError ? err.message : reason(err);
        }
      }
      for (let j = 0; j < batch.length; j++) {
        const key = decisionsRepoKey(batch[j].owner, batch[j].name);
        const one = result?.[j];
        if (one && 'value' in one) {
          await this.cache.put(`repo-files:${key}`, one.value);
          found.set(key, { d: one.value, fetchedAt: this.now(), stale: null });
          continue;
        }
        const why = one && 'error' in one ? one.error : failure;
        const old = await this.cache.peek<RepoFilesDiscovery | null>(`repo-files:${key}`);
        found.set(key, usable(old) ? { d: old.value, fetchedAt: old.fetchedAt, stale: why } : { failed: why ?? LIMITED });
      }
    }
    for (const r of refs) {
      const key = decisionsRepoKey(r.owner, r.name);
      const f = found.get(key)!;
      const e = this.repos.get(key) ?? this.entry(key);
      const label = `${r.owner}/${r.name}`;
      if ('failed' in f) {
        const previous = e.value && e.value.state === 'ready' ? e.value : null;
        const noToken = this.noToken && f.failed === this.noToken;
        this.publishRepo(e, previous ? { ...previous, error: f.failed, fromCache: true } : { ...emptyRead(label), state: noToken ? 'no-github' : 'error', error: f.failed });
      } else if (!f.d) {
        this.publishRepo(e, { ...emptyRead(label), state: 'not-found', readAt: new Date(f.fetchedAt).toISOString() });
      } else {
        this.publishRepo(e, await this.buildRepo(r, f.d, f.fetchedAt, f.stale));
      }
      // Lido junto com a lista: a rota do repositório não relê antes da validade.
      if (!e.running) e.at = this.now();
    }
  }

  /** Os registros de um repositório: o texto pelo `oid` (cache ou lote de 50) e o extrator pelo cache. */
  private async buildRepo(ref: AccountRepo, d: RepoFilesDiscovery, fetchedAt: number, stale: string | null): Promise<RepoRead> {
    const errors: string[] = stale ? [stale] : [];
    const files = d.decisions ?? [];
    const texts = new Map<string, string>(); // oid → texto
    const missing: string[] = [];
    for (const f of files) {
      if (texts.has(f.oid)) continue;
      const hit = (await this.cache.store.get(`blob:${f.oid}`))?.value as StoredBlob | undefined;
      if (hit && typeof hit.text === 'string') texts.set(f.oid, hit.text);
      else if (!missing.includes(f.oid)) missing.push(f.oid);
    }
    if (missing.length) {
      let blobs: (RepoBlob | null)[] = [];
      if (this.cache.pauseLeftMs() > 0) errors.push(LIMITED);
      else {
        try {
          blobs = await this.call((s) => s.blobs(ref.owner, ref.name, missing.map((oid) => ({ oid }))));
        } catch (err) {
          errors.push(reason(err));
        }
      }
      for (const b of blobs) {
        if (!b) continue;
        texts.set(b.oid, b.text);
        await this.cache.put(`blob:${b.oid}`, { text: b.text, bytes: b.bytes } satisfies StoredBlob);
      }
    }
    const parsed: { record: ParsedDecision; text: string }[] = [];
    for (const f of files) {
      const text = texts.get(f.oid);
      if (text === undefined) continue;
      const key = `adrs:parsed:${f.oid}:${EXTRACTOR_VERSION}`;
      const hit = (await this.cache.store.get(key))?.value as StoredParse | undefined;
      let record: ParsedDecision;
      if (hit && hit.path === f.path && hit.record) record = hit.record;
      else {
        record = parseDecision(text, f.path);
        await this.cache.put(key, { path: f.path, record } satisfies StoredParse);
      }
      parsed.push({ record, text });
    }
    const records = linkAll(uniqueIds(parsed.map((p) => p.record)));
    const byId = new Map<string, string>();
    records.forEach((r, i) => byId.set(r.id, parsed[i].text));
    return {
      state: 'ready',
      error: errors[0] ?? null,
      repo: d.nameWithOwner,
      commit: d.commit,
      readAt: new Date(fetchedAt).toISOString(),
      fromCache: stale !== null,
      folders: d.decisionFolders ?? [],
      records,
      texts: byId,
    };
  }

  // ---------- a lista geral ----------

  private compose(kind: DecisionKind, idx: IndexValue, filters: DecisionFilters): DecisionList {
    const q = fold((filters.q ?? '').trim());
    const repoFilter = (filters.repo ?? '').toLowerCase();
    const reads = idx.repos.map((k) => this.repos.get(k)?.value).filter((v): v is RepoRead => Boolean(v));
    const ready = reads.filter((v) => v.state === 'ready');
    const totals = emptyTotals();
    totals.reposRead = ready.length;
    const counts = zeroCounts();
    const groups: DecisionGroup[] = [];
    const without: string[] = [];
    const reposWith: string[] = [];
    for (const v of ready) {
      const all = v.records.filter((r) => r.kind === kind);
      if (!all.length) {
        without.push(v.repo);
        continue;
      }
      reposWith.push(v.repo);
      totals.reposWith++;
      for (const r of all) {
        totals.records++;
        if (r.status === 'accepted') totals.accepted++;
        if (r.status === 'proposed') totals.proposed++;
        if (r.status === 'superseded' || r.status === 'deprecated') totals.replaced++;
        if (r.missing.length) totals.incomplete++;
      }
      const repo = v.repo.toLowerCase();
      if (repoFilter && repo !== repoFilter && !repo.startsWith(`${repoFilter}/`)) continue;
      const matches = q ? all.filter((r) => fold(r.title).includes(q) || fold(v.texts.get(r.id) ?? '').includes(q)) : all;
      for (const r of matches) {
        counts.all++;
        counts[r.status]++;
      }
      const shown = (filters.status ? matches.filter((r) => r.status === filters.status) : matches).sort(byRecency);
      if (!shown.length) continue;
      const byId = new Map(v.records.map((r) => [r.id, r]));
      groups.push({
        repo: v.repo,
        folders: v.folders.filter((f) => all.some((r) => r.path.startsWith(`${f}/`))),
        format: commonFormat(all),
        total: all.length,
        byTypeField: all.some((r) => r.kindReason === 'type-field'),
        records: shown.map((r) => summary(v.repo, r, byId)),
      });
    }
    const readAts = ready.map((v) => v.readAt).filter((x): x is string => Boolean(x)).sort();
    const error = idx.error ?? reads.map((v) => v.error).find(Boolean) ?? null;
    return {
      state: 'ready',
      error,
      kind,
      readAt: readAts[0] ?? null,
      retryAt: this.retryAt(),
      account: idx.account,
      totals,
      counts,
      groups,
      without,
      owners: [...new Set(ready.map((v) => v.repo.split('/')[0]))],
      repos: reposWith,
    };
  }
}

const emptyRead = (repo: string): RepoRead => ({ state: 'ready', error: null, repo, commit: null, readAt: null, fromCache: false, folders: [], records: [], texts: new Map() });

// ---------- as rotas ----------

/** A rota de `/api/adrs` e de `/api/pdrs`, registrada no servidor (`OpcoesDaApi.decisions`). Responde só a `GET`. */
export type DecisionsRoute = (res: ServerResponse, url: URL) => Promise<void>;

const STATUS_SET = new Set<string>(DECISION_STATUSES);

export function createDecisionsRoute(service: DecisionsService): DecisionsRoute {
  return async (res, url) => {
    const m = /^\/api\/(adrs|pdrs)(?:\/([^/]+)\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: 'não encontrado' });
    const kind: DecisionKind = m[1] === 'pdrs' ? 'pdr' : 'adr';
    const refresh = url.searchParams.get('refresh') === '1';
    if (!m[2]) {
      const status = url.searchParams.get('status');
      if (status && !STATUS_SET.has(status)) return send(res, 400, { error: `status: um de ${DECISION_STATUSES.join(', ')}` });
      const repo = url.searchParams.get('repo');
      if (repo) {
        const [o, r, extra] = repo.split('/');
        if (extra !== undefined || !NOME_DO_DONO.test(o) || (r !== undefined && !NOME_DO_REPO.test(r))) return send(res, 400, { error: 'repo: <dono>/<repo> ou só <dono>, com o nome do GitHub' });
      }
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      return send(res, 200, await service.list(kind, { q, status: (status as DecisionStatus | null) ?? null, repo }, { refresh }));
    }
    let owner: string;
    let repo: string;
    let id: string | null = null;
    try {
      owner = decodeURIComponent(m[2]);
      repo = decodeURIComponent(m[3]);
      if (m[4]) id = decodeURIComponent(m[4]);
    } catch {
      return send(res, 400, { error: 'repositório inválido' });
    }
    if (!NOME_DO_DONO.test(owner) || !NOME_DO_REPO.test(repo)) return send(res, 400, { error: 'repositório inválido: use <dono>/<repo> com o nome do GitHub' });
    if (id !== null) {
      const answer = await service.record(kind, owner, repo, id);
      return send(res, answer.status, answer.body);
    }
    const k = url.searchParams.get('kind');
    if (k && k !== 'adr' && k !== 'pdr' && k !== 'all') return send(res, 400, { error: 'kind: adr, pdr ou all' });
    send(res, 200, await service.repo((k as DecisionKind | 'all' | null) ?? kind, owner, repo, { refresh }));
  };
}

export interface CoreDecisionsOptions {
  /** Demonstração: o GitHub falso (src/simulator/fake-github.ts), nunca a API real. */
  demo: boolean;
  /** `--no-github`: as respostas vêm com `state: 'no-github'`. */
  noGithub: boolean;
  cache: GithubCache;
  changes: ChangeCursor;
  queue: GithubCallQueue;
  /** A lista de repositórios da conta: a mesma da tela Repositórios. */
  accountRepos: () => Promise<AccountRepos>;
  log?: (message: string) => void;
  /** The credential provider and transport (#241). Required outside the demo and `--no-github`; the demo takes only its token. */
  github?: GithubAccess | null;
}

/** Monta o serviço e a rota como o núcleo usa (cli.ts): a credencial do provedor (#241), cache no banco, a fila do núcleo. */
export function createCoreDecisions({ demo, noGithub, cache, changes, queue, accountRepos, log, github }: CoreDecisionsOptions): { service: DecisionsService; route: DecisionsRoute } {
  // A demo aponta para um endereço que não resolve: mesmo que o falso falhasse, nada sai para o GitHub.
  const transport = githubReposTransport({
    demo,
    noGithub,
    github,
    demoFetch: () => createFakeGithub(DEMO_GITHUB_DATA, { delayMs: 120 }).fetch,
    demoBase: FAKE_GITHUB_BASE,
  });
  const service = new DecisionsService({ source: transport ? new RepoFilesSource(transport) : null, accountRepos, cache, changes, queue, ...(log ? { log } : {}) });
  return { service, route: createDecisionsRoute(service) };
}
