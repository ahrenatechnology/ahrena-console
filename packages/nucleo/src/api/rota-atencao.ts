// `GET /api/attention`: quem precisa de você, em todas as contas, para a bandeja do app (#87).
//
// A lista é a do `sessions_needing_attention` do MCP (`precisamDeVoce`, src/mcp): as que esperam
// você ou pararam num erro, com a divisão do painel (#140) entre o que trava a sessão ("needs")
// e o que é só a sua vez ("your-turn"). A ordem é a do wireframe A2, urgentes primeiro: permissão,
// pergunta, plano e decisão; depois erro; depois a sua vez. Dentro de cada grupo, quem espera há
// mais tempo. A conta sai só com rótulo e cor, nunca o id. Sem texto da conversa.
//
// Remote machines (#176): the sessions of each remote núcleo that need you come in the same list,
// marked with `machine: { id, label }` and with `local: null` (the Claude Desktop of this Mac does
// not know them, so the tray offers no "Abrir no Claude Desktop"). This machine's sessions have
// `machine: null`. The remote's answer is validated item by item: what does not have the shape is
// left out, and nothing of a remote's own remotes is passed on.
//
// Para acompanhar, o cliente lê esta rota e depois espera em
// `GET /api/changes?since=<cursor>&wait=25`, a partir do `cursor` daqui; com `reset: true`,
// relê tudo.

import { ESTADOS_VIVOS, type LeituraDaFrota, type Motivo } from '../mcp/frota.ts';
import { precisamDeVoce } from '../mcp/ferramentas/atencao.ts';
import type { PrecisaDeVoce } from './tipos.ts';
import { paleta } from '../../../marca/gerado/marca.ts';

export const ATTENTION_ROUTE = '/api/attention';
/** The old route, still answered as an alias (src/api/legacy-routes.ts) until phase 6 of #173. */
export const ROTA_DA_ATENCAO = '/api/atencao';

/** O nível: o que trava a sessão (`needs`) e o que é só a sua vez; os valores do painel. */
export type AttentionLevel = PrecisaDeVoce['level'];
/** O motivo, com os valores do "precisam de você" do painel. */
export type AttentionReason = PrecisaDeVoce['why'];

const MOTIVO: Record<Motivo, AttentionReason> = {
  permission: 'permission',
  question: 'question',
  plan: 'plan',
  decision: 'decision',
  error: 'error',
  turn_ended: 'your-turn',
  interrupted: 'interrupted',
  first_prompt: 'no-prompt',
};

/** O motivo em poucas palavras, como a bandeja mostra ("Pede permissão · 2 min"). */
export const MOTIVO_CURTO: Record<AttentionReason, string> = {
  permission: 'Pede permissão',
  question: 'Fez uma pergunta',
  plan: 'Plano para aprovar',
  decision: 'Pede uma decisão',
  error: 'Com erro',
  'your-turn': 'Sua vez',
  interrupted: 'Interrompida',
  'no-prompt': 'Sessão nova',
};

export interface ItemDaAtencao {
  session: string;
  title: string;
  project: string | null;
  /** Rótulo e cor da conta (decisão 0006); `null` é "Sem conta". */
  account: { label: string; color: string } | null;
  level: AttentionLevel;
  reason: AttentionReason;
  /** A frase curta em pt-BR (`MOTIVO_CURTO`). */
  shortReason: string;
  /** A frase do MCP ("pede permissão para usar Bash"); nunca texto da conversa. */
  longReason: string;
  since: string;
  minutes: number;
  /** O `local_…` do Claude Desktop, quando ele conhece a sessão (`POST /open/<local_…>`). */
  local: string | null;
  /** The remote machine the session runs on (#176); `null` for this machine. */
  machine: { id: string; label: string } | null;
}

/** A remote machine whose sessions enter the list (#176, `RemoteMachine` in src/telemetry/remote.ts). */
export interface RemoteAttentionSource {
  id: string;
  label: string;
  /** The remote núcleo's last `GET /api/attention` answer; `null` while it cannot be read. */
  attention(): unknown;
}

