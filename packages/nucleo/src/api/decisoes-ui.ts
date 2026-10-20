// As decisões na /ui do núcleo (#103, wireframes C20 e C21):
//
// | Rota                                   | O quê                                                        |
// | -------------------------------------- | ------------------------------------------------------------ |
// | `GET /api/decisions`                   | A página Decisões (C21): todas, agrupadas, com busca (`?state=`, `?groupBy=`, `?group=`, `?q=`) |
// | `GET /api/sessions/<id>/decisions`     | A aba Decisões do Detalhe (C20): o escopo (`?scope=`), a injeção e o MCP |
// | `POST /api/decisions/<id>/promote`     | O "Promover a registro": rascunho, ou grava com `confirm`    |
//
// The JSON keys and fixed values are English since #173 phase 2b (`state` `all|current|to_confirm`,
// `groupBy` `branch|family|session`, the promote body `{ session, confirm, path, hash }`). The old
// `/api/decisoes`, `/api/sessoes/<id>/decisoes`, `/api/decisoes/<id>/promover`, their parameter names
// (`estado`, `agrupar`, `grupo`, `escopo`), values and bodies are aliases: src/api/legacy-routes.ts.
//
// Lê e escreve só pela porta das decisões; o escopo, a conta e a cadeia são de `DecisoesDaSessao` e
// de src/decisoes/registro.ts, não daqui.
//
// A página lista "todas": a porta não tem essa consulta (as dela seguem padrões de acesso, para
// caber no DynamoDB do hub), então a lista sai das sessões da porta de armazenamento, família a
// família. A família traz também a sessão mãe que só a porta das decisões conhece.
//
// Na página não há conta de referência (decisão 0006): o console é local, de uma pessoa, e as
// contas são todas dela; a página mostra todas, como a lista de sessões. O filtro por conta
// continua onde há uma sessão de referência: na aba e nas escritas, que vão em nome da sessão dona.
//
// O Promover não grava nada sem `{ confirm: true, path }`; grava só em `<repo>/docs/decisoes/`,
// nunca por cima (flag `wx`), conferindo com `realpath` que a pasta não sai do repositório.

import { createHash } from 'node:crypto';
import { readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, posix } from 'node:path';
import { send } from '../ingest/hooks/receiver.ts';
import type { Session } from '../model.ts';
import type { Decision, DecisionScope, DecisionState } from '../decisoes/modelo.ts';
import type { DecisionPort, ListDecisionsQuery } from '../decisoes/porta.ts';
import { currentDecisionsFor, decisionLabel, familyOf, markPromoted } from '../decisoes/registro.ts';
import type { Page, StoragePort } from '../storage-port.ts';
import { DecisoesDaSessao, ErroDaDecisao, API_SCOPE, ESCOPOS_DAS_DECISOES, paraOPainel, rotuloPorId, type AlvoDasDecisoes } from './decisoes.ts';
import type { DecisaoDoPainel, EscopoDasDecisoes } from './tipos.ts';
import { legacyRequestBody, rawPathnameOf } from './legacy-routes.ts';

/** The Decisions page of the /ui (C21). */
export const DECISIONS_PAGE_ROUTE = '/api/decisions';

export type AgrupamentoDasDecisoes = 'branch' | 'family' | 'session';
export type FiltroDeEstado = 'all' | 'current' | 'to_confirm';

/** O card de uma decisão, igual na página e na aba: the panel's decision (`DecisaoDoPainel`) and what the /ui adds. */
export interface DecisaoDaUi extends DecisaoDoPainel {
  sessionId: string;
  /** Até onde vale ("escopo: sessão"). */
  scope: EscopoDasDecisoes;
  /** O "D2" da decisão que esta substituiu. */
  supersedes: string | null;
  /** `docs/decisoes/NNNN-slug.md`, quando virou registro. */
  promotedTo: string | null;
  branch: string | null;
  repo: string | null;
  /** O "Ver na conversa": `/ui/sessions/<sessionId>`. */
  conversation: string;
}

export interface GrupoDeDecisoes {
  /** Opaca, segura para URL: o `group=` do "Ver todas". */
  key: string;
  type: AgrupamentoDasDecisoes;
  /** O branch ("sem branch"), ou o título da sessão (família e sessão). */
  title: string;
  repo: string | null;
  /** O nome da pasta do repositório. */
  folder: string | null;
  current: number;
  toConfirm: number;
  total: number;
  /** Até 3, mais recentes primeiro; todos com `group=`. */
  items: DecisaoDaUi[];
  /** Quantos ficaram de fora. */
  more: number;
}

