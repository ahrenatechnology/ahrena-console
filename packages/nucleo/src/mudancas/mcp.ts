// `wait_for_changes`: o mesmo long polling da rota HTTP, como ferramenta do servidor MCP (src/mcp),
// para o artefato (`host:ahrena-console`), cujo `watchTool` tem piso de 30 s (validação V2). O app
// espera por volta de 130 s por uma resposta de ferramenta; a espera máxima fica em 110 s.
//
// Como as outras ferramentas: a conta sai como rótulo e cor, nunca o id (que tem os UUIDs da conta e
// da org); o filtro `account` aceita rótulo, id ou "none". Não sai texto de conversa: só tipo, id da
// sessão e id da decisão. A espera ouve `ctx.sinal`, que aborta quando o cliente fecha a conexão.
//
// O tipo `repos` (#104, #105) é só da tela, pela rota HTTP: aqui ele não está no enum e a espera
// sempre filtra pelos tipos do MCP, para que uma montagem de repositórios não acorde quem espera
// sem filtro nem com `account: "none"` (as mudanças `repos` não têm conta).

import type { Contas } from '../api/contas.ts';
import { casaConta } from '../mcp/frota.ts';
import { ErroDaFerramenta, ErroDeArgumento, type Ferramenta, type ObjetoJson } from '../mcp/protocolo.ts';
import { esquema, lista, objeto, ouNulo, T } from '../mcp/saida.ts';
import {
  ErroDeLotacao,
  ESPERA_MAXIMA_MS,
  ESPERA_PADRAO_MS,
  TIPOS_DE_MUDANCA,
  type CursorDeMudancas,
  type FiltrosDeMudanca,
  type MudancaRegistrada,
  type RespostaDaEspera,
  type TipoDeMudanca,
} from './cursor.ts';

export const WAIT_FOR_CHANGES = 'wait_for_changes';

/** Os tipos que o MCP expõe: todos menos `repos`. */
export const TIPOS_DO_MCP = TIPOS_DE_MUDANCA.filter((t): t is Exclude<TipoDeMudanca, 'repos'> => t !== 'repos');
export type TipoDoMcp = (typeof TIPOS_DO_MCP)[number];

/**
 * The Portuguese change types `types` took before #173 phase 2b, still accepted (and mapped to the
 * English ones) until phase 6; the answer always carries the English ones.
 */
export const LEGACY_CHANGE_TYPES: Readonly<Record<string, TipoDoMcp>> = {
  sessao: 'session',
  estado: 'state',
  'precisa-de-voce': 'needs-you',
  plano: 'plan',
  decisao: 'decision',
  conta: 'account',
};

const PERMITIDOS = ['cursor', 'timeout', 'sessions', 'account', 'types'] as const;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface MudancaDeSaida {
  type: TipoDoMcp;
  sessionId: string | null;
  decisionId: string | null;
  account: { label: string; color: string } | null;
}

export interface SaidaDoWaitForChanges {
  cursor: string;
  reset: boolean;
  timedOut: boolean;
  changes: MudancaDeSaida[];
}

const ESQUEMA_DA_MUDANCA = objeto({
  type: { type: 'string', enum: [...TIPOS_DO_MCP] },
  sessionId: ouNulo(T.texto),
  decisionId: ouNulo(T.texto),
  account: ouNulo(objeto({ label: T.texto, color: T.texto })),
});

export interface OpcoesDoWaitForChanges {
  mudancas: CursorDeMudancas;
  /** A mesma `Contas` do painel e das outras ferramentas: o rótulo é o mesmo nas superfícies. */
  contas: Contas;
}

export function waitForChanges({ mudancas, contas }: OpcoesDoWaitForChanges): Ferramenta {
  // A conta pelo id, como o painel a mostra. A fonte não importa aqui: o id já vem decidido.
  const conta = (accountId: string | null) =>
    accountId === null ? null : contas.daSessao({ id: '', accountId, accountSource: 'transcript' }, null);

  return {
    nome: WAIT_FOR_CHANGES,
    titulo: 'Esperar mudanças',
    descricao:
      'Long polling: responde assim que algo muda no Ahrena Console (sessão, estado, precisa de você, plano, decisão, conta, alerta de máquina) ' +
      `ou depois de timeout segundos (padrão ${ESPERA_PADRAO_MS / 1000}, máximo ${ESPERA_MAXIMA_MS / 1000}). ` +
      'Chame sem cursor para receber o atual; depois passe sempre o cursor da última resposta. Com reset=true, releia tudo ' +
      '(sessions_needing_attention, fleet_overview) antes de continuar. O cursor devolvido pula as mudanças que os filtros deixaram de fora. ' +
      'Não devolve texto das conversas.',
    entrada: esquema({
      cursor: { type: 'string', description: 'O cursor da última resposta. Sem ele, volta na hora com o atual e reset=true.' },
      timeout: {
        type: 'number',
        minimum: 0,
        maximum: ESPERA_MAXIMA_MS / 1000,
        default: ESPERA_PADRAO_MS / 1000,
        description: 'Segundos de espera; 0 não espera.',
      },
      sessions: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Só estas sessões (ids).' },
      account: {
        description: 'Só estas contas do Claude: o rótulo ou o id, um ou vários; "none" pede as sessões "Sem conta".',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }],
      },
      types: {
        type: 'array',
        items: { type: 'string', enum: [...TIPOS_DO_MCP, ...Object.keys(LEGACY_CHANGE_TYPES)] },
        description: `Só estes tipos de mudança: ${TIPOS_DO_MCP.join(', ')}. Os nomes antigos (${Object.keys(LEGACY_CHANGE_TYPES).join(', ')}) ainda valem.`,
      },
    }),
    saida: objeto({
      cursor: T.texto,
      reset: T.booleano,
      timedOut: T.booleano,
      changes: lista(ESQUEMA_DA_MUDANCA),
    }),
    async executar(args, ctx) {
      const { cursor, timeoutMs, filtros, contasPedidas } = lerArgumentos(args);
      // Rótulos e cores lidos da porta e de ~/.ahrena-console/contas.json (no máximo a cada 30 s).
      await contas.atualizar();
      if (contasPedidas) filtros.casaConta = (accountId) => casaConta(conta(accountId), contasPedidas);
      let r: RespostaDaEspera;
      try {
        r = await mudancas.aguardar(cursor, { filtros, timeoutMs, signal: ctx.sinal });
      } catch (e) {
        if (e instanceof ErroDeLotacao) throw new ErroDaFerramenta(`${e.message}; tente de novo em alguns segundos`);
        throw e;
      }
      const dados: SaidaDoWaitForChanges = {
        cursor: r.cursor,
        reset: r.reset,
        timedOut: r.timedOut,
        changes: r.changes.flatMap((m) => (m.type === 'repos' ? [] : [saida(m as MudancaRegistrada & { type: TipoDoMcp }, conta(m.accountId))])),
      };
      return { texto: texto(dados), dados: dados as unknown as ObjetoJson };
    },
  };
}

