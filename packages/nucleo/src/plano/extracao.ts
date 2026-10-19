// Extração do plano a partir dos eventos da sessão, dos hooks e do transcript. Função pura e
// incremental: aplica um evento ao plano gravado e devolve o plano novo, sem reler a sessão.
//
// - TodoWrite e `update_plan` com `items` reescrevem a lista inteira.
// - TaskCreate acrescenta um passo; TaskUpdate muda estado, texto ou dono (ou apaga, `deleted`).
// - `update_plan` com `advance`, `done` e `start` anda na lista que já existe.
// - `wrap_up` (o fechamento do turno no Claude Desktop) marca o que falta da lista do `update_plan`:
//   o app dá a lista por feita, sem um `update_plan` final.
// - `/clear` esvazia o plano.
//
// A mesma chamada chega duas vezes (PreToolUse e PostToolUse, hook e transcript): vale a primeira,
// pelo `tool_use_id`. O resultado com erro desfaz a última chamada aplicada, se for ela.

import type { SessionEvent } from '../model.ts';
import type { PlanOwner, PlanSource, PlanStep, PlanStepStatus, SessionPlan } from './modelo.ts';

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** `update_plan` de qualquer plugin que desenhe o plano (`mcp__<servidor>__update_plan`). */
const UPDATE_PLAN = /(^|__)update_plan$/;
/** O fechamento do turno que acompanha o `update_plan` (`mcp__<servidor>__wrap_up`). */
const WRAP_UP = /(^|__)wrap_up$/;

export function ferramentaDoPlano(nome: string | null): PlanSource | null {
  if (!nome) return null;
  if (nome === 'TodoWrite') return 'TodoWrite';
  if (nome === 'TaskCreate' || nome === 'TaskUpdate') return 'Task';
  if (UPDATE_PLAN.test(nome) || WRAP_UP.test(nome)) return 'update_plan';
  return null;
}

const CLEAR = /<command-name>\/clear<\/command-name>/;

/** O evento mexe no plano? Para quem grava decidir se chama a extração. */
export function eventoDoPlano(e: SessionEvent): boolean {
  return lerEvento(e) !== null;
}

/** O que um evento diz sobre o plano. */
interface Chamada {
  tipo: 'chamada' | 'resultado' | 'limpar';
  ferramenta: string | null;
  toolUseId: string | null;
  entrada: Json | null;
  erro: boolean;
  /** Id da tarefa criada, no resultado do TaskCreate. */
  taskId: string | null;
  /** Agente que chamou, como vem no evento (`null` ou `<sessão>:main` é o principal). */
  agentId: string | null;
  em: string;
}

function lerEvento(e: SessionEvent): Chamada | null {
  const d = obj(e.data);
  const base = { ferramenta: e.toolName, agentId: e.agentId ?? str(d?.agent_id), em: e.createdAt, taskId: null, erro: false };
  const toolUseId = str(d?.tool_use_id) ?? str(d?.toolUseId);
  switch (e.type) {
    case 'SessionStart':
      return d?.source === 'clear' ? { ...base, tipo: 'limpar', toolUseId: null, entrada: null } : null;
    case 'UserPrompt':
    case 'UserPromptSubmit':
      return CLEAR.test(e.summary ?? '') || CLEAR.test(str(d?.prompt) ?? '')
        ? { ...base, tipo: 'limpar', toolUseId: null, entrada: null }
        : null;
  }
  if (!ferramentaDoPlano(e.toolName)) return null;
  switch (e.type) {
    case 'PreToolUse':
    case 'ToolUse':
      // A entrada do `wrap_up` não importa (e o transcript não a guarda): vale a chamada.
      return { ...base, tipo: 'chamada', toolUseId, entrada: obj(d?.tool_input) ?? (WRAP_UP.test(e.toolName ?? '') ? {} : null) };
    case 'PostToolUse': {
      const r = obj(d?.tool_response);
      const erro = r !== null && (r.is_error === true || r.success === false);
      return { ...base, tipo: 'resultado', toolUseId, entrada: obj(d?.tool_input), erro, taskId: taskIdDe(r, null) };
    }
    case 'PostToolUseFailure':
      return { ...base, tipo: 'resultado', toolUseId, entrada: null, erro: true };
    case 'ToolResult':
      return {
        ...base,
        tipo: 'resultado',
        toolUseId,
        entrada: null,
        erro: d?.isError === true,
        taskId: str(d?.taskId) ?? taskIdDe(null, e.summary),
      };
  }
  return null;
}