/** `GET /api/decisions` (C21). */
export interface DecisoesDaPagina {
  groupBy: AgrupamentoDasDecisoes;
  state: FiltroDeEstado;
  q: string | null;
  /** Os quatro cartões: sempre sobre tudo, sem o filtro de estado nem a busca. */
  counts: { current: number; branches: number; toConfirm: number; superseded30d: number; promoted: number };
  groups: GrupoDeDecisoes[];
}

/** `GET /api/sessions/<id>/decisions` (C20). */
export interface DecisoesDaAba {
  session: string;
  scope: EscopoDasDecisoes;
  state: FiltroDeEstado;
  q: string | null;
  /** Vigentes e a confirmar em cada escopo. */
  byScope: Record<EscopoDasDecisoes, number>;
  /** Vigentes e a confirmar no escopo pedido: o "(4)" da aba. */
  total: number;
  items: DecisaoDaUi[];
  /** O card "No início de cada sessão" (#100). */
  injection: { enabled: boolean; scope: EscopoDasDecisoes; decisions: number; tokens: number; text: string };
  /** O card "Quando o agente perguntar" (#101); `call` é texto de tela, com o argumento como a ferramenta vai pedir. */
  mcp: { tool: 'session_decisions'; exists: boolean; call: string; response: string };
}

/** A resposta do Promover sem `confirm`: nada foi gravado. */
export interface RascunhoDeRegistro {
  path: string;
  markdown: string;
  /** sha256 (hex) do `markdown`: o confirm que o manda recusa (409) se o registro mudou. */
  hash: string;
  repo: string | null;
  canWrite: boolean;
  /** Por que não dá para gravar, quando não dá. */
  reason: string | null;
}

export interface OpcoesDasDecisoesDaUi {
  decisions: DecisionPort;
  storage: StoragePort;
  /**
   * A sessão a que a aba e as escritas se referem (pasta, branch e conta): a de
   * `MontadorDoPainel.alvoDaSessao`, para a aba e o Confirmar enxergarem as mesmas decisões.
   */
  alvoDe: (sessionId: string) => Promise<AlvoDasDecisoes>;
  agora?: () => number;
  /** Grava o registro; padrão `writeFile` com a flag `wx` (nunca sobrescreve). Os testes injetam. */
  escrever?: (destino: string, markdown: string) => Promise<void>;
  /** A pasta de verdade de um repositório (a --demo troca /simulacao por uma pasta temporária). */
  raiz?: (repo: string) => string | null;
  /** O `local_…` do Claude Desktop da sessão, para o link do registro. */
  localDe?: (sessionId: string) => Promise<string | null> | string | null;
  /** A injeção no início da sessão (#100) existe? Hoje não. */
  injecaoLigada?: boolean;
  /** A ferramenta MCP `session_decisions` (#101) existe? Hoje não. */
  mcpExiste?: boolean;
}

