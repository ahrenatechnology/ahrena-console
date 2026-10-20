// Kanban do projeto na API (#80, wireframe C11): o quadro de um GitHub Project e o mover de um card.
//
// | Rota                          | O quê                                                          |
// | ----------------------------- | -------------------------------------------------------------- |
// | `GET /api/project`            | O quadro: raias, cards, marcos. `?refresh=1` relê (mínimo de 30 s) |
// | `POST /api/project/move`      | `{ itemId, optionId }`: muda o Status no GitHub e devolve o quadro |
//
// The JSON keys and the error `code` values are English since #173 phase 2b. `/api/projeto`,
// `?forcar=1` and `/api/projeto/mover` are aliases that answer the old body (src/api/legacy-routes.ts).
//
// Os dados saem do `GithubProject` (cache da decisão 0001): com o GitHub fora e algo no cache, o
// GET responde 200 com `stale: true`. A escrita aceita a própria `/ui` (Origin igual a
// `http://<Host>`), só nesta rota (`mesmaOrigemMovendo`); as outras defesas da 0003 continuam.

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
import { legacyRequestBody, normalizeLegacyPath, rawPathnameOf } from './legacy-routes.ts';
import { ciDoPr, reviewDoPr, type PrCi, type PrReview } from './trabalho.ts';

export const PROJECT_ROUTE = '/api/project';
export const PROJECT_MOVE_ROUTE = '/api/project/move';
/** The old routes, still answered as aliases (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DO_PROJETO = '/api/projeto';
export const ROTA_DE_MOVER = '/api/projeto/mover';
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
  /** Sem kanban porque nenhum Project foi escolhido (`AHRENA_CONSOLE_PROJECT` vazia), e não por `--sem-github`. */
  semProjeto?: boolean;
  /** `demo` quando o kanban é o GitHub falso do simulador. */
  fonte: 'github' | 'demo';
  log?: (mensagem: string) => void;
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

/** A própria `/ui` movendo um card: `POST /api/project/move` (ou o alias antigo) com `Origin` exatamente `http://<Host>`, e o Host é o nosso. */
export function mesmaOrigemMovendo(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origem = req.headers.origin;
  if (req.method !== 'POST' || typeof origem !== 'string') return false;
  if (normalizeLegacyPath(new URL(req.url ?? '/', 'http://x').pathname) !== PROJECT_MOVE_ROUTE) return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  return origem === `http://${host}`;
}

export const ehDoProjeto = (caminho: string) => caminho === PROJECT_ROUTE || caminho === PROJECT_MOVE_ROUTE;

type Erro = { status: number; code: ProjectErrorCode; error: string; headers?: Record<string, string>; extra?: Record<string, unknown> };

const segundos = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

/** Erro do GitHub (ou do cache) → status, código e mensagem do contrato. */
function erroDe(err: unknown, kanban: KanbanDoProjeto, falhou: 'github-down' | 'github-refused'): Erro {
  const causa = err instanceof NoDataError ? err.cause : err;
  if (causa instanceof ProjectPermissionError)
    return { status: 401, code: 'no-scope', error: `sem permissão no GitHub Project: ${PROJECT_SCOPE_HINT}`, extra: { command: COMANDO_DO_ESCOPO } };
  const pausa = causa instanceof RateLimitedError ? causa.retryAfterMs : kanban.pauseLeftMs();
  if (causa instanceof RateLimitedError || (err instanceof NoDataError && pausa > 0))
    return { status: 429, code: 'rate-limited', error: 'o GitHub limitou as chamadas; tente de novo em instantes', headers: { 'retry-after': segundos(pausa) } };
  if (err instanceof ProjectOptionUnknownError) return { status: 422, code: 'unknown-lane', error: err.message };
  if (err instanceof ProjectItemUnknownError) return { status: 404, code: 'unknown-item', error: err.message };
  const motivo = causa instanceof Error ? causa.message : String(causa);
  return { status: 502, code: falhou, error: falhou === 'github-down' ? `o GitHub não respondeu e não há quadro no cache: ${motivo}` : `o GitHub recusou: ${motivo}` };
}

function enviarErro(res: ServerResponse, e: Erro): void {
  if (e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
  send(res, e.status, { error: e.error, code: e.code, ...(e.extra ?? {}) });
}

const DESLIGADO: Erro = { status: 503, code: 'off', error: 'o núcleo subiu sem o GitHub (--sem-github): não há quadro' };
const SEM_PROJETO: Erro = {
  status: 503,
  code: 'no-project',
  error: 'nenhum GitHub Project escolhido: suba o núcleo com AHRENA_CONSOLE_PROJECT=dono/número',
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

/**
 * Um navegador sempre manda `Sec-Fetch-Site`; `cross-site` ou `same-site` é outra página pedindo
 * (um `<img>` ou `fetch` no-cors não manda `Origin`). Ler o quadro chama o GitHub e gasta a cota
 * do token: só a própria `/ui` (`same-origin`), quem digita a URL (`none`) ou quem não é navegador.
 */
const deOutroSite = (req: IncomingMessage) => /^(cross-site|same-site)$/i.test(String(req.headers['sec-fetch-site'] ?? ''));

/** As duas rotas do kanban. O servidor já conferiu Host e Origin. */
export function criarRotaDoProjeto({ kanban, fonte, semProjeto = false, log = () => {} }: OpcoesDoProjeto) {
  const parado = semProjeto ? SEM_PROJETO : DESLIGADO;
  async function ler(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (deOutroSite(req)) return send(res, 403, { error: 'origem não permitida' });
    if (!kanban) return enviarErro(res, parado);
    const forcar = url.searchParams.get('refresh') === '1';
    try {
      send(res, 200, quadroDe(await kanban.board({ force: forcar }), fonte));
    } catch (err) {
      enviarErro(res, erroDe(err, kanban, 'github-down'));
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
      corpo = legacyRequestBody(rawPathnameOf(req.url), JSON.parse(texto)) as typeof corpo;
    } catch {
      return send(res, 400, { error: 'JSON inválido', code: 'invalid' });
    }
    const itemId = corpo?.itemId;
    const optionId = corpo?.optionId;
    if (typeof itemId !== 'string' || !ITEM.test(itemId)) return send(res, 400, { error: 'itemId inválido: o id do item no Project (PVTI_…)', code: 'invalid' });
    if (typeof optionId !== 'string' || !OPCAO.test(optionId)) return send(res, 400, { error: 'optionId inválido: o id da raia de destino', code: 'invalid' });
    if (!kanban) return enviarErro(res, parado);
    try {
      const r = await kanban.move(itemId, optionId);
      log(`projeto: ${itemId} de ${r.moved.from ?? 'sem status'} para ${r.moved.to ?? 'sem status'}`);
      send(res, 200, { board: quadroDe(r, fonte), moved: { itemId: r.moved.itemId, from: r.moved.from, to: r.moved.to } });
    } catch (err) {
      enviarErro(res, erroDe(err, kanban, 'github-refused'));
    }
  }

  return async function rotaDoProjeto(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === PROJECT_MOVE_ROUTE) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST', code: 'invalid' });
      return mover(req, res);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET', code: 'invalid' });
    return ler(req, res, url);
  };
}