/** O id da tarefa criada: `{ task: { id } }` na resposta, ou "Task #3 created" no texto. */
function taskIdDe(resposta: Json | null, texto: string | null): string | null {
  const id = obj(resposta?.task)?.id;
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  const m = /Task #(\w+) created/.exec(texto ?? '');
  return m ? m[1] : null;
}

/** Estado interno da extração, guardado em `metadata.extracao`. */
interface Estado {
  /** `tool_use_id` das chamadas já aplicadas (as últimas `MAX_APLICADAS`). */
  aplicadas: string[];
  /** A última chamada aplicada e o plano antes dela, para desfazer se o resultado vier com erro. */
  ultima: { toolUseId: string; antes: PlanStep[]; source: PlanSource } | null;
  /** Tarefa criada com id provisório, à espera do id do resultado. */
  provisorias: Record<string, string>;
  /** Próximo id de tarefa, se o resultado do TaskCreate não chegar. */
  proximaTarefa: number;
}

const MAX_APLICADAS = 500;

function estadoDe(plano: SessionPlan | null): Estado {
  const m = obj(plano?.metadata?.extracao);
  return {
    aplicadas: Array.isArray(m?.aplicadas) ? (m.aplicadas as string[]) : [],
    ultima: (obj(m?.ultima) as Estado['ultima']) ?? null,
    provisorias: (obj(m?.provisorias) as Record<string, string>) ?? {},
    proximaTarefa: typeof m?.proximaTarefa === 'number' ? m.proximaTarefa : 1,
  };
}

const ehPrincipal = (agentId: string | null) => agentId === null || agentId.endsWith(':main');

/** Id do agente no núcleo: o hook manda o `agent_id` cru; o importador, `<sessão>:<agentId>`. */
function agenteDoNucleo(sessionId: string, agentId: string | null): string {
  if (ehPrincipal(agentId)) return `${sessionId}:main`;
  return agentId!.startsWith(`${sessionId}:`) ? agentId! : `${sessionId}:${agentId}`;
}

function donoDe(sessionId: string, agentId: string | null): PlanOwner {
  return ehPrincipal(agentId)
    ? { kind: 'main', agentId: `${sessionId}:main`, name: null }
    : { kind: 'subagent', agentId: agenteDoNucleo(sessionId, agentId), name: null };
}

function statusDe(v: unknown): PlanStepStatus {
  return v === 'completed' || v === 'in_progress' ? v : 'pending';
}

/**
 * Aplica um evento ao plano. Devolve o plano novo, ou `null` quando o evento não muda nada
 * (não é do plano, já foi aplicado, é de um subagente com lista própria).
 */