const NA_LISTA: readonly DecisionState[] = ['vigente', 'a_confirmar', 'substituida'];
const DO_FILTRO: Record<FiltroDeEstado, readonly DecisionState[]> = { all: NA_LISTA, current: ['vigente'], to_confirm: ['a_confirmar'] };
const ITENS_POR_GRUPO = 3;
const MAX_BUSCA = 200;
const DIA = 86_400_000;
const PREFIXO: Record<AgrupamentoDasDecisoes, string> = { branch: 'b', family: 'f', session: 's' };
const CAMINHO_DO_REGISTRO = /^docs\/decisoes\/(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** Um registro na pasta, de qualquer slug: o número dele. */
const REGISTRO_NUMERADO = /^(\d{4})-.*\.md$/;
const ESCOPO_POR_EXTENSO: Record<DecisionScope, string> = { sessao: 'sessão', familia: 'família', branch: 'branch' };
const TIPO: Record<Decision['origin'], string> = { sugerida: 'Sugerida', correcao: 'Correção sua', permissao: 'Permissão', pergunta: 'Pergunta', plano: 'Plano' };

const semAcento = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const maisRecentes = (a: Decision, b: Decision) => (a.decidedAt === b.decidedAt ? b.seq - a.seq : a.decidedAt < b.decidedAt ? 1 : -1);
const chave = (tipo: AgrupamentoDasDecisoes, bruta: string) => `${PREFIXO[tipo]}.${Buffer.from(bruta).toString('base64url')}`;

function quem(d: Decision): string {
  if (d.origin === 'sugerida') return 'agente propôs';
  if (d.origin === 'correcao') return 'você corrigiu';
  if (d.origin === 'plano') return 'você aprovou';
  return d.decidedBy === 'agente' ? 'agente' : 'você';
}

async function todasDa(port: DecisionPort, query: ListDecisionsQuery): Promise<Decision[]> {
  const out: Decision[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Decision> = await port.listDecisions({ ...query, limit: 500, cursor });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

function casa(d: Decision, q: string | null): boolean {
  if (!q) return true;
  const texto = typeof d.metadata?.texto === 'string' ? d.metadata.texto : '';
  return semAcento([d.choice, d.context ?? '', ...d.alternatives, texto, d.branch ?? '', decisionLabel(d)].join('\n')).includes(semAcento(q));
}

/** O slug do arquivo: sem acento, minúsculo, com hífens, até 6 palavras e 48 letras. */
export function slugDaDecisao(choice: string): string {
  const palavras = semAcento(choice).split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of palavras) {
    if (out.length === 6 || [...out, p].join('-').length > 48) break;
    out.push(p);
  }
  return out.join('-') || 'decisao';
}

export const PROMOTE_PATH_ERROR = 'informe o path: "docs/decisoes/NNNN-slug.md"';

/** O caminho que o Promover aceita: relativo, dentro de `docs/decisoes/`, `NNNN-slug.md`. */
function caminhoValido(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw new ErroDaDecisao(400, PROMOTE_PATH_ERROR);
  if (v.includes('\\') || v.includes('\0')) throw new ErroDaDecisao(400, 'caminho com barra invertida');
  if (isAbsolute(v) || v.startsWith('/')) throw new ErroDaDecisao(400, 'o caminho é relativo ao repositório');
  if (v.split('/').includes('..') || posix.normalize(v) !== v) throw new ErroDaDecisao(400, 'caminho com ".."');
  if (!CAMINHO_DO_REGISTRO.test(v)) throw new ErroDaDecisao(400, 'o registro fica em docs/decisoes/NNNN-slug.md');
  return v;
}

const HASH = /^[0-9a-f]{64}$/;
const hashDe = (markdown: string) => createHash('sha256').update(markdown, 'utf8').digest('hex');

const gravarSemSobrescrever = (destino: string, markdown: string) => writeFile(destino, markdown, { encoding: 'utf8', flag: 'wx' });

export class DecisoesDaUi {
  private readonly port: DecisionPort;
  private readonly storage: StoragePort;
  private readonly sessao: DecisoesDaSessao;
  private readonly alvoDe: (sessionId: string) => Promise<AlvoDasDecisoes>;
  private readonly agora: () => number;
  private readonly escrever: (destino: string, markdown: string) => Promise<void>;
  private readonly raiz: (repo: string) => string | null;
  private readonly localDe: (sessionId: string) => Promise<string | null> | string | null;
  private readonly injecaoLigada: boolean;
  private readonly mcpExiste: boolean;

  constructor(o: OpcoesDasDecisoesDaUi) {
    this.port = o.decisions;
    this.storage = o.storage;
    this.sessao = new DecisoesDaSessao({ decisions: o.decisions, storage: o.storage });
    this.alvoDe = o.alvoDe;
    this.agora = o.agora ?? Date.now;
    this.escrever = o.escrever ?? gravarSemSobrescrever;
    this.raiz = o.raiz ?? ((repo) => repo);
    this.localDe = o.localDe ?? (() => null);
    this.injecaoLigada = o.injecaoLigada ?? false;
    this.mcpExiste = o.mcpExiste ?? false;
  }

  /**
   * Todas as decisões que a máquina conhece: as das famílias de cada sessão da porta de armazenamento.
   * Limite conhecido: cada GET faz uma consulta de família por sessão e uma lista por família, sem
   * cache. Serve ao console local (uma pessoa, centenas de sessões); com milhares, pede um cache.
   */
  private async todas(): Promise<{ decisoes: Decision[]; sessoes: Map<string, Session> }> {
    const sessoes = new Map<string, Session>();
    let cursor: string | null = null;
    do {
      const page: Page<Session> = await this.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) sessoes.set(s.id, s);
      cursor = page.nextCursor;
    } while (cursor);
    const familias = new Set<string>();
    for (const id of sessoes.keys()) familias.add(await familyOf(this.port, id));
    const decisoes: Decision[] = [];
    for (const familyId of familias) decisoes.push(...(await todasDa(this.port, { familyId })));
    return { decisoes, sessoes };
  }

  /** O "D2" de uma decisão pelo id: das já lidas, ou da porta. */
  private rotuloDe(id: string | null, lidas: Map<string, Decision>): Promise<string | null> {
    return rotuloPorId(this.port, id, lidas);
  }

  private async paraUi(d: Decision, ref: { sessionId: string; familyId: string; mae: string | null }, lidas: Map<string, Decision>): Promise<DecisaoDaUi> {
    return {
      ...paraOPainel(d, ref.sessionId, ref.familyId, ref.mae, await this.rotuloDe(d.supersededBy, lidas)),
      sessionId: d.sessionId,
      scope: API_SCOPE[d.scope],
      supersedes: await this.rotuloDe(d.supersedes, lidas),
      promotedTo: d.promotedTo,
      branch: d.branch,
      repo: d.repo,
      conversation: `/ui/sessions/${encodeURIComponent(d.sessionId)}`,
    };
  }

  /** A página C21. Na página não há sessão de referência: cada card é relativo à própria sessão ('esta'). */
  async pagina(p: { groupBy: AgrupamentoDasDecisoes; state: FiltroDeEstado; q: string | null; group: string | null }): Promise<DecisoesDaPagina> {
    const { decisoes, sessoes } = await this.todas();
    const lidas = new Map(decisoes.map((d) => [d.id, d]));
    const listadas = decisoes.filter((d) => NA_LISTA.includes(d.state)).sort(maisRecentes);
    const vigentes = listadas.filter((d) => d.state === 'vigente');
    const desde = new Date(this.agora() - 30 * DIA).toISOString();
    const counts = {
      current: vigentes.length,
      branches: new Set(vigentes.filter((d) => d.branch).map((d) => `${d.repo ?? ''}\0${d.branch}`)).size,
      toConfirm: listadas.filter((d) => d.state === 'a_confirmar').length,
      superseded30d: listadas.filter((d) => d.state === 'substituida' && d.updatedAt >= desde).length,
      promoted: decisoes.filter((d) => d.promotedTo !== null).length,
    };

    // O título da família: a raiz, se a porta de armazenamento a conhece; senão a sessão gravada mais recente.
    const tituloDaFamilia = new Map<string, string>();
    for (const d of listadas) {
      const raiz = sessoes.get(d.familyId)?.name;
      if (raiz) tituloDaFamilia.set(d.familyId, raiz);
      else if (!tituloDaFamilia.has(d.familyId) && sessoes.get(d.sessionId)?.name) tituloDaFamilia.set(d.familyId, sessoes.get(d.sessionId)!.name!);
    }
    const doGrupo = (d: Decision): { chave: string; titulo: string } => {
      if (p.groupBy === 'branch') return { chave: chave('branch', `${d.repo ?? ''}\0${d.branch ?? ''}`), titulo: d.branch ?? 'sem branch' };
      if (p.groupBy === 'family') return { chave: chave('family', d.familyId), titulo: tituloDaFamilia.get(d.familyId) ?? d.familyId };
      return { chave: chave('session', d.sessionId), titulo: sessoes.get(d.sessionId)?.name ?? d.sessionId };
    };

    const estados = DO_FILTRO[p.state];
    const grupos = new Map<string, { titulo: string; decisoes: Decision[] }>();
    for (const d of listadas) {
      if (!estados.includes(d.state) || !casa(d, p.q)) continue;
      const g = doGrupo(d);
      if (p.group && g.chave !== p.group) continue;
      if (!grupos.has(g.chave)) grupos.set(g.chave, { titulo: g.titulo, decisoes: [] });
      grupos.get(g.chave)!.decisoes.push(d);
    }

    const out: GrupoDeDecisoes[] = [];
    for (const [k, g] of grupos) {
      const mostradas = p.group ? g.decisoes : g.decisoes.slice(0, ITENS_POR_GRUPO);
      const repo = g.decisoes[0]!.repo;
      const itens: DecisaoDaUi[] = [];
      for (const d of mostradas) itens.push(await this.paraUi(d, { sessionId: d.sessionId, familyId: d.familyId, mae: null }, lidas));
      out.push({
        key: k,
        type: p.groupBy,
        title: g.titulo,
        repo,
        folder: repo ? basename(repo) : null,
        current: g.decisoes.filter((d) => d.state === 'vigente').length,
        toConfirm: g.decisoes.filter((d) => d.state === 'a_confirmar').length,
        total: g.decisoes.length,
        items: itens,
        more: g.decisoes.length - mostradas.length,
      });
    }
    return { groupBy: p.groupBy, state: p.state, q: p.q, counts, groups: out };
  }

  /**
   * A sessão a que a aba e as escritas se referem, pela regra do painel (`alvoDe`). Uma sessão que só
   * a porta das decisões conhece (a mãe de antes do /clear) também vale; `null` quando nenhuma das
   * duas portas conhece a sessão.
   */
  private async alvo(sessionId: string): Promise<AlvoDasDecisoes | null> {
    const conhecida =
      (await this.storage.getSession(sessionId)) !== null || (await this.port.listDecisions({ sessionId, limit: 1 })).items.length > 0;
    return conhecida ? this.alvoDe(sessionId) : null;
  }

  /** A aba C20; `null` quando a sessão não existe. */
  async aba(sessionId: string, p: { scope: EscopoDasDecisoes; state: FiltroDeEstado; q: string | null }): Promise<DecisoesDaAba | null> {
    const alvo = await this.alvo(sessionId);
    if (!alvo) return null;
    const doEscopo = await this.sessao.doEscopo(alvo, p.scope);
    const lidas = new Map(doEscopo.map((d) => [d.id, d]));
    const porEscopo = await this.sessao.porEscopo(alvo, p.scope, doEscopo);

    const ref = { sessionId: alvo.sessionId, familyId: await familyOf(this.port, alvo.sessionId), mae: (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null };
    const itens: DecisaoDaUi[] = [];
    for (const d of doEscopo) if (DO_FILTRO[p.state].includes(d.state) && casa(d, p.q)) itens.push(await this.paraUi(d, ref, lidas));

    // O que a injeção (#100) e a ferramenta MCP (#101) consultariam: as vigentes do branch.
    const nivel: DecisionScope = alvo.branch ? 'branch' : 'familia';
    const vigentes = (await currentDecisionsFor(this.port, alvo, nivel)).reverse();
    const linhas: string[] = [];
    const cadeias: string[] = [];
    for (const d of vigentes) {
      const antes = await this.rotuloDe(d.supersedes, lidas);
      if (antes) cadeias.push(`${decisionLabel(d)} substituiu ${antes}`);
      linhas.push(`- ${d.choice} (${decisionLabel(d)}${antes ? `, substituiu ${antes}` : ''})`);
    }
    const cabeca = alvo.branch ? `Decisões vigentes em ${alvo.branch}:` : 'Decisões vigentes na família desta sessão:';
    const texto = linhas.length ? [cabeca, ...linhas].join('\n') : '';
    const n = vigentes.length;
    const resposta =
      n === 0
        ? 'Responde que não há decisões vigentes.'
        : `Responde com ${n === 1 ? 'a vigente' : `as ${n} vigentes`}${cadeias.length ? ` e a cadeia de substituição: ${cadeias.join(', ')}.` : '.'}`;
    return {
      session: sessionId,
      scope: p.scope,
      state: p.state,
      q: p.q,
      byScope: porEscopo,
      total: porEscopo[p.scope],
      items: itens,
      injection: { enabled: this.injecaoLigada, scope: API_SCOPE[nivel], decisions: n, tokens: Math.ceil(texto.length / 4), text: texto },
      mcp: {
        tool: 'session_decisions',
        exists: this.mcpExiste,
        call: alvo.branch ? `session_decisions branch: ${JSON.stringify(alvo.branch)}` : `session_decisions sessao: ${JSON.stringify(sessionId)}`,
        response: resposta,
      },
    };
  }

  /**
   * `<repo>/docs/decisoes` de verdade, conferida: o repo é absoluto, a pasta existe, é pasta e não é
   * symlink (nem para dentro do repositório): o `realpath` dela é `<realpath do repo>/docs/decisoes`.
   */
  private async pastaDosRegistros(d: Decision): Promise<string> {
    if (d.repo && !isAbsolute(d.repo)) throw new ErroDaDecisao(409, `a pasta do repositório não é absoluta: ${d.repo}`);
    const repo = d.repo ? this.raiz(d.repo) : null;
    if (!repo) throw new ErroDaDecisao(409, 'a decisão não tem a pasta do repositório');
    let raiz: string;
    try {
      raiz = await realpath(repo);
    } catch {
      throw new ErroDaDecisao(409, `a pasta ${d.repo} não existe nesta máquina`);
    }
    const esperada = join(raiz, 'docs', 'decisoes');
    let pasta: string;
    try {
      pasta = await realpath(esperada);
    } catch {
      throw new ErroDaDecisao(409, `${d.repo} não tem docs/decisoes`);
    }
    if (pasta !== esperada) throw new ErroDaDecisao(400, 'docs/decisoes é um symlink: grave numa pasta de verdade do repositório');
    if (!(await stat(pasta)).isDirectory()) throw new ErroDaDecisao(409, `${d.repo}/docs/decisoes não é uma pasta`);
    return pasta;
  }

  private async proximoNumero(pasta: string): Promise<string> {
    let maior = 0;
    for (const nome of await readdir(pasta)) {
      const m = REGISTRO_NUMERADO.exec(nome);
      if (m) maior = Math.max(maior, Number(m[1]));
    }
    return String(maior + 1).padStart(4, '0');
  }

  /** O registro no formato de docs/decisoes/*.md; o que a captura não sabe fica dito, não inventado. */
  private async markdown(d: Decision, numero: string): Promise<string> {
    const lidas = new Map<string, Decision>();
    const anterior = d.supersedes ? await this.port.getDecision(d.supersedes) : null;
    const local = await this.localDe(d.sessionId);
    const escopo = ESCOPO_POR_EXTENSO[d.scope];
    const status = d.state === 'a_confirmar' ? 'proposta' : d.state === 'substituida' ? 'substituída' : 'aceita';
    const umaLinha = (s: string) => s.replace(/\s*\n\s*/g, ' ');
    const conversa = `\`/ui/sessions/${d.sessionId}\` no console${local ? ` · [abrir no Claude Desktop](claude://claude.ai/epitaxy/${local})` : ''}`;
    const vale =
      d.scope === 'sessao'
        ? 'só a sessão que decidiu a segue'
        : d.scope === 'familia'
          ? 'segue a sessão pelo /clear, pela compactação e nas sessões filhas'
          : `vale para as sessões do branch \`${d.branch ?? 'sem branch'}\` nesta pasta`;
    const linhas = [
      `# ${numero} · ${umaLinha(d.choice)}`,
      '',
      `- **Status:** ${status}`,
      `- **Data:** ${new Date(this.agora()).toISOString().slice(0, 10)}`,
      `- **Origem:** ${decisionLabel(d)} da sessão \`${d.sessionId}\` (${TIPO[d.origin]}, ${quem(d)}), escopo ${escopo}${d.branch ? `, branch \`${d.branch}\`` : ''}`,
      ...(anterior ? [`- **Substitui:** ${await this.rotuloDe(anterior.id, lidas)} · ${umaLinha(anterior.choice)}`] : []),
      `- **Conversa:** ${conversa}`,
      '',
      '## Contexto',
      '',
      d.context ?? 'A captura não registrou a pergunta ou o pedido que levou a esta decisão.',
      '',
      '## Decisão',
      '',
      typeof d.metadata?.texto === 'string' ? d.metadata.texto : d.choice,
      '',
      '## Alternativas consideradas',
      '',
      ...(d.alternatives.length ? d.alternatives.map((a) => `- ${umaLinha(a)}`) : ['- Nenhuma registrada na conversa.']),
      '',
      '## Consequências',
      '',
      `- No console, a decisão tem escopo ${escopo}: ${vale}. Aqui, ela passa a valer pelo repositório, sem depender do banco local.`,
      '- O que fica mais fácil e o que fica mais difícil: a completar por quem promoveu, antes do merge.',
      '',
    ];
    return linhas.join('\n');
  }

  private async rascunho(d: Decision): Promise<RascunhoDeRegistro> {
    let pasta: string | null = null;
    let motivo: string | null = d.promotedTo ? `já promovida para ${d.promotedTo}` : null;
    try {
      pasta = await this.pastaDosRegistros(d);
    } catch (err) {
      if (!(err instanceof ErroDaDecisao)) throw err;
      motivo ??= err.message;
    }
    const numero = pasta ? await this.proximoNumero(pasta) : '0001';
    const markdown = await this.markdown(d, numero);
    return {
      path: `docs/decisoes/${numero}-${slugDaDecisao(d.choice)}.md`,
      markdown,
      hash: hashDe(markdown),
      repo: d.repo,
      canWrite: motivo === null,
      reason: motivo,
    };
  }

  /**
   * O Promover, em nome da sessão `sessao` (que precisa enxergar a decisão, no escopo branch):
   * sem `confirm: true`, só o rascunho (200); com ele e o `path`, grava e marca (201). O markdown
   * é regerado no confirm; com o `hash` do rascunho, um registro que mudou desde então dá 409.
   */
  async promover(id: string, sessao: string, corpo: { confirm?: unknown; path?: unknown; hash?: unknown }): Promise<{ status: 200; corpo: { draft: RascunhoDeRegistro } } | { status: 201; corpo: { decision: DecisaoDaUi; path: string } }> {
    const alvo = await this.alvo(sessao);
    const d = await this.port.getDecision(id);
    const visivel = alvo && d && (await this.sessao.doEscopo(alvo, 'branch', [d.state])).some((x) => x.id === id);
    if (!alvo || !d || !visivel) throw new ErroDaDecisao(404, 'decisão não encontrada nesta sessão');
    // Só o que a página mostra vira registro: uma descartada ou revertida não é "aceita".
    if (!NA_LISTA.includes(d.state)) throw new ErroDaDecisao(409, `a decisão está ${d.state}: só vigente, a confirmar ou substituída vira registro`);
    if (corpo.confirm !== true) return { status: 200, corpo: { draft: await this.rascunho(d) } };

    const caminho = caminhoValido(corpo.path);
    if (corpo.hash !== undefined && (typeof corpo.hash !== 'string' || !HASH.test(corpo.hash))) throw new ErroDaDecisao(400, 'hash: o sha256 (hex) do markdown do rascunho');
    if (d.promotedTo) throw new ErroDaDecisao(409, `já promovida para ${d.promotedTo}`);
    const pasta = await this.pastaDosRegistros(d);
    const numero = CAMINHO_DO_REGISTRO.exec(caminho)![1]!;
    const mesmoNumero = (await readdir(pasta)).find((nome) => REGISTRO_NUMERADO.exec(nome)?.[1] === numero);
    if (mesmoNumero) throw new ErroDaDecisao(409, `o número ${numero} já existe: docs/decisoes/${mesmoNumero}`);
    const markdown = await this.markdown(d, numero);
    if (corpo.hash !== undefined && corpo.hash !== hashDe(markdown)) throw new ErroDaDecisao(409, 'o rascunho mudou, abra de novo');
    const destino = join(pasta, basename(caminho));
    try {
      await this.escrever(destino, markdown);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ErroDaDecisao(409, `${caminho} já existe`);
      throw err;
    }
    let feita: Decision;
    try {
      feita = await markPromoted(this.port, id, caminho, new Date(this.agora()).toISOString());
    } catch (err) {
      // Sem a marca, o arquivo seria um registro órfão: apaga o que acabou de gravar.
      await unlink(destino).catch(() => {});
      throw err;
    }
    const ref = { sessionId: alvo.sessionId, familyId: await familyOf(this.port, alvo.sessionId), mae: (await this.port.getSessionLink(alvo.sessionId))?.parentSessionId ?? null };
    return { status: 201, corpo: { decision: await this.paraUi(feita, ref, new Map()), path: caminho } };
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CHAVE_DO_GRUPO = /^[bfs]\.[A-Za-z0-9_-]{1,700}$/;
const MAX_CORPO = 4096;
export const DECISION_GROUPINGS: readonly AgrupamentoDasDecisoes[] = ['branch', 'family', 'session'];
export const DECISION_STATE_FILTERS: readonly FiltroDeEstado[] = ['all', 'current', 'to_confirm'];
/** The 400s that name a parameter or a body key, with the new names (the old routes map them back). */
export const STATE_FILTER_ERROR = `state: ${DECISION_STATE_FILTERS.slice(0, -1).join(', ')} ou ${DECISION_STATE_FILTERS.at(-1)}`;
export const GROUPING_ERROR = `groupBy: ${DECISION_GROUPINGS.slice(0, -1).join(', ')} ou ${DECISION_GROUPINGS.at(-1)}`;
export const PROMOTE_SESSION_ERROR = 'informe a sessão: { "session": "<id>" }';

function decodificado(parte: string): string | null {
  try {
    return decodeURIComponent(parte);
  } catch {
    return null;
  }
}

function lerCorpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let corpo = '';
    let grande = false;
    req.setEncoding('utf8');
    req.on('data', (parte: string) => {
      if (grande) return;
      corpo += parte;
      if (corpo.length > MAX_CORPO) grande = true;
    });
    req.on('end', () => resolve(grande ? null : corpo));
    req.on('error', reject);
  });
}

/** O `state` e o `q` da busca; quando algum não vale, a mensagem de erro (uma string) no lugar deles. */
function filtrosDe(url: URL): { state: FiltroDeEstado; q: string | null } | string {
  const state = (url.searchParams.get('state') ?? 'all') as FiltroDeEstado;
  if (!DECISION_STATE_FILTERS.includes(state)) return STATE_FILTER_ERROR;
  const q = url.searchParams.get('q')?.trim() || null;
  if (q && q.length > MAX_BUSCA) return `busca de até ${MAX_BUSCA} caracteres`;
  return { state, q };
}

/**
 * As rotas da /ui das decisões. Devolve `true` quando a rota é daqui (e já respondeu). A origem
 * já foi conferida pelo servidor (decisão 0003); a escrita pede ainda JSON e a sessão no corpo.
 */
export async function responderDecisoesDaUi(req: IncomingMessage, res: ServerResponse, url: URL, ui: DecisoesDaUi, log: (m: string) => void = () => {}): Promise<boolean> {
  if (url.pathname === DECISIONS_PAGE_ROUTE) {
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' }), true;
    const f = filtrosDe(url);
    if (typeof f === 'string') return send(res, 400, { error: f }), true;
    const groupBy = (url.searchParams.get('groupBy') ?? 'branch') as AgrupamentoDasDecisoes;
    if (!DECISION_GROUPINGS.includes(groupBy)) return send(res, 400, { error: GROUPING_ERROR }), true;
    const group = url.searchParams.get('group');
    if (group !== null && !CHAVE_DO_GRUPO.test(group)) return send(res, 400, { error: 'group inválido' }), true;
    send(res, 200, await ui.pagina({ groupBy, ...f, group }));
    return true;
  }

  const aba = /^\/api\/sessions\/([^/]+)\/decisions$/.exec(url.pathname);
  if (aba) {
    if (req.method !== 'GET') return send(res, 405, { error: 'use GET' }), true;
    const sessao = decodificado(aba[1]!);
    if (!sessao || !ID.test(sessao)) return send(res, 400, { error: 'id de sessão inválido' }), true;
    const scope = (url.searchParams.get('scope') ?? 'family') as EscopoDasDecisoes;
    if (!ESCOPOS_DAS_DECISOES.includes(scope)) return send(res, 400, { error: 'scope: session, family ou branch' }), true;
    const f = filtrosDe(url);
    if (typeof f === 'string') return send(res, 400, { error: f }), true;
    const corpo = await ui.aba(sessao, { scope, ...f });
    if (!corpo) send(res, 404, { error: 'sessão não encontrada' });
    else send(res, 200, corpo);
    return true;
  }

  const promover = /^\/api\/decisions\/([^/]+)\/promote$/.exec(url.pathname);
  if (promover) {
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' }), true;
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' }), true;
    const id = decodificado(promover[1]!);
    if (!id || !ID.test(id)) return send(res, 400, { error: 'id de decisão inválido' }), true;
    const texto = await lerCorpo(req);
    if (texto === null) return send(res, 413, { error: 'corpo grande demais' }), true;
    // The body is `{ session, confirm, path, hash }`; the old `{ sessao, confirmar, caminho }` is read
    // too, on the new path as well (the old path translates it through `legacyRequestBody`).
    let corpo: { session?: unknown; confirm?: unknown; path?: unknown; hash?: unknown; sessao?: unknown; confirmar?: unknown; caminho?: unknown } | null;
    try {
      corpo = legacyRequestBody(rawPathnameOf(req.url), JSON.parse(texto)) as typeof corpo;
    } catch {
      return send(res, 400, { error: 'JSON inválido' }), true;
    }
    const sessao = corpo?.session ?? corpo?.sessao;
    if (typeof sessao !== 'string' || !ID.test(sessao)) return send(res, 400, { error: PROMOTE_SESSION_ERROR }), true;
    try {
      const r = await ui.promover(id, sessao, { confirm: corpo?.confirm ?? corpo?.confirmar, path: corpo?.path ?? corpo?.caminho, hash: corpo?.hash });
      if (r.status === 201) log(`decisão ${id} promovida para ${r.corpo.path} pela sessão ${sessao}`);
      send(res, r.status, r.corpo);
    } catch (err) {
      if (err instanceof ErroDaDecisao) return send(res, err.status, { error: err.message }), true;
      throw err;
    }
    return true;
  }
  return false;
}
