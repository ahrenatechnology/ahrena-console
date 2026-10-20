// O Detalhe da sessão na demonstração (#29 e #30): `npm run api -- --demo` grava, além do cenário
// do painel, o que as abas Agentes, Conversa e Linha do tempo precisam para não ficarem vazias.
//
// - Uma sessão que espera permissão (C5 e C6): "Migração do esquema de pedidos", com a conversa, as
//   ferramentas com resultado, o Bash parado no pedido de permissão e um subagente que terminou.
// - Na sessão do painel (a do P4 e as outras): chamadas de ferramenta e o uso dos subagentes, para
//   os números, as ferramentas mais usadas e o custo por nó do C4. Tudo antes da última ferramenta
//   do cenário, que é a que o painel mostra.
//
// Tudo sintético, sob /simulacao, com o vocabulário do simulador.

import type { Agent, SessionEvent, TokenCounts, TokenUsage } from '../model.ts';
import { emptyTokenCounts } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { SESSAO_DO_PAINEL } from './painel.ts';
import { RAIZ } from './vocabulario.ts';

export const SESSAO_DO_DETALHE = 'sim-detalhe-pedidos';
/** O `local_…` sintético da sessão do Detalhe: a demonstração mostra o "Abrir no Claude Desktop". */
export const LOCAL_DO_DETALHE = 'local_00000000-0000-4000-8000-0000000000d1';

const MIN = 60_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

const iso = (agora: number, minAtras: number) => new Date(agora - minAtras * MIN).toISOString();

function gravador(porta: StoragePort, sessionId: string, prefixo: string) {
  let n = 0;
  return (agentId: string | null, em: string, type: string, toolName: string | null, summary: string | null, data: unknown = null) => {
    const e: SessionEvent = { id: `${sessionId}-${prefixo}${String(++n).padStart(4, '0')}`, sessionId, agentId, type, toolName, summary, data, createdAt: em };
    return porta.appendEvent(e);
  };
}

function uso(model: string, mensagem: string, tokens: Partial<TokenCounts>) {
  return {
    usage: {
      messageId: mensagem, requestId: null, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
      tokens: { ...emptyTokenCounts(), ...tokens }, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0,
    },
  };
}

function agente(id: string, sessionId: string, tipo: Agent['type'], inicio: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, sessionId, name: null, type: tipo, subagentType: null, status: 'working', task: null, currentTool: null,
    parentAgentId: null, startedAt: inicio, endedAt: null, updatedAt: inicio, metadata: { simulado: true }, ...extra,
  };
}

/** A soma do uso das mensagens, no bucket da sessão: o fluxo de tokens sai dele. */
async function bucket(porta: StoragePort, sessionId: string, model: string, partes: Partial<TokenCounts>[], em: string) {
  const tokens = emptyTokenCounts();
  for (const p of partes) for (const k of Object.keys(tokens) as (keyof TokenCounts)[]) tokens[k] += p[k] ?? 0;
  const b: TokenUsage = {
    sessionId, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens,
    webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: em,
  };
  await porta.putTokenUsage(b);
}

