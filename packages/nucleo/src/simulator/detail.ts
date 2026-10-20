// The session Detail in the demo (#29 and #30): `npm run api -- --demo` writes, besides the panel
// scenario, what the Agents, Conversation and Timeline tabs need so they are not empty.
//
// - A session waiting for permission (C5 and C6): "Migração do esquema de pedidos", with the
//   conversation, tools with results, the Bash stopped at the permission request and a subagent that
//   finished.
// - In the panel session (P4's and the others): tool calls and the subagents' usage, for C4's
//   numbers, most used tools and cost per node. All before the scenario's last tool, which is the one
//   the panel shows.
//
// All synthetic, under /simulacao, with the simulator's vocabulary.

import type { Agent, SessionEvent, TokenCounts, TokenUsage } from '../model.ts';
import { emptyTokenCounts } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { PANEL_SESSION } from './panel.ts';
import { ROOT } from './vocabulary.ts';

/** The Detail's session: the one waiting for permission. */
export const DETAIL_SESSION = 'sim-detalhe-pedidos';
/** The Detail session's synthetic `local_…`: the demo shows "Abrir no Claude Desktop". */
export const DETAIL_LOCAL = 'local_00000000-0000-4000-8000-0000000000d1';

const MIN = 60_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

const iso = (now: number, minAgo: number) => new Date(now - minAgo * MIN).toISOString();

function eventWriter(storage: StoragePort, sessionId: string, prefix: string) {
  let n = 0;
  return (agentId: string | null, at: string, type: string, toolName: string | null, summary: string | null, data: unknown = null) => {
    const e: SessionEvent = { id: `${sessionId}-${prefix}${String(++n).padStart(4, '0')}`, sessionId, agentId, type, toolName, summary, data, createdAt: at };
    return storage.appendEvent(e);
  };
}

function usageData(model: string, messageId: string, tokens: Partial<TokenCounts>) {
  return {
    usage: {
      messageId, requestId: null, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
      tokens: { ...emptyTokenCounts(), ...tokens }, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0,
    },
  };
}

function makeAgent(id: string, sessionId: string, type: Agent['type'], start: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, sessionId, name: null, type, subagentType: null, status: 'working', task: null, currentTool: null,
    parentAgentId: null, startedAt: start, endedAt: null, updatedAt: start, metadata: { simulado: true }, ...extra,
  };
}

/** The sum of the messages' usage, in the session's bucket: the token flow comes from it. */
async function bucket(storage: StoragePort, sessionId: string, model: string, parts: Partial<TokenCounts>[], at: string) {
  const tokens = emptyTokenCounts();
  for (const p of parts) for (const k of Object.keys(tokens) as (keyof TokenCounts)[]) tokens[k] += p[k] ?? 0;
  const b: TokenUsage = {
    sessionId, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens,
    webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: at,
  };
  await storage.putTokenUsage(b);
}