export function aplicarAoPlano(plano: SessionPlan | null, sessionId: string, e: SessionEvent): SessionPlan | null {
  const c = lerEvento(e);
  if (!c) return null;
  const estado = estadoDe(plano);
  let steps = plano?.steps.map((s) => ({ ...s, owner: { ...s.owner } })) ?? [];
  let source: PlanSource = plano?.source ?? ferramentaDoPlano(c.ferramenta) ?? 'TodoWrite';

  if (c.tipo === 'limpar') {
    if (!plano || plano.steps.length === 0) return null;
    return montar(plano, sessionId, source, [], c.em, { ...estado, ultima: null, provisorias: {}, proximaTarefa: 1 });
  }

  const ja = c.toolUseId !== null && estado.aplicadas.includes(c.toolUseId);
  let mudou = false;

  // A chamada: vale a primeira vez que aparece (PreToolUse, PostToolUse ou o transcript).
  if (!ja && c.entrada && !(c.tipo === 'resultado' && c.erro)) {
    const antes = steps;
    const r = aplicarChamada(steps, sessionId, c, estado, plano?.changedAt ?? null, plano?.source ?? null);
    if (r) {
      steps = r;
      source = ferramentaDoPlano(c.ferramenta)!;
      mudou = true;
      if (c.toolUseId) estado.ultima = { toolUseId: c.toolUseId, antes, source: plano?.source ?? source };
    }
    if (c.toolUseId) estado.aplicadas = [...estado.aplicadas, c.toolUseId].slice(-MAX_APLICADAS);
  }

  if (c.tipo === 'resultado' && c.toolUseId) {
    // Erro na chamada aplicada por último: volta ao plano de antes dela.
    if (c.erro && estado.ultima?.toolUseId === c.toolUseId) {
      steps = estado.ultima.antes;
      source = estado.ultima.source;
      estado.ultima = null;
      delete estado.provisorias[c.toolUseId];
      mudou = true;
    }
    // TaskCreate: troca o id provisório pelo do resultado.
    const provisorio = estado.provisorias[c.toolUseId];
    if (!c.erro && provisorio !== undefined) {
      delete estado.provisorias[c.toolUseId];
      if (c.taskId && c.taskId !== provisorio && !steps.some((s) => s.id === c.taskId)) {
        steps = steps.map((s) => (s.id === provisorio ? { ...s, id: c.taskId! } : s));
        mudou = true;
      }
      const n = Number(c.taskId);
      if (Number.isInteger(n)) estado.proximaTarefa = Math.max(estado.proximaTarefa, n + 1);
    }
  }

  if (!mudou) {
    // Nada mudou no plano, mas o estado da extração mudou (chamada vista): grava se já existe.
    if (!plano || ja) return null;
    return { ...plano, metadata: { ...plano.metadata, extracao: estado } };
  }
  return montar(plano, sessionId, source, steps, c.em, estado);
}

function aplicarChamada(
  steps: PlanStep[],
  sessionId: string,
  c: Chamada,
  estado: Estado,
  mudouEm: string | null,
  fonte: PlanSource | null,
): PlanStep[] | null {
  const entrada = c.entrada!;
  const ferramenta = ferramentaDoPlano(c.ferramenta);
  const principal = ehPrincipal(c.agentId);

  if (WRAP_UP.test(c.ferramenta ?? '')) {
    // Só a lista do `update_plan` é a que o app dá por feita; TodoWrite e tarefas ficam como estão.
    if (!principal || fonte !== 'update_plan' || steps.every((s) => s.status === 'completed')) return null;
    return steps.map((s) => (s.status === 'completed' ? s : { ...s, status: 'completed', updatedAt: c.em }));
  }

  if (ferramenta === 'TodoWrite' || (ferramenta === 'update_plan' && Array.isArray(entrada.items))) {
    // A lista própria de um subagente não é o plano da sessão.
    if (!principal) return null;
    // Lista inteira mais velha que a última mudança (chegou fora de ordem): não volta o plano.
    if (mudouEm !== null && c.em < mudouEm) return null;
    const itens = (ferramenta === 'TodoWrite' ? entrada.todos : entrada.items) as unknown;
    if (!Array.isArray(itens)) return null;
    return reescrever(steps, sessionId, itens, c.em);
  }

  if (ferramenta === 'update_plan') {
    if (!principal) return null;
    return andar(steps, entrada, c.em);
  }

  if (c.ferramenta === 'TaskCreate') {
    const texto = str(entrada.subject) ?? str(entrada.description);
    if (!texto) return null;
    const id = String(estado.proximaTarefa);
    estado.proximaTarefa++;
    if (c.toolUseId) estado.provisorias[c.toolUseId] = id;
    const owner = str(entrada.owner)
      ? { kind: 'subagent' as const, agentId: null, name: str(entrada.owner) }
      : donoDe(sessionId, c.agentId);
    return [...steps.filter((s) => s.id !== id), { id, text: texto, activeText: str(entrada.activeForm), status: 'pending', owner, updatedAt: c.em }];
  }

  if (c.ferramenta === 'TaskUpdate') {
    const id = str(entrada.taskId) ?? (typeof entrada.taskId === 'number' ? String(entrada.taskId) : null);
    const i = id === null ? -1 : steps.findIndex((s) => s.id === id);
    if (i < 0) return null;
    if (entrada.status === 'deleted') return steps.filter((_, j) => j !== i);
    const s = { ...steps[i] };
    if (typeof entrada.status === 'string') s.status = statusDe(entrada.status);
    s.text = str(entrada.subject) ?? s.text;
    s.activeText = str(entrada.activeForm) ?? s.activeText;
    const owner = str(entrada.owner);
    if (owner) s.owner = { kind: 'subagent', agentId: null, name: owner };
    // Subagente que pega o passo vira o dono.
    else if (!principal && entrada.status === 'in_progress') s.owner = donoDe(sessionId, c.agentId);
    if (JSON.stringify(s) === JSON.stringify(steps[i])) return null;
    s.updatedAt = c.em;
    return steps.map((x, j) => (j === i ? s : x));
  }
  return null;
}

