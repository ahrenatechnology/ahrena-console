// The project kanban in the API (#80, wireframe C11): a GitHub Project's board and moving a card.
//
// | Route                         | What                                                           |
// | ----------------------------- | -------------------------------------------------------------- |
// | `GET /api/project`            | The board: lanes, cards, milestones. `?refresh=1` re-reads (at least 30 s apart) |
// | `POST /api/project/move`      | `{ itemId, optionId }`: changes the Status on GitHub and returns the board |
// | `GET /api/project/options`    | The Projects the account sees, the selection and the env override (#241); `?refresh=1` re-reads |
//
// #241: the board's Project comes from the resolver (src/github/project-selection.ts):
// `AHRENA_CONSOLE_PROJECT` > the setting chosen on the screen > the demo's > none. The board answer says
// which (`selection.from`) and whether the env overrides the screen (`envOverride`).
//
// The JSON keys and the error `code` values are English since #173 phase 2b.
//
// The data comes from `GithubProject` (the cache of decision 0001): with GitHub down and something in the
// cache, the GET answers 200 with `stale: true`. The write accepts the /ui itself (Origin equal to
// `http://<Host>`), only on this route (`mesmaOrigemMovendo`); the other defenses of 0003 still apply.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { NoDataError, RateLimitedError } from '../github/cache.ts';
import {
  PROJECT_SCOPE_HINT,
  ProjectItemUnknownError,
  ProjectOptionUnknownError,
  ProjectPermissionError,
  type BoardLane,
  type ProjectBoard,
  type ProjectCard,
  type ProjectMoveResult,
} from '../github/project.ts';
import { send } from '../ingest/hooks/receiver.ts';
import { fromAnotherSite, fromOwnUi } from './same-origin.ts';
import type { ProjectOptions } from '../github/project-options.ts';
import type { ProjectEnvOverride, ResolvedProjectSelection } from '../github/project-selection.ts';
import { ciDoPr, reviewDoPr, type PrCi, type PrReview } from './work.ts';

export const PROJECT_ROUTE = '/api/project';
export const PROJECT_MOVE_ROUTE = '/api/project/move';
export const PROJECT_OPTIONS_ROUTE = '/api/project/options';
/** O comando que dá ao token do `gh` o escopo `project`. */
export const COMANDO_DO_ESCOPO = 'gh auth refresh -s project';

const MAX_CORPO = 4096;
const ITEM = /^PVTI_[A-Za-z0-9_-]{1,96}$/;
const OPCAO = /^[A-Za-z0-9_-]{1,64}$/;

/** O que a API usa do kanban: o `GithubProject` cumpre. */
export interface KanbanDoProjeto {
  readonly project: { owner: string; number: number; field: string };
  board(opts?: { force?: boolean }): Promise<ProjectBoard>;
  move(itemId: string, optionId: string): Promise<ProjectMoveResult>;
  pauseLeftMs(): number;
}

export interface OpcoesDoProjeto {
  /** `null` sem GitHub ou sem Project escolhido: as duas rotas respondem 503 (veja `semProjeto`). */
  kanban: KanbanDoProjeto | null;
  /** Sem kanban porque nenhum Project foi escolhido (`AHRENA_CONSOLE_PROJECT` vazia), e não por `--no-github`. */
  semProjeto?: boolean;
  /** `demo` quando o kanban é o GitHub falso do simulador. */
  fonte: 'github' | 'demo';
  log?: (mensagem: string) => void;
  /** #241: the kanban of the current selection; when given, `kanban` and `semProjeto` are not used. */
  resolver?: ProjectKanbanResolver | null;
  /** #241: the Projects the account sees (`GET /api/project/options`); without it, 503 `off`. */
  options?: Pick<ProjectOptions, 'list'> | null;
  /** #241: where the credential comes from, for the `no-scope` hint. Default `console` (reconnect in Conexões). */
  credentialSource?: () => 'console' | 'gh';
}