// C5's conversation: the request, the migration written and tested, the "pode seguir" and the Bash stopped at the permission.
async function writePermissionSession(storage: StoragePort, now: number) {
  const id = DETAIL_SESSION;
  const main = `${id}:main`;
  const explore = `${id}:a7f3e2d1c0b9a8f70`;
  const start = iso(now, 34);
  await storage.putSession({
    id, name: 'Migração do esquema de pedidos', status: 'active', cwd: `${ROOT}/motor-de-regras`, model: OPUS, source: 'startup',
    startedAt: start, endedAt: null, awaitingInputSince: iso(now, 2), awaitingReason: 'notification', updatedAt: iso(now, 2),
    accountId: null, accountSource: null,
    metadata: { simulado: true, branch: 'feat/58-pedidos', estados: { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: null, delegacoes: {}, background: {} } },
  });
  await storage.putAgent(makeAgent(main, id, 'main', start, { status: 'waiting', currentTool: 'Bash' }));
  await storage.putAgent(makeAgent(explore, id, 'subagent', iso(now, 30), { subagentType: 'Explore', name: 'mapear o esquema atual', status: 'completed', endedAt: iso(now, 28), parentAgentId: main }));

  const ev = eventWriter(storage, id, 'd');
  const usages: Partial<TokenCounts>[] = [];
  const msg = async (agentId: string, min: number, text: string | null, tokens: Partial<TokenCounts>, model = OPUS) => {
    usages.push(tokens);
    await ev(agentId, iso(now, min), 'AssistantMessage', null, text, usageData(model, `${id}-m${usages.length}`, tokens));
  };
  let calls = 0;
  const tool = async (agentId: string, min: number, name: string, summary: string, input: Record<string, unknown>, result: string | null, isError = false) => {
    const toolUseId = `toolu_sim_${String(++calls).padStart(3, '0')}`;
    // The assistant message that calls the tool carries its usage, as in the transcript.
    const tokens = agentId === main ? { input: 2_000, output: 5_000, cacheRead: 300_000, cacheWrite5m: 20_000 } : { input: 800, output: 600, cacheRead: 20_000 };
    usages.push(tokens);
    await ev(agentId, iso(now, min), 'ToolUse', name, summary, { toolUseId, tool_input: input, ...usageData(agentId === main ? OPUS : SONNET, `${id}-t${calls}`, tokens) });
    await ev(agentId, iso(now, min), 'PreToolUse', name, summary, { tool_name: name, tool_input: input, tool_use_id: toolUseId });
    if (result === null) return;
    await ev(agentId, iso(now, min - 0.2), 'ToolResult', name, result, { toolUseId, isError });
    await ev(agentId, iso(now, min - 0.2), 'PostToolUse', name, isError ? `erro: ${summary}` : summary, { tool_name: name, tool_use_id: toolUseId, tool_response: { success: !isError } });
  };

  await ev(null, start, 'SessionStart', null, 'startup', { source: 'startup' });
  // The start: the request to look at the schema, the read and the subagent that maps it.
  const first = 'olha o esquema atual de pedidos antes de mexer';
  await ev(null, iso(now, 33.5), 'UserPromptSubmit', null, first, { prompt: first });
  await ev(main, iso(now, 33.5), 'UserPrompt', null, first);
  await msg(main, 33, 'Vou ler o repositório de pedidos e pedir a um subagente o mapa do esquema.', { input: 3_200, output: 410, cacheRead: 18_000, cacheWrite5m: 2_100 });
  await tool(main, 32, 'Read', 'src/pedidos/repositorio.ts', { file_path: `${ROOT}/motor-de-regras/src/pedidos/repositorio.ts` }, 'export class RepositorioDePedidos { … }');
  await tool(main, 31, 'Grep', 'status_pagamento', { pattern: 'status_pagamento', path: 'src' }, '3 arquivos');
  await tool(main, 30, 'Agent', 'mapear o esquema atual', { subagent_type: 'Explore', description: 'mapear o esquema atual' }, 'O esquema tem 4 tabelas; pedidos não tem índice por cliente.');
  await tool(explore, 29.8, 'Read', 'migrations/0006_clientes.sql', { file_path: 'migrations/0006_clientes.sql' }, 'create table clientes (…)');
  await tool(explore, 29.5, 'Grep', 'create table', { pattern: 'create table', path: 'migrations' }, '6 ocorrências');
  await msg(explore, 28.2, 'O esquema tem 4 tabelas; pedidos não tem índice por cliente.', { input: 900, output: 260, cacheRead: 6_000 }, SONNET);
  await ev(explore, iso(now, 28), 'SubagentStop', null, 'Explore: mapear o esquema atual', { agent_type: 'Explore' });

  // The migration request, done and tested.
  const second = 'escreva a migração do esquema de pedidos e aplique no banco local';
  await ev(null, iso(now, 12), 'UserPromptSubmit', null, second, { prompt: second });
  await ev(main, iso(now, 12), 'UserPrompt', null, second);
  await msg(main, 5.2, 'Criei `migrations/0007_pedidos.sql` com a coluna `status_pagamento` e o índice em `(cliente_id, criado_em)`. Os testes do repositório de pedidos passam.', { input: 4_100, output: 1_200, cacheRead: 64_000 });
  await tool(main, 5, 'Edit', 'migrations/0007_pedidos.sql', { file_path: 'migrations/0007_pedidos.sql', new_string: 'alter table pedidos add column status_pagamento text;' }, 'Arquivo atualizado');
  await tool(main, 4.6, 'Bash', 'npm test -- pedidos', { command: 'npm test -- pedidos' }, '12 testes passaram');
  await ev(null, iso(now, 4), 'Stop', null, 'Turno concluído em 41,7 s', { stop_hook_active: false });

  // "pode seguir": the migrate Bash waits for the permission.
  await ev(null, iso(now, 3), 'UserPromptSubmit', null, 'pode seguir', { prompt: 'pode seguir' });
  await ev(main, iso(now, 3), 'UserPrompt', null, 'pode seguir');
  await msg(main, 2.5, 'Vou aplicar a migração no banco local.', { input: 2_300, output: 310, cacheRead: 70_000 });
  await tool(main, 2.2, 'Bash', 'npm run migrate', { command: 'npm run migrate' }, null);
  await ev(null, iso(now, 2), 'Notification', null, 'Claude needs your permission to use Bash', { notification_type: 'permission_prompt' });

  await bucket(storage, id, OPUS, usages, iso(now, 2));
}