// A conversa do C5: o pedido, a migração escrita e testada, o "pode seguir" e o Bash parado na permissão.
async function gravarSessaoQuePedePermissao(porta: StoragePort, agora: number) {
  const id = SESSAO_DO_DETALHE;
  const main = `${id}:main`;
  const explore = `${id}:a7f3e2d1c0b9a8f70`;
  const inicio = iso(agora, 34);
  await porta.putSession({
    id, name: 'Migração do esquema de pedidos', status: 'active', cwd: `${RAIZ}/motor-de-regras`, model: OPUS, source: 'startup',
    startedAt: inicio, endedAt: null, awaitingInputSince: iso(agora, 2), awaitingReason: 'notification', updatedAt: iso(agora, 2),
    accountId: null, accountSource: null,
    metadata: { simulado: true, branch: 'feat/58-pedidos', estados: { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: null, delegacoes: {}, background: {} } },
  });
  await porta.putAgent(agente(main, id, 'main', inicio, { status: 'waiting', currentTool: 'Bash' }));
  await porta.putAgent(agente(explore, id, 'subagent', iso(agora, 30), { subagentType: 'Explore', name: 'mapear o esquema atual', status: 'completed', endedAt: iso(agora, 28), parentAgentId: main }));

  const ev = gravador(porta, id, 'd');
  const usos: Partial<TokenCounts>[] = [];
  const msg = async (agentId: string, min: number, texto: string | null, tokens: Partial<TokenCounts>, model = OPUS) => {
    usos.push(tokens);
    await ev(agentId, iso(agora, min), 'AssistantMessage', null, texto, uso(model, `${id}-m${usos.length}`, tokens));
  };
  let chamada = 0;
  const ferramenta = async (agentId: string, min: number, nome: string, resumo: string, entrada: Record<string, unknown>, resultado: string | null, erro = false) => {
    const toolUseId = `toolu_sim_${String(++chamada).padStart(3, '0')}`;
    // A mensagem do assistente que chama a ferramenta traz o uso dela, como no transcript.
    const tokens = agentId === main ? { input: 2_000, output: 5_000, cacheRead: 300_000, cacheWrite5m: 20_000 } : { input: 800, output: 600, cacheRead: 20_000 };
    usos.push(tokens);
    await ev(agentId, iso(agora, min), 'ToolUse', nome, resumo, { toolUseId, tool_input: entrada, ...uso(agentId === main ? OPUS : SONNET, `${id}-t${chamada}`, tokens) });
    await ev(agentId, iso(agora, min), 'PreToolUse', nome, resumo, { tool_name: nome, tool_input: entrada, tool_use_id: toolUseId });
    if (resultado === null) return;
    await ev(agentId, iso(agora, min - 0.2), 'ToolResult', nome, resultado, { toolUseId, isError: erro });
    await ev(agentId, iso(agora, min - 0.2), 'PostToolUse', nome, erro ? `erro: ${resumo}` : resumo, { tool_name: nome, tool_use_id: toolUseId, tool_response: { success: !erro } });
  };

  await ev(null, inicio, 'SessionStart', null, 'startup', { source: 'startup' });
  // O começo: o pedido de olhar o esquema, a leitura e o subagente que o mapeia.
  const primeiro = 'olha o esquema atual de pedidos antes de mexer';
  await ev(null, iso(agora, 33.5), 'UserPromptSubmit', null, primeiro, { prompt: primeiro });
  await ev(main, iso(agora, 33.5), 'UserPrompt', null, primeiro);
  await msg(main, 33, 'Vou ler o repositório de pedidos e pedir a um subagente o mapa do esquema.', { input: 3_200, output: 410, cacheRead: 18_000, cacheWrite5m: 2_100 });
  await ferramenta(main, 32, 'Read', 'src/pedidos/repositorio.ts', { file_path: `${RAIZ}/motor-de-regras/src/pedidos/repositorio.ts` }, 'export class RepositorioDePedidos { … }');
  await ferramenta(main, 31, 'Grep', 'status_pagamento', { pattern: 'status_pagamento', path: 'src' }, '3 arquivos');
  await ferramenta(main, 30, 'Agent', 'mapear o esquema atual', { subagent_type: 'Explore', description: 'mapear o esquema atual' }, 'O esquema tem 4 tabelas; pedidos não tem índice por cliente.');
  await ferramenta(explore, 29.8, 'Read', 'migrations/0006_clientes.sql', { file_path: 'migrations/0006_clientes.sql' }, 'create table clientes (…)');
  await ferramenta(explore, 29.5, 'Grep', 'create table', { pattern: 'create table', path: 'migrations' }, '6 ocorrências');
  await msg(explore, 28.2, 'O esquema tem 4 tabelas; pedidos não tem índice por cliente.', { input: 900, output: 260, cacheRead: 6_000 }, SONNET);
  await ev(explore, iso(agora, 28), 'SubagentStop', null, 'Explore: mapear o esquema atual', { agent_type: 'Explore' });

  // O pedido da migração, feita e testada.
  const segundo = 'escreva a migração do esquema de pedidos e aplique no banco local';
  await ev(null, iso(agora, 12), 'UserPromptSubmit', null, segundo, { prompt: segundo });
  await ev(main, iso(agora, 12), 'UserPrompt', null, segundo);
  await msg(main, 5.2, 'Criei `migrations/0007_pedidos.sql` com a coluna `status_pagamento` e o índice em `(cliente_id, criado_em)`. Os testes do repositório de pedidos passam.', { input: 4_100, output: 1_200, cacheRead: 64_000 });
  await ferramenta(main, 5, 'Edit', 'migrations/0007_pedidos.sql', { file_path: 'migrations/0007_pedidos.sql', new_string: 'alter table pedidos add column status_pagamento text;' }, 'Arquivo atualizado');
  await ferramenta(main, 4.6, 'Bash', 'npm test -- pedidos', { command: 'npm test -- pedidos' }, '12 testes passaram');
  await ev(null, iso(agora, 4), 'Stop', null, 'Turno concluído em 41,7 s', { stop_hook_active: false });

  // "pode seguir": o Bash do migrate fica esperando a permissão.
  await ev(null, iso(agora, 3), 'UserPromptSubmit', null, 'pode seguir', { prompt: 'pode seguir' });
  await ev(main, iso(agora, 3), 'UserPrompt', null, 'pode seguir');
  await msg(main, 2.5, 'Vou aplicar a migração no banco local.', { input: 2_300, output: 310, cacheRead: 70_000 });
  await ferramenta(main, 2.2, 'Bash', 'npm run migrate', { command: 'npm run migrate' }, null);
  await ev(null, iso(agora, 2), 'Notification', null, 'Claude needs your permission to use Bash', { notification_type: 'permission_prompt' });

  await bucket(porta, id, OPUS, usos, iso(agora, 2));
}