/** What the routes use from the Project resolver (src/github/project-selection.ts). */
export interface ProjectKanbanResolver {
  kanban(): KanbanDoProjeto | null;
  selection(): ResolvedProjectSelection | null;
  envOverride(): ProjectEnvOverride | null;
}

export interface CardDoProjeto {
  itemId: string;
  /** The GitHub item kind: `Issue`, `PullRequest` or `DraftIssue`. */
  type: ProjectCard['kind'];
  /** The issue type on GitHub (`Story`, `Tech Task`…), as it comes. */
  issueType: string | null;
  number: number | null;
  title: string;
  url: string | null;
  repo: string | null;
  state: string;
  milestone: string | null;
  subIssues: { done: number; total: number } | null;
  pr: { number: number; url: string; ci: PrCi | null; review: PrReview | null } | null;
  laneId: string | null;
}

export interface QuadroDoProjeto {
  project: { owner: string; number: number; title: string; url: string; field: string };
  lanes: { id: string | null; name: string; color: string | null; cards: CardDoProjeto[] }[];
  milestones: string[];
  total: number;
  fetchedAt: number;
  stale: boolean;
  reason: string | null;
  source: 'github' | 'demo';
  /** #241: where the Project came from. */
  selection?: ResolvedProjectSelection;
  /** #241: `AHRENA_CONSOLE_PROJECT` overrides what the screen chose. */
  envOverride?: ProjectEnvOverride | null;
}

/** The `code` of an error of the two routes (beside the pt-BR `error`). */
export const PROJECT_ERROR_CODES = ['invalid', 'no-scope', 'rate-limited', 'unknown-lane', 'unknown-item', 'github-down', 'github-refused', 'off', 'no-project'] as const;
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

function cardDe(c: ProjectCard, raia: BoardLane): CardDoProjeto {
  const p = c.pullRequest ?? null;
  return {
    itemId: c.itemId,
    type: c.kind,
    issueType: c.type,
    number: c.number,
    title: c.title,
    url: c.url,
    repo: c.repo,
    state: c.state,
    milestone: c.milestone ?? null,
    subIssues: c.subIssues ? { done: c.subIssues.completed, total: c.subIssues.total } : null,
    // PR em rascunho ainda não espera review: sem a pílula, como no C11 (In Progress).
    pr: p ? { number: p.number, url: p.url, ci: ciDoPr(p), review: p.isDraft ? null : reviewDoPr(p) } : null,
    // A raia onde o card aparece: um Status que sumiu do campo cai em "Sem status" (id null).
    laneId: raia.id,
  };
}

/** O quadro do núcleo no formato da API. */
export function quadroDe(b: ProjectBoard, fonte: QuadroDoProjeto['source']): QuadroDoProjeto {
  const lanes = b.lanes.map((l) => ({ id: l.id, name: l.name, color: l.color, cards: l.items.map((c) => cardDe(c, l)) }));
  const milestones = [...new Set(lanes.flatMap((r) => r.cards.map((c) => c.milestone)).filter((m): m is string => m !== null))].sort((a, z) => a.localeCompare(z, 'pt-BR'));
  return {
    project: { owner: b.owner, number: b.number, title: b.title, url: b.url, field: b.field },
    lanes,
    milestones,
    total: b.count,
    fetchedAt: b.fetchedAt,
    stale: b.stale,
    reason: b.staleReason,
    source: fonte,
  };
}

/** A própria `/ui` movendo um card: `POST /api/project/move` com `Origin` exatamente `http://<Host>`, e o Host é o nosso. */
export function mesmaOrigemMovendo(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'POST') return false;
  if (new URL(req.url ?? '/', 'http://x').pathname !== PROJECT_MOVE_ROUTE) return false;
  return fromOwnUi(req, port);
}

