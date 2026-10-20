// Synthetic sessions for the Workflows screens (#96, C14) and the detail's Workflow tab (#97, C7), in
// the demo `npm run api -- --demo --scenario p4`. All made up, with the simulator's vocabulary
// (projects under /simulacao, all-zero UUID accounts). The representation follows api/workflows.ts:
// the loop comes from the subagents' types and order and from each review's last message ("3 ajustes
// pedidos"); the Workflow tool runs, from the main agent's `Workflow` call and `Agent.metadata.workflow`.
//
// Wireframe C7's loop is `sim-wf-payments` (active); `sim-wf-csv` has three rounds and a
// test-runner with an error; `sim-wf-category` approves on the first. The runs: dev-review (active,
// in `sim-wf-payments`), triagem-de-bugs (yesterday) and comparar-bibliotecas (2 days ago), completed.

import type { Agent, AgentStatus, Session, SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { PANEL_ACCOUNTS } from './panel.ts';
import { ROOT } from './vocabulary.ts';

const MIN = 60_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Sub {
  id: string;
  type: string;
  task: string;
  /** Minutes since the session's start; `end` null: still running. */
  start: number;
  end: number | null;
  status?: AgentStatus;
  parent?: string;
  /** Phase and label in the Workflow tool run; `role` replaces the role read from the type. */
  wf?: { phase: string; label?: string; role?: string };
  /** The subagent's last message: "3 ajustes pedidos", "Aprovado". */
  result?: string;
  tokens?: number;
  tools?: number;
}

interface Demo {
  id: string;
  title: string;
  project: string;
  model: string;
  account: keyof typeof PANEL_ACCOUNTS;
  status: SessionStatus;
  source: 'startup' | 'resume';
  /** How many minutes ago it started, and how long it lasted (`null`: still running). */
  minAgo: number;
  durationMin: number | null;
  compacted?: boolean;
  branch?: string;
  subs: Sub[];
  run?: { id: string; name: string; phases: string[]; loopBack?: string; startMin: number; endMin: number | null };
}

const DEMOS: Demo[] = [
  {
    id: 'sim-wf-payments', title: 'Separar pagamentos em serviços', project: 'motor-de-regras', model: OPUS, account: 'team', status: 'active', source: 'startup',
    minAgo: 28, durationMin: null, branch: 'feat/63-separar-pagamentos',
    run: { id: 'toolu_sim_wf_devreview', name: 'dev-review', phases: ['Implementar', 'Revisar', 'Corrigir', 'Testar'], loopBack: 'volta para Corrigir enquanto o review pedir ajustes', startMin: 0.5, endMin: null },
    subs: [
      { id: 'ex1', type: 'Explore', task: 'mapear o módulo', start: 0, end: 2, tokens: 9_000, tools: 5 },
      { id: 'pl', type: 'Plan', task: 'plano', start: 1, end: 4, tokens: 14_000, tools: 3 },
      { id: 'd1', type: 'general-purpose', task: 'implementa', start: 4, end: 12, wf: { phase: 'Implementar' }, tokens: 88_000, tools: 14 },
      { id: 'r1', type: 'code-reviewer', task: 'revisa o diff', start: 12, end: 15, wf: { phase: 'Revisar' }, result: '3 ajustes pedidos', tokens: 41_000, tools: 6 },
      { id: 'd2', type: 'general-purpose', task: 'corrige', start: 15, end: 22, wf: { phase: 'Corrigir' }, tokens: 52_000, tools: 9 },
      { id: 'r2', type: 'code-reviewer', task: 'revisa a v2', start: 22, end: null, wf: { phase: 'Revisar' }, tokens: 30_000, tools: 4 },
      { id: 'tr', type: 'test-runner', task: 'bateria', start: 25, end: null, wf: { phase: 'Testar', label: 'test' }, tokens: 12_000, tools: 3 },
      { id: 'ex2', type: 'Explore', task: 'achar usos', start: 27, end: null, tokens: 3_000, tools: 2 },
    ],
  },
  {
    id: 'sim-wf-triage', title: 'Triagem dos bugs abertos', project: 'vitrine-demo', model: SONNET, account: 'client', status: 'completed', source: 'resume',
    minAgo: 26 * 60, durationMin: 12, compacted: true,
    run: { id: 'toolu_sim_wf_triagem', name: 'triagem-de-bugs', phases: ['Coletar', 'Classificar', 'Reproduzir', 'Resumir'], startMin: 0, endMin: 12 },
    subs: [
      { id: 'col', type: 'Explore', task: 'coletar as issues abertas', start: 0, end: 3, wf: { phase: 'Coletar', label: 'coletar' }, tokens: 31_000, tools: 7 },
      { id: 'cls', type: 'general-purpose', task: 'classificar por área', start: 3, end: 7, wf: { phase: 'Classificar', label: 'classificar', role: 'triagem' }, tokens: 48_000, tools: 4 },
      { id: 'rep', type: 'test-runner', task: 'reproduzir os três primeiros', start: 7, end: 10, wf: { phase: 'Reproduzir', label: 'reproduzir' }, tokens: 37_000, tools: 8 },
      { id: 'res', type: 'general-purpose', task: 'resumir a triagem', start: 10, end: 12, wf: { phase: 'Resumir', label: 'resumir', role: 'resumo' }, tokens: 24_000, tools: 3 },
    ],
  },
  {
    id: 'sim-wf-libraries', title: 'Comparar clientes HTTP', project: 'gateway-sandbox', model: OPUS, account: 'team', status: 'completed', source: 'startup',
    minAgo: 2 * 24 * 60 + 90, durationMin: 9,
    run: { id: 'toolu_sim_wf_bibliotecas', name: 'comparar-bibliotecas', phases: ['Pesquisar', 'Comparar', 'Recomendar'], startMin: 0, endMin: 9 },
    subs: [
      { id: 'pes', type: 'Explore', task: 'pesquisar as opções', start: 0, end: 3, wf: { phase: 'Pesquisar', label: 'pesquisar' }, tokens: 34_000, tools: 8 },
      { id: 'cmp', type: 'general-purpose', task: 'comparar undici e fetch', start: 3, end: 7, wf: { phase: 'Comparar', label: 'comparar', role: 'comparacao' }, tokens: 41_000, tools: 6 },
      { id: 'rec', type: 'Plan', task: 'recomendar', start: 7, end: 9, wf: { phase: 'Recomendar', label: 'recomendar' }, tokens: 21_000, tools: 3 },
    ],
  },
  {
    id: 'sim-wf-category', title: 'Filtro por categoria', project: 'vitrine-demo', model: OPUS, account: 'team', status: 'completed', source: 'startup',
    minAgo: 300, durationMin: 35,
    subs: [
      { id: 'ex', type: 'Explore', task: 'ler a listagem', start: 0, end: 3, tokens: 8_000, tools: 4 },
      { id: 'd1', type: 'general-purpose', task: 'implementa o filtro', start: 3, end: 18, tokens: 64_000, tools: 12 },
      { id: 'r1', type: 'code-reviewer', task: 'revisa o diff', start: 18, end: 22, result: 'Aprovado, sem ajustes', tokens: 22_000, tools: 5 },
      { id: 'tr', type: 'test-runner', task: 'bateria', start: 22, end: 26, tokens: 9_000, tools: 3 },
    ],
  },
  {
    id: 'sim-wf-csv', title: 'Exportação em CSV', project: 'motor-de-regras', model: OPUS, account: 'client', status: 'completed', source: 'startup',
    minAgo: 400, durationMin: 52, compacted: true,
    subs: [
      { id: 'pl', type: 'Plan', task: 'plano da exportação', start: 0, end: 4, tokens: 12_000, tools: 2 },
      { id: 'd1', type: 'general-purpose', task: 'implementa', start: 4, end: 16, tokens: 71_000, tools: 15 },
      { id: 'r1', type: 'code-reviewer', task: 'revisa o diff', start: 16, end: 19, result: '2 ajustes pedidos', tokens: 25_000, tools: 5 },
      { id: 'd2', type: 'general-purpose', task: 'corrige', start: 19, end: 27, tokens: 33_000, tools: 8 },
      { id: 'r2', type: 'code-reviewer', task: 'revisa a v2', start: 27, end: 30, result: '1 ajuste pedido', tokens: 18_000, tools: 4 },
      { id: 'd3', type: 'general-purpose', task: 'corrige de novo', start: 30, end: 36, tokens: 21_000, tools: 5 },
      { id: 'r3', type: 'code-reviewer', task: 'revisa a v3', start: 36, end: 39, result: 'Aprovado', tokens: 14_000, tools: 3 },
      { id: 't1', type: 'test-runner', task: 'bateria', start: 39, end: 43, status: 'error', tokens: 6_000, tools: 2 },
      { id: 't2', type: 'test-runner', task: 'bateria de novo', start: 43, end: 48, tokens: 7_000, tools: 2 },
    ],
  },
  {
    id: 'sim-wf-parser', title: 'Testes do parser de datas', project: 'motor-de-regras', model: SONNET, account: 'team', status: 'completed', source: 'startup',
    minAgo: 600, durationMin: 24,
    subs: [
      { id: 'd1', type: 'general-purpose', task: 'escreve os testes', start: 0, end: 9, tokens: 38_000, tools: 9 },
      { id: 'r1', type: 'code-reviewer', task: 'revisa os testes', start: 9, end: 12, result: '1 ajuste pedido', tokens: 15_000, tools: 3 },
      { id: 'd2', type: 'general-purpose', task: 'cobre o caso vazio', start: 12, end: 18, tokens: 19_000, tools: 5 },
      { id: 'r2', type: 'code-reviewer', task: 'revisa a v2', start: 18, end: 21, result: 'Aprovado', tokens: 11_000, tools: 2 },
    ],
  },
  {
    id: 'sim-wf-errors', title: 'Tratamento de erros da API', project: 'gateway-sandbox', model: OPUS, account: 'client', status: 'completed', source: 'resume',
    minAgo: 720, durationMin: 31,
    subs: [
      { id: 'ex', type: 'Explore', task: 'achar os catch vazios', start: 0, end: 4, tokens: 10_000, tools: 6 },
      { id: 'd1', type: 'general-purpose', task: 'implementa', start: 4, end: 22, tokens: 57_000, tools: 13 },
      { id: 'r1', type: 'code-reviewer', task: 'revisa o diff', start: 22, end: 27, result: 'Aprovado, LGTM', tokens: 20_000, tools: 4 },
    ],
  },
  { id: 'sim-wf-signup', title: 'Ajustar o layout do cadastro', project: 'vitrine-demo', model: SONNET, account: 'team', status: 'completed', source: 'startup', minAgo: 200, durationMin: 14, subs: [] },
  {
    id: 'sim-wf-cache', title: 'Migração do cache de sessões', project: 'gateway-sandbox', model: SONNET, account: 'client', status: 'error', source: 'resume',
    minAgo: 90, durationMin: 21, compacted: true,
    subs: [
      { id: 'ex', type: 'Explore', task: 'mapear o cache', start: 0, end: 2, tokens: 6_000, tools: 3 },
      { id: 'd1', type: 'general-purpose', task: 'migra o cache', start: 2, end: 19, status: 'error', tokens: 58_000, tools: 11 },
    ],
  },
  {
    id: 'sim-wf-resume', title: 'Rotas do gateway', project: 'gateway-sandbox', model: OPUS, account: 'team', status: 'active', source: 'resume',
    minAgo: 15, durationMin: null,
    subs: [
      { id: 'ex1', type: 'Explore', task: 'rotas atuais', start: 2, end: 5, tokens: 7_000, tools: 4 },
      { id: 'ex2', type: 'Explore', task: 'middlewares', start: 10, end: null, tokens: 2_000, tools: 1 },
    ],
  },
];

/** The ids of the workflows demo sessions. */
export const WORKFLOW_SESSIONS = DEMOS.map((d) => d.id);

/** Writes the workflows demo sessions through the port. Together with the panel's p4 scenario. */
export async function seedDemoWorkflows(storage: StoragePort, now = Date.now()): Promise<void> {
  for (const d of DEMOS) await writeDemo(storage, d, now);
}

async function writeDemo(storage: StoragePort, d: Demo, now: number) {
  const t0 = now - d.minAgo * MIN;
  const at = (min: number) => new Date(t0 + min * MIN).toISOString();
  const sessionEnd = d.durationMin === null ? null : at(d.durationMin);
  const account = PANEL_ACCOUNTS[d.account];
  const session: Session = {
    id: d.id, name: d.title, status: d.status, cwd: `${ROOT}/${d.project}`, model: d.model, source: d.source, startedAt: at(0), endedAt: sessionEnd,
    awaitingInputSince: null, awaitingReason: null, updatedAt: sessionEnd ?? new Date(now - 0.1 * MIN).toISOString(),
    accountId: account.id, accountSource: account.source,
    // Persisted metadata keys stay as they are (phase 5).
    metadata: {
      simulado: true,
      ...(d.branch ? { branch: d.branch } : {}),
      ...(d.compacted ? { contexto: { usados: 82_000, limite: 200_000, estouros: 1 } } : {}),
    },
  };
  await storage.putSession(session);
  const main = `${d.id}:main`;
  const mainStatus: AgentStatus = d.status === 'active' ? 'working' : d.status === 'error' ? 'error' : 'completed';
  await storage.putAgent(makeAgent(main, d.id, 'main', at(0), sessionEnd, mainStatus));

  let n = 0;
  const addEvent = (agentId: string | null, createdAt: string, type: string, toolName: string | null, summary: string | null, data: unknown = null) =>
    storage.appendEvent({ id: `${d.id}-w${String(++n).padStart(4, '0')}`, sessionId: d.id, agentId, type, toolName, summary, data, createdAt });

  await addEvent(null, at(0), 'UserPromptSubmit', null, 'prompt');
  if (d.compacted) await addEvent(main, at((d.durationMin ?? d.minAgo) / 2), 'Compaction', null, 'compactou', { trigger: 'auto' });
  if (d.run) {
    // The Workflow tool input keeps its keys (`fases`, `volta`): api/workflows.ts reads them.
    const input = { name: d.run.name, fases: d.run.phases, ...(d.run.loopBack ? { volta: d.run.loopBack } : {}), model: d.model };
    await addEvent(main, at(d.run.startMin), 'PreToolUse', 'Workflow', d.run.name, { tool_name: 'Workflow', tool_use_id: d.run.id, tool_input: input });
  }

  const nowMin = (now - t0) / MIN;
  for (const s of d.subs) {
    const id = `${d.id}:${s.id}`;
    const status = s.status ?? (s.end === null ? 'working' : 'completed');
    // `Agent.metadata.workflow` keeps its keys (`fase`, `rotulo`, `papel`): api/workflows.ts reads them.
    const wf = s.wf && d.run ? { workflow: { run: d.run.id, fase: s.wf.phase, ...(s.wf.label ? { rotulo: s.wf.label } : {}), ...(s.wf.role ? { papel: s.wf.role } : {}) } } : {};
    await storage.putAgent({
      ...makeAgent(id, d.id, 'subagent', at(s.start), s.end === null ? null : at(s.end), status),
      subagentType: s.type, name: s.task, parentAgentId: s.parent ? `${d.id}:${s.parent}` : main, metadata: { simulado: true, ...wf },
    });
    // The tools and the messages with usage, spread over the subagent's time.
    const until = s.end ?? Math.min(nowMin - 0.05, s.start + 10);
    const step = (k: number, total: number) => at(s.start + ((until - s.start) * (k + 1)) / (total + 1));
    const tools = s.tools ?? 0;
    for (let k = 0; k < tools; k++) {
      const name = ['Read', 'Grep', 'Edit', 'Bash'][k % 4];
      await addEvent(id, step(k, tools), 'PreToolUse', name, name === 'Bash' ? 'npm test' : 'src/servicos/pagamentos.ts', { tool_name: name, tool_input: {} });
    }
    const tokens = s.tokens ?? 0;
    const messages = tokens > 0 ? 2 : 0;
    for (let k = 0; k < messages; k++) {
      const part = Math.round(tokens / messages);
      const output = Math.round(part * 0.15);
      const last = k === messages - 1;
      await addEvent(id, step(k, messages), 'AssistantMessage', null, last ? (s.result ?? null) : null, {
        usage: {
          messageId: `${id}-m${k}`, requestId: null, model: d.model === OPUS ? SONNET : d.model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
          tokens: { input: part - output, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0,
        },
      });
    }
  }
  if (d.run && d.run.endMin !== null) await addEvent(main, at(d.run.endMin), 'PostToolUse', 'Workflow', d.run.name, { tool_name: 'Workflow', tool_use_id: d.run.id });
}

function makeAgent(id: string, sessionId: string, type: Agent['type'], start: string, end: string | null, status: AgentStatus): Agent {
  return {
    id, sessionId, name: null, type, subagentType: null, status, task: null, currentTool: null, parentAgentId: null,
    startedAt: start, endedAt: end, updatedAt: end ?? start, metadata: { simulado: true },
  };
}