// As ferramentas e o uso dos subagentes da sessão do painel, para o C4. Tudo entre o começo dela e
// um minuto antes da última ferramenta do cenário.
async function enriquecerSessaoDoPainel(porta: StoragePort, agora: number) {
  const s = await porta.getSession(SESSAO_DO_PAINEL);
  if (!s) return;
  const agentes = await porta.listAgents(s.id);
  const main = agentes.find((a) => a.type === 'main')?.id ?? `${s.id}:main`;
  const subs = agentes.filter((a) => a.type === 'subagent');
  const inicioMin = (agora - Date.parse(s.startedAt)) / MIN;
  if (inicioMin < 3) return;
  const ev = gravador(porta, s.id, 'd');
  const quando = (i: number, n: number) => iso(agora, inicioMin - 0.5 - ((inicioMin - 2) * i) / n);

  const mistura: [string, string][] = [
    ['Bash', 'npm test'], ['Edit', 'src/pagamentos/cobranca.ts'], ['Read', 'src/pagamentos/index.ts'], ['Bash', 'git diff --stat'],
    ['Edit', 'src/pagamentos/servico.ts'], ['Read', 'src/pedidos/checkout.ts'], ['Grep', 'cobrar('], ['Bash', 'npm run lint'],
    ['Edit', 'test/pagamentos.test.ts'], ['Bash', 'npm test -- pagamentos'], ['Read', 'docs/servicos.md'], ['Bash', 'npm run build'],
  ];
  const n = 36;
  for (let i = 0; i < n; i++) {
    const [nome, resumo] = mistura[i % mistura.length]!;
    const toolUseId = `toolu_sim_painel_${String(i).padStart(3, '0')}`;
    const em = quando(i, n);
    await ev(main, em, 'PreToolUse', nome, resumo, { tool_name: nome, tool_input: { command: resumo }, tool_use_id: toolUseId });
    await ev(main, em, 'PostToolUse', nome, resumo, { tool_name: nome, tool_use_id: toolUseId, tool_response: { success: true } });
  }
  // Cada subagente: algumas leituras e o uso dele, que vira o custo do nó.
  for (const [k, sub] of subs.entries()) {
    const em = sub.startedAt;
    await ev(sub.id, em, 'PreToolUse', 'Read', 'src/pagamentos/cobranca.ts', { tool_name: 'Read', tool_use_id: `toolu_sim_sub_${k}_r` });
    await ev(sub.id, em, 'PreToolUse', 'Grep', 'cobrar(', { tool_name: 'Grep', tool_use_id: `toolu_sim_sub_${k}_g` });
    await ev(sub.id, em, 'AssistantMessage', null, null, uso(SONNET, `${s.id}-sub-${k}`, { input: 9_000, output: 2_000 * (k + 1), cacheRead: 40_000 }));
  }
}

/** Grava o que o Detalhe da demonstração mostra. Chame depois de `semearCenariosDoPainel`. */
export async function semearDetalhe(porta: StoragePort, agora = Date.now()): Promise<void> {
  await gravarSessaoQuePedePermissao(porta, agora);
  await enriquecerSessaoDoPainel(porta, agora);
}

/** O `local_…` da demonstração: só a sessão do Detalhe tem. */
export const localDaDemo = (sessionId: string): string | null => (sessionId === SESSAO_DO_DETALHE ? LOCAL_DO_DETALHE : null);