export const ehDoProjeto = (caminho: string) => caminho === PROJECT_ROUTE || caminho === PROJECT_MOVE_ROUTE || caminho === PROJECT_OPTIONS_ROUTE;

type Erro = { status: number; code: ProjectErrorCode; error: string; headers?: Record<string, string>; extra?: Record<string, unknown> };

const segundos = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

/** Erro do GitHub (ou do cache) → status, código e mensagem do contrato. */
function erroDe(err: unknown, kanban: KanbanDoProjeto, falhou: 'github-down' | 'github-refused', source: 'console' | 'gh'): Erro {
  const causa = err instanceof NoDataError ? err.cause : err;
  if (causa instanceof ProjectPermissionError) return noScopeError(source);
  const pausa = causa instanceof RateLimitedError ? causa.retryAfterMs : kanban.pauseLeftMs();
  if (causa instanceof RateLimitedError || (err instanceof NoDataError && pausa > 0))
    return { status: 429, code: 'rate-limited', error: 'o GitHub limitou as chamadas; tente de novo em instantes', headers: { 'retry-after': segundos(pausa) } };
  if (err instanceof ProjectOptionUnknownError) return { status: 422, code: 'unknown-lane', error: err.message };
  if (err instanceof ProjectItemUnknownError) return { status: 404, code: 'unknown-item', error: err.message };
  const motivo = causa instanceof Error ? causa.message : String(causa);
  return { status: 502, code: falhou, error: falhou === 'github-down' ? `o GitHub não respondeu e não há quadro no cache: ${motivo}` : `o GitHub recusou: ${motivo}` };
}

/**
 * #241: the credential lacks the `project` scope. The console's own connection asks for it again by
 * reconnecting in Conexões; the `gh` source keeps the `gh auth refresh` command.
 */
function noScopeError(source: 'console' | 'gh'): Erro {
  if (source === 'gh') return { status: 401, code: 'no-scope', error: `sem permissão no GitHub Project: ${PROJECT_SCOPE_HINT}`, extra: { command: COMANDO_DO_ESCOPO, scope: 'project' } };
  return { status: 401, code: 'no-scope', error: 'sem permissão no GitHub Project: falta o escopo project; reconecte o GitHub em Conexões', extra: { scope: 'project' } };
}

function enviarErro(res: ServerResponse, e: Erro): void {
  if (e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
  send(res, e.status, { error: e.error, code: e.code, ...(e.extra ?? {}) });
}

const DESLIGADO: Erro = { status: 503, code: 'off', error: 'o núcleo subiu sem o GitHub (--no-github): não há quadro' };
const SEM_PROJETO: Erro = {
  status: 503,
  code: 'no-project',
  error: 'nenhum GitHub Project escolhido: escolha um Project na tela do Kanban do projeto',
  extra: { variable: 'AHRENA_CONSOLE_PROJECT' },
};

/** O corpo, ou `null` assim que passa do limite: não espera o resto chegar (quem responde fecha a conexão). */
function lerCorpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_CORPO) return resolve(null);
    let corpo = '';
    req.setEncoding('utf8');
    const parte = (p: string) => {
      corpo += p;
      if (Buffer.byteLength(corpo) <= MAX_CORPO) return;
      req.off('data', parte);
      req.pause();
      resolve(null);
    };
    req.on('data', parte);
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

// Reading the board or the Project list calls GitHub and spends the credential's quota: another
// site's page never gets it (`fromAnotherSite`, api/same-origin.ts).

