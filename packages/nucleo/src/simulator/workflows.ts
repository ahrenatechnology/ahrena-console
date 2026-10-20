// Sessões sintéticas para as telas Workflows (#96, C14) e a aba Workflow do detalhe (#97, C7), na
// demonstração `npm run api -- --demo --cenario p4`. Tudo é inventado, com o vocabulário do simulador
// (projetos sob /simulacao, contas de UUID de zeros). A representação segue api/workflows.ts: o laço
// sai dos tipos e da ordem dos subagentes e da última mensagem de cada review ("3 ajustes pedidos");
// os runs do Workflow tool, da chamada `Workflow` do principal e de `Agent.metadata.workflow`.
//
// O laço do wireframe C7 é `sim-wf-pagamentos` (ativa); `sim-wf-csv` tem três rodadas e um
// test-runner com erro; `sim-wf-categoria` aprova na primeira. Os runs: dev-review (ativo, em
// `sim-wf-pagamentos`), triagem-de-bugs (ontem) e comparar-bibliotecas (há 2 dias), concluídos.

import type { Agent, AgentStatus, Session, SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { CONTAS } from './panel.ts';
import { ROOT } from './vocabulary.ts';

const MIN = 60_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Sub {
  id: string;
  tipo: string;
  tarefa: string;
  /** Minutos desde o início da sessão; `fim` nulo: ainda roda. */
  ini: number;
  fim: number | null;
  status?: AgentStatus;
  pai?: string;
  /** Fase e rótulo no run do Workflow tool; `papel` troca o papel lido do tipo. */
  wf?: { fase: string; rotulo?: string; papel?: string };
  /** A última mensagem do subagente: "3 ajustes pedidos", "Aprovado". */
  resultado?: string;
  tokens?: number;
  ferramentas?: number;
}

interface Demo {
  id: string;
  titulo: string;
  projeto: string;
  modelo: string;
  conta: keyof typeof CONTAS;
  status: SessionStatus;
  source: 'startup' | 'resume';
  /** Há quantos minutos começou, e quanto durou (`null`: ainda roda). */
  haMin: number;
  duracaoMin: number | null;
  compactou?: boolean;
  branch?: string;
  subs: Sub[];
  run?: { id: string; nome: string; fases: string[]; volta?: string; iniMin: number; fimMin: number | null };
}

const DEMOS: Demo[] = [
  {
    id: 'sim-wf-pagamentos', titulo: 'Separar pagamentos em serviços', projeto: 'motor-de-regras', modelo: OPUS, conta: 'equipe', status: 'active', source: 'startup',
    haMin: 28, duracaoMin: null, branch: 'feat/63-separar-pagamentos',
    run: { id: 'toolu_sim_wf_devreview', nome: 'dev-review', fases: ['Implementar', 'Revisar', 'Corrigir', 'Testar'], volta: 'volta para Corrigir enquanto o review pedir ajustes', iniMin: 0.5, fimMin: null },
    subs: [
      { id: 'ex1', tipo: 'Explore', tarefa: 'mapear o módulo', ini: 0, fim: 2, tokens: 9_000, ferramentas: 5 },
      { id: 'pl', tipo: 'Plan', tarefa: 'plano', ini: 1, fim: 4, tokens: 14_000, ferramentas: 3 },
      { id: 'd1', tipo: 'general-purpose', tarefa: 'implementa', ini: 4, fim: 12, wf: { fase: 'Implementar' }, tokens: 88_000, ferramentas: 14 },
      { id: 'r1', tipo: 'code-reviewer', tarefa: 'revisa o diff', ini: 12, fim: 15, wf: { fase: 'Revisar' }, resultado: '3 ajustes pedidos', tokens: 41_000, ferramentas: 6 },
      { id: 'd2', tipo: 'general-purpose', tarefa: 'corrige', ini: 15, fim: 22, wf: { fase: 'Corrigir' }, tokens: 52_000, ferramentas: 9 },
      { id: 'r2', tipo: 'code-reviewer', tarefa: 'revisa a v2', ini: 22, fim: null, wf: { fase: 'Revisar' }, tokens: 30_000, ferramentas: 4 },
      { id: 'tr', tipo: 'test-runner', tarefa: 'bateria', ini: 25, fim: null, wf: { fase: 'Testar', rotulo: 'test' }, tokens: 12_000, ferramentas: 3 },
      { id: 'ex2', tipo: 'Explore', tarefa: 'achar usos', ini: 27, fim: null, tokens: 3_000, ferramentas: 2 },
    ],
  },
  {
    id: 'sim-wf-triagem', titulo: 'Triagem dos bugs abertos', projeto: 'vitrine-demo', modelo: SONNET, conta: 'cliente', status: 'completed', source: 'resume',
    haMin: 26 * 60, duracaoMin: 12, compactou: true,
    run: { id: 'toolu_sim_wf_triagem', nome: 'triagem-de-bugs', fases: ['Coletar', 'Classificar', 'Reproduzir', 'Resumir'], iniMin: 0, fimMin: 12 },
    subs: [
      { id: 'col', tipo: 'Explore', tarefa: 'coletar as issues abertas', ini: 0, fim: 3, wf: { fase: 'Coletar', rotulo: 'coletar' }, tokens: 31_000, ferramentas: 7 },
      { id: 'cls', tipo: 'general-purpose', tarefa: 'classificar por área', ini: 3, fim: 7, wf: { fase: 'Classificar', rotulo: 'classificar', papel: 'triagem' }, tokens: 48_000, ferramentas: 4 },
      { id: 'rep', tipo: 'test-runner', tarefa: 'reproduzir os três primeiros', ini: 7, fim: 10, wf: { fase: 'Reproduzir', rotulo: 'reproduzir' }, tokens: 37_000, ferramentas: 8 },
      { id: 'res', tipo: 'general-purpose', tarefa: 'resumir a triagem', ini: 10, fim: 12, wf: { fase: 'Resumir', rotulo: 'resumir', papel: 'resumo' }, tokens: 24_000, ferramentas: 3 },
    ],
  },
  {
    id: 'sim-wf-bibliotecas', titulo: 'Comparar clientes HTTP', projeto: 'gateway-sandbox', modelo: OPUS, conta: 'equipe', status: 'completed', source: 'startup',
    haMin: 2 * 24 * 60 + 90, duracaoMin: 9,
    run: { id: 'toolu_sim_wf_bibliotecas', nome: 'comparar-bibliotecas', fases: ['Pesquisar', 'Comparar', 'Recomendar'], iniMin: 0, fimMin: 9 },
    subs: [
      { id: 'pes', tipo: 'Explore', tarefa: 'pesquisar as opções', ini: 0, fim: 3, wf: { fase: 'Pesquisar', rotulo: 'pesquisar' }, tokens: 34_000, ferramentas: 8 },
      { id: 'cmp', tipo: 'general-purpose', tarefa: 'comparar undici e fetch', ini: 3, fim: 7, wf: { fase: 'Comparar', rotulo: 'comparar', papel: 'comparacao' }, tokens: 41_000, ferramentas: 6 },
      { id: 'rec', tipo: 'Plan', tarefa: 'recomendar', ini: 7, fim: 9, wf: { fase: 'Recomendar', rotulo: 'recomendar' }, tokens: 21_000, ferramentas: 3 },
    ],
  },
  {
    id: 'sim-wf-categoria', titulo: 'Filtro por categoria', projeto: 'vitrine-demo', modelo: OPUS, conta: 'equipe', status: 'completed', source: 'startup',
    haMin: 300, duracaoMin: 35,
    subs: [
      { id: 'ex', tipo: 'Explore', tarefa: 'ler a listagem', ini: 0, fim: 3, tokens: 8_000, ferramentas: 4 },
      { id: 'd1', tipo: 'general-purpose', tarefa: 'implementa o filtro', ini: 3, fim: 18, tokens: 64_000, ferramentas: 12 },
      { id: 'r1', tipo: 'code-reviewer', tarefa: 'revisa o diff', ini: 18, fim: 22, resultado: 'Aprovado, sem ajustes', tokens: 22_000, ferramentas: 5 },
      { id: 'tr', tipo: 'test-runner', tarefa: 'bateria', ini: 22, fim: 26, tokens: 9_000, ferramentas: 3 },
    ],
  },
  {
    id: 'sim-wf-csv', titulo: 'Exportação em CSV', projeto: 'motor-de-regras', modelo: OPUS, conta: 'cliente', status: 'completed', source: 'startup',
    haMin: 400, duracaoMin: 52, compactou: true,
    subs: [
      { id: 'pl', tipo: 'Plan', tarefa: 'plano da exportação', ini: 0, fim: 4, tokens: 12_000, ferramentas: 2 },
      { id: 'd1', tipo: 'general-purpose', tarefa: 'implementa', ini: 4, fim: 16, tokens: 71_000, ferramentas: 15 },
      { id: 'r1', tipo: 'code-reviewer', tarefa: 'revisa o diff', ini: 16, fim: 19, resultado: '2 ajustes pedidos', tokens: 25_000, ferramentas: 5 },
      { id: 'd2', tipo: 'general-purpose', tarefa: 'corrige', ini: 19, fim: 27, tokens: 33_000, ferramentas: 8 },
      { id: 'r2', tipo: 'code-reviewer', tarefa: 'revisa a v2', ini: 27, fim: 30, resultado: '1 ajuste pedido', tokens: 18_000, ferramentas: 4 },
      { id: 'd3', tipo: 'general-purpose', tarefa: 'corrige de novo', ini: 30, fim: 36, tokens: 21_000, ferramentas: 5 },
      { id: 'r3', tipo: 'code-reviewer', tarefa: 'revisa a v3', ini: 36, fim: 39, resultado: 'Aprovado', tokens: 14_000, ferramentas: 3 },
      { id: 't1', tipo: 'test-runner', tarefa: 'bateria', ini: 39, fim: 43, status: 'error', tokens: 6_000, ferramentas: 2 },
      { id: 't2', tipo: 'test-runner', tarefa: 'bateria de novo', ini: 43, fim: 48, tokens: 7_000, ferramentas: 2 },
    ],
  },
  {
    id: 'sim-wf-parser', titulo: 'Testes do parser de datas', projeto: 'motor-de-regras', modelo: SONNET, conta: 'equipe', status: 'completed', source: 'startup',
    haMin: 600, duracaoMin: 24,
    subs: [
      { id: 'd1', tipo: 'general-purpose', tarefa: 'escreve os testes', ini: 0, fim: 9, tokens: 38_000, ferramentas: 9 },
      { id: 'r1', tipo: 'code-reviewer', tarefa: 'revisa os testes', ini: 9, fim: 12, resultado: '1 ajuste pedido', tokens: 15_000, ferramentas: 3 },
      { id: 'd2', tipo: 'general-purpose', tarefa: 'cobre o caso vazio', ini: 12, fim: 18, tokens: 19_000, ferramentas: 5 },
      { id: 'r2', tipo: 'code-reviewer', tarefa: 'revisa a v2', ini: 18, fim: 21, resultado: 'Aprovado', tokens: 11_000, ferramentas: 2 },
    ],
  },
  {
    id: 'sim-wf-erros', titulo: 'Tratamento de erros da API', projeto: 'gateway-sandbox', modelo: OPUS, conta: 'cliente', status: 'completed', source: 'resume',
    haMin: 720, duracaoMin: 31,
    subs: [
      { id: 'ex', tipo: 'Explore', tarefa: 'achar os catch vazios', ini: 0, fim: 4, tokens: 10_000, ferramentas: 6 },
      { id: 'd1', tipo: 'general-purpose', tarefa: 'implementa', ini: 4, fim: 22, tokens: 57_000, ferramentas: 13 },
      { id: 'r1', tipo: 'code-reviewer', tarefa: 'revisa o diff', ini: 22, fim: 27, resultado: 'Aprovado, LGTM', tokens: 20_000, ferramentas: 4 },
    ],
  },
  { id: 'sim-wf-cadastro', titulo: 'Ajustar o layout do cadastro', projeto: 'vitrine-demo', modelo: SONNET, conta: 'equipe', status: 'completed', source: 'startup', haMin: 200, duracaoMin: 14, subs: [] },
  {
    id: 'sim-wf-cache', titulo: 'Migração do cache de sessões', projeto: 'gateway-sandbox', modelo: SONNET, conta: 'cliente', status: 'error', source: 'resume',
    haMin: 90, duracaoMin: 21, compactou: true,
    subs: [
      { id: 'ex', tipo: 'Explore', tarefa: 'mapear o cache', ini: 0, fim: 2, tokens: 6_000, ferramentas: 3 },
      { id: 'd1', tipo: 'general-purpose', tarefa: 'migra o cache', ini: 2, fim: 19, status: 'error', tokens: 58_000, ferramentas: 11 },
    ],
  },
  {
    id: 'sim-wf-retomada', titulo: 'Rotas do gateway', projeto: 'gateway-sandbox', modelo: OPUS, conta: 'equipe', status: 'active', source: 'resume',
    haMin: 15, duracaoMin: null,
    subs: [
      { id: 'ex1', tipo: 'Explore', tarefa: 'rotas atuais', ini: 2, fim: 5, tokens: 7_000, ferramentas: 4 },
      { id: 'ex2', tipo: 'Explore', tarefa: 'middlewares', ini: 10, fim: null, tokens: 2_000, ferramentas: 1 },
    ],
  },
];

/** Os ids das sessões da demonstração dos workflows. */
export const SESSOES_DOS_WORKFLOWS = DEMOS.map((d) => d.id);

/** Grava as sessões da demonstração dos workflows pela porta. Junto do cenário p4 do painel. */
export async function semearWorkflowsDoDemo(porta: StoragePort, agora = Date.now()): Promise<void> {
  for (const d of DEMOS) await gravar(porta, d, agora);
}

async function gravar(porta: StoragePort, d: Demo, agora: number) {
  const t0 = agora - d.haMin * MIN;
  const em = (min: number) => new Date(t0 + min * MIN).toISOString();
  const fimDaSessao = d.duracaoMin === null ? null : em(d.duracaoMin);
  const conta = CONTAS[d.conta];
  const session: Session = {
    id: d.id, name: d.titulo, status: d.status, cwd: `${ROOT}/${d.projeto}`, model: d.modelo, source: d.source, startedAt: em(0), endedAt: fimDaSessao,
    awaitingInputSince: null, awaitingReason: null, updatedAt: fimDaSessao ?? new Date(agora - 0.1 * MIN).toISOString(),
    accountId: conta.id, accountSource: conta.source,
    metadata: {
      simulado: true,
      ...(d.branch ? { branch: d.branch } : {}),
      ...(d.compactou ? { contexto: { usados: 82_000, limite: 200_000, estouros: 1 } } : {}),
    },
  };
  await porta.putSession(session);
  const main = `${d.id}:main`;
  const mainStatus: AgentStatus = d.status === 'active' ? 'working' : d.status === 'error' ? 'error' : 'completed';
  await porta.putAgent(agente(main, d.id, 'main', em(0), fimDaSessao, mainStatus));

  let n = 0;
  const evento = (agentId: string | null, createdAt: string, type: string, toolName: string | null, summary: string | null, data: unknown = null) =>
    porta.appendEvent({ id: `${d.id}-w${String(++n).padStart(4, '0')}`, sessionId: d.id, agentId, type, toolName, summary, data, createdAt });

  await evento(null, em(0), 'UserPromptSubmit', null, 'prompt');
  if (d.compactou) await evento(main, em((d.duracaoMin ?? d.haMin) / 2), 'Compaction', null, 'compactou', { trigger: 'auto' });
  if (d.run) {
    const entrada = { name: d.run.nome, fases: d.run.fases, ...(d.run.volta ? { volta: d.run.volta } : {}), model: d.modelo };
    await evento(main, em(d.run.iniMin), 'PreToolUse', 'Workflow', d.run.nome, { tool_name: 'Workflow', tool_use_id: d.run.id, tool_input: entrada });
  }

  const agoraMin = (agora - t0) / MIN;
  for (const s of d.subs) {
    const id = `${d.id}:${s.id}`;
    const status = s.status ?? (s.fim === null ? 'working' : 'completed');
    const wf = s.wf && d.run ? { workflow: { run: d.run.id, fase: s.wf.fase, ...(s.wf.rotulo ? { rotulo: s.wf.rotulo } : {}), ...(s.wf.papel ? { papel: s.wf.papel } : {}) } } : {};
    await porta.putAgent({
      ...agente(id, d.id, 'subagent', em(s.ini), s.fim === null ? null : em(s.fim), status),
      subagentType: s.tipo, name: s.tarefa, parentAgentId: s.pai ? `${d.id}:${s.pai}` : main, metadata: { simulado: true, ...wf },
    });
    // As ferramentas e as mensagens com uso, espalhadas pelo tempo do subagente.
    const ate = s.fim ?? Math.min(agoraMin - 0.05, s.ini + 10);
    const passo = (k: number, total: number) => em(s.ini + ((ate - s.ini) * (k + 1)) / (total + 1));
    const ferramentas = s.ferramentas ?? 0;
    for (let k = 0; k < ferramentas; k++) {
      const nome = ['Read', 'Grep', 'Edit', 'Bash'][k % 4];
      await evento(id, passo(k, ferramentas), 'PreToolUse', nome, nome === 'Bash' ? 'npm test' : 'src/servicos/pagamentos.ts', { tool_name: nome, tool_input: {} });
    }
    const tokens = s.tokens ?? 0;
    const mensagens = tokens > 0 ? 2 : 0;
    for (let k = 0; k < mensagens; k++) {
      const parte = Math.round(tokens / mensagens);
      const output = Math.round(parte * 0.15);
      const ultima = k === mensagens - 1;
      await evento(id, passo(k, mensagens), 'AssistantMessage', null, ultima ? (s.resultado ?? null) : null, {
        usage: {
          messageId: `${id}-m${k}`, requestId: null, model: d.modelo === OPUS ? SONNET : d.modelo, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '',
          tokens: { input: parte - output, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0,
        },
      });
    }
  }
  if (d.run && d.run.fimMin !== null) await evento(main, em(d.run.fimMin), 'PostToolUse', 'Workflow', d.run.nome, { tool_name: 'Workflow', tool_use_id: d.run.id });
}

function agente(id: string, sessionId: string, type: Agent['type'], inicio: string, fim: string | null, status: AgentStatus): Agent {
  return {
    id, sessionId, name: null, type, subagentType: null, status, task: null, currentTool: null, parentAgentId: null,
    startedAt: inicio, endedAt: fim, updatedAt: fim ?? inicio, metadata: { simulado: true },
  };
}