/** Lista nova inteira. O passo de mesmo texto mantém o dono e a hora, se não mudou. */
function reescrever(anteriores: PlanStep[], sessionId: string, itens: unknown[], em: string): PlanStep[] {
  const porTexto = new Map(anteriores.map((s) => [s.text, s]));
  const out: PlanStep[] = [];
  for (const item of itens) {
    const o = obj(item);
    const text = str(o?.content) ?? str(o?.subject) ?? str(o?.activeForm);
    if (!o || !text) continue;
    const status = statusDe(o.status);
    const activeText = str(o.activeForm);
    const sessao = str(o.session);
    const antes = porTexto.get(text);
    const owner: PlanOwner = sessao
      ? { kind: 'session', agentId: null, name: sessao }
      : antes && antes.owner.kind !== 'session'
        ? antes.owner
        : donoDe(sessionId, null);
    const igual = antes && antes.status === status && antes.activeText === activeText && JSON.stringify(antes.owner) === JSON.stringify(owner);
    out.push({ id: String(out.length + 1), text, activeText, status, owner, updatedAt: igual ? antes.updatedAt : em });
  }
  return out;
}

/** `update_plan` sem lista: `advance`, `done` (posições a partir de 1) e `start`. */
function andar(anteriores: PlanStep[], entrada: Json, em: string): PlanStep[] | null {
  const steps = anteriores.map((s) => ({ ...s }));
  const marcar = (i: number, status: PlanStepStatus) => {
    const s = steps[i];
    if (s && s.status !== status) {
      s.status = status;
      s.updatedAt = em;
    }
  };
  if (entrada.advance === true) {
    const atual = steps.findIndex((s) => s.status === 'in_progress');
    if (atual >= 0) marcar(atual, 'completed');
    const proximo = steps.findIndex((s, i) => i > atual && s.status === 'pending');
    if (proximo >= 0) marcar(proximo, 'in_progress');
  }
  if (Array.isArray(entrada.done)) for (const n of entrada.done) if (Number.isInteger(n)) marcar((n as number) - 1, 'completed');
  if (Number.isInteger(entrada.start)) marcar((entrada.start as number) - 1, 'in_progress');
  return JSON.stringify(steps) === JSON.stringify(anteriores) ? null : steps;
}

function montar(
  plano: SessionPlan | null,
  sessionId: string,
  source: PlanSource,
  steps: PlanStep[],
  em: string,
  estado: Estado,
): SessionPlan {
  return {
    sessionId,
    source,
    steps,
    done: steps.filter((s) => s.status === 'completed').length,
    total: steps.length,
    currentStepId: steps.find((s) => s.status === 'in_progress')?.id ?? null,
    changedAt: plano && plano.changedAt > em ? plano.changedAt : em,
    metadata: { ...(plano?.metadata ?? {}), extracao: estado },
  };
}