function saida(m: MudancaRegistrada & { type: TipoDoMcp }, c: { label: string; color: string } | null): MudancaDeSaida {
  return {
    type: m.type,
    sessionId: m.sessionId,
    decisionId: m.type === 'decision' ? m.key : null,
    account: c ? { label: c.label, color: c.color } : null,
  };
}

function texto(d: SaidaDoWaitForChanges): string {
  if (d.reset) return `Cursor ${d.cursor}. Releia tudo e chame de novo com este cursor.`;
  if (d.changes.length === 0) return `Nada mudou. Cursor ${d.cursor}.`;
  const porTipo = new Map<string, number>();
  for (const c of d.changes) porTipo.set(c.type, (porTipo.get(c.type) ?? 0) + 1);
  return `${d.changes.length} mudança(s): ${[...porTipo].map(([t, n]) => `${t} ${n}`).join(', ')}. Cursor ${d.cursor}.`;
}

interface Pedido {
  cursor: string | null;
  timeoutMs: number | undefined;
  filtros: FiltrosDeMudanca;
  contasPedidas: string[] | null;
}

function lerArgumentos(args: ObjetoJson): Pedido {
  for (const k of Object.keys(args)) {
    if (!(PERMITIDOS as readonly string[]).includes(k)) throw new ErroDeArgumento(`argumento desconhecido: ${k}. Use ${PERMITIDOS.join(', ')}`);
  }
  const filtros: FiltrosDeMudanca = {};
  const { cursor, timeout, sessions, account, types } = args;
  if (cursor != null && (typeof cursor !== 'string' || cursor.length > 64)) {
    throw new ErroDeArgumento('cursor precisa ser o texto devolvido na última resposta');
  }
  if (timeout != null && (typeof timeout !== 'number' || !(timeout >= 0))) {
    throw new ErroDeArgumento(`timeout precisa ser um número de 0 a ${ESPERA_MAXIMA_MS / 1000}`);
  }
  if (sessions != null) {
    if (!Array.isArray(sessions) || sessions.length > 50 || !sessions.every((s) => typeof s === 'string' && ID.test(s))) {
      throw new ErroDeArgumento('sessions precisa ser uma lista de ids de sessão');
    }
    if (sessions.length) filtros.sessionIds = sessions as string[];
  }
  let contasPedidas: string[] | null = null;
  if (account != null) {
    const l = typeof account === 'string' ? [account] : Array.isArray(account) ? account : null;
    if (!l || l.length === 0 || l.length > 20 || !l.every((x) => typeof x === 'string' && x.trim() && x.length <= 200)) {
      throw new ErroDeArgumento('account precisa ser um texto ou uma lista de textos (rótulo, id ou "none")');
    }
    contasPedidas = (l as string[]).map((x) => x.trim());
  }
  if (types != null) {
    const novos = Array.isArray(types) ? types.map((t) => (typeof t === 'string' && Object.hasOwn(LEGACY_CHANGE_TYPES, t) ? LEGACY_CHANGE_TYPES[t] : t)) : null;
    if (!novos || !novos.every((t) => typeof t === 'string' && (TIPOS_DO_MCP as readonly string[]).includes(t))) {
      throw new ErroDeArgumento(`types: uma lista com ${TIPOS_DO_MCP.join(', ')}`);
    }
    if (novos.length) filtros.tipos = novos as TipoDoMcp[];
  }
  // Sem `types`, todos os do MCP: uma mudança `repos` não passa no filtro e não acorda a espera.
  filtros.tipos ??= TIPOS_DO_MCP;
  return {
    cursor: typeof cursor === 'string' && cursor ? cursor : null,
    timeoutMs: typeof timeout === 'number' ? timeout * 1000 : undefined,
    filtros,
    contasPedidas,
  };
}
