// Kanban do projeto na API (#80, wireframe C11): o quadro de um GitHub Project e o mover de um card.
//
// | Rota                          | O quê                                                          |
// | ----------------------------- | -------------------------------------------------------------- |
// | `GET /api/project`            | O quadro: raias, cards, marcos. `?refresh=1` relê (mínimo de 30 s) |
// | `POST /api/project/move`      | `{ itemId, optionId }`: muda o Status no GitHub e devolve o quadro |
//
// `/api/projeto`, `?forcar=1` and `/api/projeto/mover` are aliases (src/api/legacy-routes.ts).
//
// Os dados saem do `GithubProject` (cache da decisão 0001): com o GitHub fora e algo no cache, o
// GET responde 200 com `desatualizado: true`. A escrita aceita a própria `/ui` (Origin igual a
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
import { normalizeLegacyPath } from './legacy-routes.ts';
import { ciDoPr, reviewDoPr } from './trabalho.ts';

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
  tipo: ProjectCard['kind'];
  tipoDaIssue: string | null;
  numero: number | null;
  titulo: string;
  url: string | null;
  repo: string | null;
  estado: string;
  marco: string | null;
  subIssues: { feitas: number; total: number } | null;
  pr: { numero: number; url: string; ci: 'ok' | 'falhou' | 'rodando' | null; review: 'aprovado' | 'ajustes' | 'pendente' | null } | null;
  raiaId: string | null;
}

export interface QuadroDoProjeto {
  projeto: { dono: string; numero: number; titulo: string; url: string; campo: string };
  raias: { id: string | null; nome: string; cor: string | null; cards: CardDoProjeto[] }[];
  marcos: string[];
  total: number;
  lidoEm: number;
  desatualizado: boolean;
  motivo: string | null;
  fonte: 'github' | 'demo';
}

function cardDe(c: ProjectCard, raia: BoardLane): CardDoProjeto {
  const p = c.pullRequest ?? null;
  return {
    itemId: c.itemId,
    tipo: c.kind,
    tipoDaIssue: c.type,
    numero: c.number,
    titulo: c.title,
    url: c.url,
    repo: c.repo,
    estado: c.state,
    marco: c.milestone ?? null,
    subIssues: c.subIssues ? { feitas: c.subIssues.completed, total: c.subIssues.total } : null,
    // PR em rascunho ainda não espera review: sem a pílula, como no C11 (In Progress).
    pr: p ? { numero: p.number, url: p.url, ci: ciDoPr(p), review: p.isDraft ? null : reviewDoPr(p) } : null,
    // A raia onde o card aparece: um Status que sumiu do campo cai em "Sem status" (id null).
    raiaId: raia.id,
  };
}

/** O quadro do núcleo no formato da API, em pt-BR. */
export function quadroDe(b: ProjectBoard, fonte: QuadroDoProjeto['fonte']): QuadroDoProjeto {
  const raias = b.lanes.map((l) => ({ id: l.id, nome: l.name, cor: l.color, cards: l.items.map((c) => cardDe(c, l)) }));
  const marcos = [...new Set(raias.flatMap((r) => r.cards.map((c) => c.marco)).filter((m): m is string => m !== null))].sort((a, z) => a.localeCompare(z, 'pt-BR'));
  return {
    projeto: { dono: b.owner, numero: b.number, titulo: b.title, url: b.url, campo: b.field },
    raias,
    marcos,
    total: b.count,
    lidoEm: b.fetchedAt,
    desatualizado: b.stale,
    motivo: b.staleReason,
    fonte,
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

type Erro = { status: number; codigo: string; error: string; headers?: Record<string, string>; extra?: Record<string, unknown> };

const segundos = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

/** Erro do GitHub (ou do cache) → status, código e mensagem do contrato. */
function erroDe(err: unknown, kanban: KanbanDoProjeto, falhou: 'github-fora' | 'github-recusou'): Erro {
  const causa = err instanceof NoDataError ? err.cause : err;
  if (causa instanceof ProjectPermissionError)
    return { status: 401, codigo: 'sem-escopo', error: `sem permissão no GitHub Project: ${PROJECT_SCOPE_HINT}`, extra: { comando: COMANDO_DO_ESCOPO } };
  const pausa = causa instanceof RateLimitedError ? causa.retryAfterMs : kanban.pauseLeftMs();
  if (causa instanceof RateLimitedError || (err instanceof NoDataError && pausa > 0))
    return { status: 429, codigo: 'limitado', error: 'o GitHub limitou as chamadas; tente de novo em instantes', headers: { 'retry-after': segundos(pausa) } };
  if (err instanceof ProjectOptionUnknownError) return { status: 422, codigo: 'raia-desconhecida', error: err.message };
  if (err instanceof ProjectItemUnknownError) return { status: 404, codigo: 'item-desconhecido', error: err.message };
  const motivo = causa instanceof Error ? causa.message : String(causa);
  return { status: 502, codigo: falhou, error: falhou === 'github-fora' ? `o GitHub não respondeu e não há quadro no cache: ${motivo}` : `o GitHub recusou: ${motivo}` };
}

function enviarErro(res: ServerResponse, e: Erro): void {
  if (e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
  send(res, e.status, { error: e.error, codigo: e.codigo, ...(e.extra ?? {}) });
}

const DESLIGADO: Erro = { status: 503, codigo: 'desligado', error: 'o núcleo subiu sem o GitHub (--sem-github): não há quadro' };
const SEM_PROJETO: Erro = {
  status: 503,
  codigo: 'sem-projeto',
  error: 'nenhum GitHub Project escolhido: suba o núcleo com AHRENA_CONSOLE_PROJECT=dono/número',
  extra: { variavel: 'AHRENA_CONSOLE_PROJECT' },
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
      enviarErro(res, erroDe(err, kanban, 'github-fora'));
    }
  }

  async function mover(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json', codigo: 'invalido' });
    const texto = await lerCorpo(req);
    if (texto === null) {
      // O resto do corpo não é lido: responde e fecha a conexão.
      res.setHeader('connection', 'close');
      res.on('finish', () => req.destroy());
      return send(res, 413, { error: 'corpo grande demais', codigo: 'invalido' });
    }
    let corpo: { itemId?: unknown; optionId?: unknown } | null;
    try {
      corpo = JSON.parse(texto) as typeof corpo;
    } catch {
      return send(res, 400, { error: 'JSON inválido', codigo: 'invalido' });
    }
    const itemId = corpo?.itemId;
    const optionId = corpo?.optionId;
    if (typeof itemId !== 'string' || !ITEM.test(itemId)) return send(res, 400, { error: 'itemId inválido: o id do item no Project (PVTI_…)', codigo: 'invalido' });
    if (typeof optionId !== 'string' || !OPCAO.test(optionId)) return send(res, 400, { error: 'optionId inválido: o id da raia de destino', codigo: 'invalido' });
    if (!kanban) return enviarErro(res, parado);
    try {
      const r = await kanban.move(itemId, optionId);
      log(`projeto: ${itemId} de ${r.moved.from ?? 'sem status'} para ${r.moved.to ?? 'sem status'}`);
      send(res, 200, { quadro: quadroDe(r, fonte), movido: { itemId: r.moved.itemId, de: r.moved.from, para: r.moved.to } });
    } catch (err) {
      enviarErro(res, erroDe(err, kanban, 'github-recusou'));
    }
  }

  return async function rotaDoProjeto(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === PROJECT_MOVE_ROUTE) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST', codigo: 'invalido' });
      return mover(req, res);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET', codigo: 'invalido' });
    return ler(req, res, url);
  };
}