/** As duas rotas do kanban. O servidor já conferiu Host e Origin. */
export function criarRotaDoProjeto({ kanban: fixedKanban, fonte, semProjeto = false, log = () => {}, resolver = null, options = null, credentialSource = () => 'console' }: OpcoesDoProjeto) {
  const currentKanban = () => (resolver ? resolver.kanban() : fixedKanban);
  const stoppedError = () => (resolver || semProjeto ? SEM_PROJETO : DESLIGADO);
  const selectionOf = (kanban: KanbanDoProjeto): { selection: ResolvedProjectSelection; envOverride: ProjectEnvOverride | null } =>
    resolver?.selection()
      ? { selection: resolver.selection()!, envOverride: resolver.envOverride() }
      : { selection: { ...kanban.project, from: fonte === 'demo' ? 'demo' : 'env' }, envOverride: null };
  async function ler(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (fromAnotherSite(req)) return send(res, 403, { error: 'origem não permitida' });
    const kanban = currentKanban();
    if (!kanban) return enviarErro(res, stoppedError());
    const forcar = url.searchParams.get('refresh') === '1';
    try {
      send(res, 200, { ...quadroDe(await kanban.board({ force: forcar }), fonte), ...selectionOf(kanban) });
    } catch (err) {
      enviarErro(res, erroDe(err, kanban, 'github-down', credentialSource()));
    }
  }

  async function listOptions(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (fromAnotherSite(req)) return send(res, 403, { error: 'origem não permitida' });
    if (!options) return enviarErro(res, DESLIGADO);
    try {
      const l = await options.list({ refresh: url.searchParams.get('refresh') === '1' });
      send(res, 200, { projects: l.projects, selection: resolver?.selection() ?? null, envOverride: resolver?.envOverride() ?? null, fetchedAt: l.fetchedAt, stale: l.stale, reason: l.reason });
    } catch (err) {
      const cause = err instanceof NoDataError ? err.cause : err;
      if (cause instanceof RateLimitedError) return enviarErro(res, { status: 429, code: 'rate-limited', error: 'o GitHub limitou as chamadas; tente de novo em instantes', headers: { 'retry-after': segundos(cause.retryAfterMs) } });
      const reason = cause instanceof Error ? cause.message : String(cause);
      enviarErro(res, { status: 502, code: 'github-down', error: `o GitHub não respondeu e não há lista no cache: ${reason}` });
    }
  }

  async function mover(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json', code: 'invalid' });
    const texto = await lerCorpo(req);
    if (texto === null) {
      // O resto do corpo não é lido: responde e fecha a conexão.
      res.setHeader('connection', 'close');
      res.on('finish', () => req.destroy());
      return send(res, 413, { error: 'corpo grande demais', code: 'invalid' });
    }
    let corpo: { itemId?: unknown; optionId?: unknown } | null;
    try {
      corpo = JSON.parse(texto) as typeof corpo;
    } catch {
      return send(res, 400, { error: 'JSON inválido', code: 'invalid' });
    }
    const itemId = corpo?.itemId;
    const optionId = corpo?.optionId;
    if (typeof itemId !== 'string' || !ITEM.test(itemId)) return send(res, 400, { error: 'itemId inválido: o id do item no Project (PVTI_…)', code: 'invalid' });
    if (typeof optionId !== 'string' || !OPCAO.test(optionId)) return send(res, 400, { error: 'optionId inválido: o id da raia de destino', code: 'invalid' });
    const kanban = currentKanban();
    if (!kanban) return enviarErro(res, stoppedError());
    try {
      const r = await kanban.move(itemId, optionId);
      log(`projeto: ${itemId} de ${r.moved.from ?? 'sem status'} para ${r.moved.to ?? 'sem status'}`);
      send(res, 200, { board: { ...quadroDe(r, fonte), ...selectionOf(kanban) }, moved: { itemId: r.moved.itemId, from: r.moved.from, to: r.moved.to } });
    } catch (err) {
      enviarErro(res, erroDe(err, kanban, 'github-refused', credentialSource()));
    }
  }

  return async function rotaDoProjeto(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === PROJECT_MOVE_ROUTE) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST', code: 'invalid' });
      return mover(req, res);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET', code: 'invalid' });
    if (url.pathname === PROJECT_OPTIONS_ROUTE) return listOptions(req, res, url);
    return ler(req, res, url);
  };
}