// The tools and the subagents' usage of the panel session, for C4. All between its start and
// one minute before the scenario's last tool.
async function enrichPanelSession(storage: StoragePort, now: number) {
  const s = await storage.getSession(PANEL_SESSION);
  if (!s) return;
  const agents = await storage.listAgents(s.id);
  const main = agents.find((a) => a.type === 'main')?.id ?? `${s.id}:main`;
  const subs = agents.filter((a) => a.type === 'subagent');
  const startMin = (now - Date.parse(s.startedAt)) / MIN;
  if (startMin < 3) return;
  const ev = eventWriter(storage, s.id, 'd');
  const when = (i: number, n: number) => iso(now, startMin - 0.5 - ((startMin - 2) * i) / n);

  const mix: [string, string][] = [
    ['Bash', 'npm test'], ['Edit', 'src/pagamentos/cobranca.ts'], ['Read', 'src/pagamentos/index.ts'], ['Bash', 'git diff --stat'],
    ['Edit', 'src/pagamentos/servico.ts'], ['Read', 'src/pedidos/checkout.ts'], ['Grep', 'cobrar('], ['Bash', 'npm run lint'],
    ['Edit', 'test/pagamentos.test.ts'], ['Bash', 'npm test -- pagamentos'], ['Read', 'docs/servicos.md'], ['Bash', 'npm run build'],
  ];
  const n = 36;
  for (let i = 0; i < n; i++) {
    const [name, summary] = mix[i % mix.length]!;
    const toolUseId = `toolu_sim_painel_${String(i).padStart(3, '0')}`;
    const at = when(i, n);
    await ev(main, at, 'PreToolUse', name, summary, { tool_name: name, tool_input: { command: summary }, tool_use_id: toolUseId });
    await ev(main, at, 'PostToolUse', name, summary, { tool_name: name, tool_use_id: toolUseId, tool_response: { success: true } });
  }
  // Each subagent: a few reads and its usage, which becomes the node's cost.
  for (const [k, sub] of subs.entries()) {
    const at = sub.startedAt;
    await ev(sub.id, at, 'PreToolUse', 'Read', 'src/pagamentos/cobranca.ts', { tool_name: 'Read', tool_use_id: `toolu_sim_sub_${k}_r` });
    await ev(sub.id, at, 'PreToolUse', 'Grep', 'cobrar(', { tool_name: 'Grep', tool_use_id: `toolu_sim_sub_${k}_g` });
    await ev(sub.id, at, 'AssistantMessage', null, null, usageData(SONNET, `${s.id}-sub-${k}`, { input: 9_000, output: 2_000 * (k + 1), cacheRead: 40_000 }));
  }
}

/** Writes what the demo's Detail shows. Call it after `seedPanelScenario`. */
export async function seedDetail(storage: StoragePort, now = Date.now()): Promise<void> {
  await writePermissionSession(storage, now);
  await enrichPanelSession(storage, now);
}

/** The demo's `local_…`: only the Detail session has one. */
export const demoLocal = (sessionId: string): string | null => (sessionId === DETAIL_SESSION ? DETAIL_LOCAL : null);