const ATTENTION_LEVELS: readonly AttentionLevel[] = ['needs', 'your-turn'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
/** An account color, as the local ones (src/api/contas.ts): `#rrggbb`. */
const HEX = /^#[0-9a-f]{6}$/i;
/** The neutral account color (the gray of `ACCOUNT_COLORS`), for a remote color that is not hex. */
const NEUTRAL_ACCOUNT_COLOR = paleta.gray['200'];
/** The most a remote may add to `active` or `withError`. */
const MAX_REMOTE_COUNT = 10_000;

/**
 * The remote's items that have this route's shape, marked with the machine; at most 200. The body is
 * the English one: a remote núcleo that still answers in Portuguese is read through
 * `englishAttentionBody` (src/telemetry/remote.ts) before it gets here.
 */
export function remoteAttentionItems(body: unknown, machine: { id: string; label: string }): ItemDaAtencao[] {
  const items = isObject(body) && Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  const out: ItemDaAtencao[] = [];
  for (const i of items) {
    if (!isObject(i) || (i.machine !== null && i.machine !== undefined)) continue;
    const reason = i.reason as AttentionReason;
    const level = i.level as AttentionLevel;
    const session = text(i.session, 128);
    const since = text(i.since, 40);
    if (!session || !since || !Number.isFinite(Date.parse(since)) || typeof i.reason !== 'string' || !Object.hasOwn(MOTIVO_CURTO, reason) || !ATTENTION_LEVELS.includes(level)) continue;
    if (!Number.isFinite(i.minutes) || (i.minutes as number) < 0) continue;
    const account =
      isObject(i.account) && typeof i.account.label === 'string' && typeof i.account.color === 'string'
        ? { label: i.account.label.slice(0, 40), color: HEX.test(i.account.color) ? i.account.color : NEUTRAL_ACCOUNT_COLOR }
        : null;
    out.push({
      session,
      title: text(i.title, 200) ?? '',
      project: text(i.project, 200),
      account,
      level,
      reason,
      shortReason: MOTIVO_CURTO[reason],
      longReason: text(i.longReason, 300) ?? MOTIVO_CURTO[reason],
      since,
      minutes: i.minutes as number,
      local: null,
      machine: { id: machine.id, label: machine.label },
    });
  }
  return out;
}

export interface RespostaDaAtencao {
  generatedAt: string;
  /** Para `GET /api/changes?since=`; `null` quando o núcleo subiu sem o cursor. */
  cursor: string | null;
  /** Todas as da lista: o número da barra de menus. */
  total: number;
  /** As de nível `needs`. */
  needs: number;
  yourTurn: number;
  /** Vivas trabalhando (ativas, delegando, em segundo plano). */
  active: number;
  withError: number;
  items: ItemDaAtencao[];
}

export async function montarAtencao(frota: LeituraDaFrota, cursor: string | null, remotes: readonly RemoteAttentionSource[] = []): Promise<RespostaDaAtencao> {
  const lista = await precisamDeVoce(frota, null);
  const items = lista.map((i): ItemDaAtencao => {
    const reason = MOTIVO[i.reason];
    return {
      session: i.sessionId,
      title: i.title,
      project: i.project,
      account: i.account ? { label: i.account.label, color: i.account.color } : null,
      level: i.group === 'blocking' ? 'needs' : 'your-turn',
      reason,
      shortReason: MOTIVO_CURTO[reason],
      longReason: i.reasonText,
      since: i.waitingSince,
      minutes: i.waitingMinutes,
      local: i.open.desktopSessionId,
      machine: null,
    };
  });
  let active = 0;
  let withError = 0;
  for (const r of remotes) {
    const body = r.attention();
    items.push(...remoteAttentionItems(body, r));
    if (isObject(body)) {
      if (Number.isInteger(body.active) && (body.active as number) >= 0) active += Math.min(body.active as number, MAX_REMOTE_COUNT);
      if (Number.isInteger(body.withError) && (body.withError as number) >= 0) withError += Math.min(body.withError as number, MAX_REMOTE_COUNT);
    }
  }
  // Esperando você (0) antes de parada num erro (1), antes da sua vez (2).
  const grupo = (i: ItemDaAtencao) => (i.level === 'your-turn' ? 2 : i.reason === 'error' ? 1 : 0);
  items.sort((a, b) => grupo(a) - grupo(b) || a.since.localeCompare(b.since) || a.session.localeCompare(b.session) || (a.machine?.id ?? '').localeCompare(b.machine?.id ?? ''));
  for (const s of await frota.vivas()) {
    if (s.inbox.state === 'error') withError++;
    else if (ESTADOS_VIVOS.includes(s.inbox.state) && s.inbox.state !== 'waiting') active++;
  }
  const needs = items.filter((i) => i.level === 'needs').length;
  return {
    generatedAt: new Date(frota.agora()).toISOString(),
    cursor,
    total: items.length,
    needs,
    yourTurn: items.length - needs,
    active,
    withError,
    items,
  };
}
