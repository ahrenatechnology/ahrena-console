// Cenários do painel lateral (P1 a P7 e P9 dos wireframes, docs/wireframes), para demonstrar e
// capturar o painel sem dados reais: `npm run api -- --demo p1`. Tudo é sintético, com o
// vocabulário do simulador: projetos sob /simulacao, repositório `exemplo/simulacao` e duas
// contas sintéticas (UUIDs de zeros). A sessão do painel, seja qual for o id que ele mande, vira `sim-painel-esta`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSource, Agent, AwaitingReason, Session, SessionStatus, TokenUsage } from '../model.ts';
import { claudeAccountId, emptyTokenCounts } from '../model.ts';
import { paleta } from '../../../marca/gerado/marca.ts';
import { atualizarPlano } from '../plano/gravacao.ts';
import type { StoragePort } from '../storage-port.ts';
import type { DecisionPort } from '../decisoes/porta.ts';
import { linkSession, markPromoted, registerDecision, type DecisionDraft } from '../decisoes/registro.ts';
import type { ChildrenResult, WorkSource } from '../github/source.ts';
import type { CiCounts, LinkedPullRequest, WorkDetail, WorkNode } from '../github/work.ts';
import { stageOf } from '../github/work.ts';
import { RAIZ } from './vocabulario.ts';

/** As checagens do CI como no P1: "CI ✓ 6/6", "CI … 3/7", "CI ✕ 2 falhas". */
const CHECKS_DO_P1: Record<string, CiCounts> = {
  SUCCESS: { total: 6, ok: 6, falhas: 0, rodando: 0 },
  PENDING: { total: 7, ok: 3, falhas: 0, rodando: 4 },
  FAILURE: { total: 7, ok: 5, falhas: 2, rodando: 0 },
};

export const CENARIOS_DO_PAINEL = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p9'] as const;
export type CenarioDoPainel = (typeof CENARIOS_DO_PAINEL)[number];
export const SESSAO_DO_PAINEL = 'sim-painel-esta';
export const REPO_DO_SIMULADOR = 'exemplo/simulacao';

function contaSintetica(n: string, label: string, color: string, tipo: string, source: AccountSource) {
  const accountUuid = `00000000-0000-4000-8000-00000000${n}a1`;
  const organizationUuid = `00000000-0000-4000-8000-00000000${n}b1`;
  return { accountUuid, organizationUuid, id: claudeAccountId(accountUuid, organizationUuid), label, color, tipo, source };
}
// Cores da marca (packages/marca): rosa e verde, que não se confundem com os status.
const CONTAS = {
  equipe: contaSintetica('0e', 'equipe', paleta.rose['500'], 'claude_team', 'env'),
  cliente: contaSintetica('0c', 'cliente-exemplo', paleta.green['500'], 'claude_enterprise', 'config'),
} as const;

const MIN = 60_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

interface Issue {
  numero: number;
  titulo: string;
  sub?: [number, number];
  pr?: { numero: number; rascunho?: boolean; ci: LinkedPullRequest['ci']; review: LinkedPullRequest['review'] };
}

type Passos = [string, 'completed' | 'in_progress' | 'pending'][];

interface Esta {
  titulo: string;
  projeto: string;
  modelo: string;
  inicioMin: number;
  status: SessionStatus;
  espera?: { motivo: AwaitingReason; haMin: number };
  turno: number;
  contexto: number;
  custo: number;
  ferramenta?: { nome: string; resumo: string; entrada?: Record<string, unknown> };
  notificacao?: string;
  pergunta?: { texto: string; opcoes: number };
  erro?: { texto: string; haMin: number };
  background?: string[];
  plano?: Passos;
  /** Planos que a sessão já fechou antes do atual (issue #131), do mais antigo para o mais novo. */
  anteriores?: { desdeMin: number; duracaoMin: number; passos: Passos }[];
  subagentes?: { tipo: string; tarefa: string; status: Agent['status']; haMin: number; duracaoMin?: number }[];
  filhas?: string[];
  branch: string;
  semPush?: boolean;
  issue?: Issue;
}

interface Outra {
  slug: string;
  titulo?: string;
  modelo: string;
  conta: keyof typeof CONTAS;
  status: SessionStatus;
  espera?: { motivo: AwaitingReason; haMin: number };
  texto?: string;
  ferramenta?: { nome: string; resumo: string };
  erro?: string;
  relacao?: 'mae' | 'filha';
  updatedMin?: number;
}

const PERMISSAO: Outra = {
  slug: 'motor-de-regras', modelo: OPUS, conta: 'equipe', status: 'active', espera: { motivo: 'notification', haMin: 2 },
  ferramenta: { nome: 'Bash', resumo: 'npm run migrate' }, texto: 'Claude needs your permission to use Bash',
};
const INTERROMPIDA: Outra = { slug: 'app-receitas', modelo: SONNET, conta: 'cliente', status: 'active', espera: { motivo: 'interrupted', haMin: 6 } };
const COM_ERRO: Outra = { slug: 'painel-de-metricas', modelo: OPUS, conta: 'cliente', status: 'error', erro: 'API 529 · overloaded_error', updatedMin: 3 };
const SUA_VEZ: Outra = {
  slug: 'fila-de-tarefas', modelo: SONNET, conta: 'equipe', status: 'active', espera: { motivo: 'stop', haMin: 1 },
  texto: 'Terminei a migração. Rodo os testes?',
};

const ESTA: Record<Exclude<CenarioDoPainel, 'p9'>, Esta> = {
  p1: {
    titulo: 'Kanban de sessões no artefato', projeto: 'ahrena-demo', modelo: OPUS, inicioMin: 12, status: 'active', turno: 18,
    contexto: 62_000, custo: 1.84, ferramenta: { nome: 'Bash', resumo: 'npm test' }, background: ['npm run dev', 'npm run watch'],
    plano: [['Ler o artefato', 'completed'], ['Montar as raias', 'completed'], ['Ligar ao núcleo', 'completed'], ['Rodar a bateria', 'in_progress'], ['Abrir o PR', 'pending'], ['Pedir review', 'pending']],
    anteriores: [
      { desdeMin: 11, duracaoMin: 3, passos: [['Ler o wireframe do kanban', 'completed'], ['Listar os estados', 'completed'], ['Escolher as raias', 'completed']] },
      { desdeMin: 8, duracaoMin: 2, passos: [['Prototipar o arrastar', 'completed'], ['Medir a latência', 'in_progress'], ['Trocar a biblioteca', 'pending'], ['Ajustar o tema', 'pending']] },
    ],
    subagentes: [{ tipo: 'Explore', tarefa: 'mapear usos', status: 'working', haMin: 0.7 }, { tipo: 'Plan', tarefa: 'plano', status: 'completed', haMin: 9, duracaoMin: 2 }],
    branch: 'feat/42-kanban-de-sessoes', issue: { numero: 42, titulo: 'Kanban de sessões', sub: [2, 4], pr: { numero: 78, rascunho: true, ci: 'SUCCESS', review: null } },
  },
  p2: {
    titulo: 'Testes de integração da API', projeto: 'gateway-sandbox', modelo: OPUS, inicioMin: 26, status: 'active', espera: { motivo: 'notification', haMin: 4 },
    turno: 11, contexto: 96_000, custo: 0.92, ferramenta: { nome: 'AskUserQuestion', resumo: 'SQLite ou Postgres' },
    notificacao: 'Claude needs your input', pergunta: { texto: 'Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker?', opcoes: 3 },
    background: ['npm run dev'],
    plano: [['Ler os testes atuais', 'completed'], ['Decidir o banco', 'in_progress'], ['Escrever os casos de borda', 'pending'], ['Rodar no CI', 'pending']],
    subagentes: [{ tipo: 'Explore', tarefa: 'ler testes', status: 'completed', haMin: 15, duracaoMin: 1 }],
    branch: 'feat/51-testes-de-integracao', semPush: true, issue: { numero: 51, titulo: 'Testes de integração', sub: [0, 3] },
  },
  p3: {
    titulo: 'Migração do esquema de pedidos', projeto: 'motor-de-regras', modelo: OPUS, inicioMin: 34, status: 'active', espera: { motivo: 'notification', haMin: 2 },
    turno: 22, contexto: 108_000, custo: 2.1, ferramenta: { nome: 'Bash', resumo: 'npm run migrate' }, notificacao: 'Claude needs your permission to use Bash',
    plano: [['Mapear as tabelas', 'completed'], ['Escrever a migração', 'completed'], ['Testar a volta', 'completed'], ['Revisar índices', 'completed'], ['Aplicar a migração', 'in_progress'], ['Atualizar o seed', 'pending']],
    subagentes: [{ tipo: 'Explore', tarefa: 'esquema atual', status: 'completed', haMin: 20, duracaoMin: 7 }],
    branch: 'feat/58-esquema-de-pedidos', issue: { numero: 58, titulo: 'Esquema de pedidos', sub: [3, 5], pr: { numero: 91, ci: 'SUCCESS', review: 'REVIEW_REQUIRED' } },
  },
  p4: {
    titulo: 'Separar pagamentos em serviços', projeto: 'vitrine-demo', modelo: OPUS, inicioMin: 28, status: 'active', turno: 9, contexto: 114_000, custo: 3.47,
    ferramenta: { nome: 'Agent', resumo: '3 subagentes em paralelo' },
    plano: [['Mapear o módulo', 'completed'], ['Desenhar os serviços', 'completed'], ['Extrair a cobrança', 'in_progress'], ['Migrar os testes', 'pending'], ['Ajustar o deploy', 'pending'], ['Remover o código velho', 'pending']],
    anteriores: [
      { desdeMin: 27, duracaoMin: 4, passos: [['Ler o módulo de pagamentos', 'completed'], ['Listar os acoplamentos', 'completed']] },
      { desdeMin: 22, duracaoMin: 6, passos: [['Separar por camadas', 'completed'], ['Mover os adaptadores', 'pending'], ['Trocar as injeções', 'pending']] },
      { desdeMin: 15, duracaoMin: 5, passos: [['Escrever a decisão de serviços', 'completed'], ['Revisar com o time', 'completed']] },
    ],
    subagentes: [
      { tipo: 'Explore', tarefa: 'achar usos', status: 'working', haMin: 1 },
      { tipo: 'code-reviewer', tarefa: 'diff', status: 'working', haMin: 0.7 },
      { tipo: 'test-runner', tarefa: 'bateria', status: 'working', haMin: 0.2 },
      { tipo: 'Plan', tarefa: 'plano', status: 'completed', haMin: 20, duracaoMin: 3 },
    ],
    filhas: ['fila-de-tarefas', 'catalogo-exemplo', 'blog-estatico'],
    branch: 'feat/63-separar-pagamentos', issue: { numero: 63, titulo: 'Separar pagamentos', sub: [2, 6], pr: { numero: 90, ci: 'PENDING', review: 'APPROVED' } },
  },
  p5: {
    titulo: 'Relatório mensal mais rápido', projeto: 'painel-de-metricas', modelo: OPUS, inicioMin: 58, status: 'error', turno: 23, contexto: 168_000, custo: 4.1,
    erro: { texto: 'API 529 · overloaded_error. Parou depois de 3 tentativas, em Edit src/relatorio/consulta.ts', haMin: 3 },
    ferramenta: { nome: 'Edit', resumo: 'src/relatorio/consulta.ts' }, background: ['npm test -- --watch'],
    plano: [['Medir a consulta', 'completed'], ['Criar os índices', 'completed'], ['Cachear o total', 'completed'], ['Reescrever a consulta', 'in_progress']],
    subagentes: [{ tipo: 'test-runner', tarefa: 'bateria', status: 'error', haMin: 5, duracaoMin: 2 }, { tipo: 'Explore', tarefa: 'índices', status: 'completed', haMin: 30, duracaoMin: 1 }],
    branch: 'feat/47-acelerar-o-relatorio', issue: { numero: 47, titulo: 'Acelerar o relatório', sub: [3, 4], pr: { numero: 88, ci: 'FAILURE', review: 'CHANGES_REQUESTED' } },
  },
  p6: {
    titulo: 'Sessão nova, sem transcript', projeto: 'cli-de-notas', modelo: SONNET, inicioMin: 0, status: 'active', espera: { motivo: 'session_start', haMin: 0 },
    turno: 0, contexto: 0, custo: 0, branch: 'main',
  },
  p7: {
    titulo: 'Kanban de sessões no artefato', projeto: 'ahrena-demo', modelo: OPUS, inicioMin: 12, status: 'active', turno: 18,
    contexto: 62_000, custo: 1.84, ferramenta: { nome: 'Bash', resumo: 'npm test' }, background: ['npm run dev', 'npm run watch'],
    branch: 'feat/42-kanban-de-sessoes', issue: { numero: 42, titulo: 'Kanban de sessões', sub: [2, 4], pr: { numero: 78, rascunho: true, ci: 'SUCCESS', review: null } },
  },
};

// P9: a sessão do P1, aberta há mais tempo, com as decisões dela e da sessão mãe (semearDecisoesDoPainel).
const estaDo = (c: CenarioDoPainel): Esta => (c === 'p9' ? { ...ESTA.p1, inicioMin: 45 } : ESTA[c]);

const OUTRAS: Record<CenarioDoPainel, Outra[]> = {
  p1: [PERMISSAO, INTERROMPIDA],
  p2: [],
  p3: [{ ...INTERROMPIDA, relacao: 'mae' }],
  p4: [{ ...SUA_VEZ, relacao: 'filha' }, { slug: 'catalogo-exemplo', modelo: SONNET, conta: 'equipe', status: 'active', relacao: 'filha', updatedMin: 6 }, { slug: 'blog-estatico', modelo: SONNET, conta: 'equipe', status: 'completed', relacao: 'filha', updatedMin: 20 }],
  p5: [PERMISSAO, INTERROMPIDA],
  p6: [PERMISSAO, INTERROMPIDA, COM_ERRO],
  p7: [{ ...PERMISSAO, relacao: 'mae' }, COM_ERRO, { ...SUA_VEZ, relacao: 'filha' }],
  // As duas últimas só existem para a página Decisões (C21): sessões encerradas, fora do "precisam de você".
  p9: [PERMISSAO, INTERROMPIDA, { slug: 'vitrine-demo', titulo: 'Kanban da vitrine', modelo: OPUS, conta: 'equipe', status: 'completed', updatedMin: 7 }, { ...COM_ERRO, titulo: 'Relatório mensal mais rápido', status: 'completed', erro: undefined, updatedMin: 39 }],
};

/** O que o git e o GitHub falsos respondem no cenário em uso. */
const estado: { cwd: string | null; esta: Esta | null } = { cwd: null, esta: null };

const iso = (agora: number, minAtras: number) => new Date(agora - minAtras * MIN).toISOString();

function sessaoBase(id: string, cwd: string, model: string, inicio: string, atualizada: string): Session {
  return {
    id, name: null, status: 'active', cwd, model, source: 'startup', startedAt: inicio, endedAt: null,
    awaitingInputSince: null, awaitingReason: null, updatedAt: atualizada, accountId: null, accountSource: null, metadata: { simulado: true },
  };
}

function agente(id: string, sessionId: string, tipo: Agent['type'], inicio: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, sessionId, name: null, type: tipo, subagentType: null, status: 'working', task: null, currentTool: null,
    parentAgentId: null, startedAt: inicio, endedAt: null, updatedAt: inicio, metadata: { simulado: true }, ...extra,
  };
}

let seq = 0;
async function evento(porta: StoragePort, sessionId: string, agentId: string | null, createdAt: string, type: string, toolName: string | null, summary: string | null, data: unknown = null) {
  const e = { id: `${sessionId}-e${String(++seq).padStart(4, '0')}`, sessionId, agentId, type, toolName, summary, data, createdAt };
  await porta.appendEvent(e);
  return e;
}

// Mensagens do assistente com uso, para o custo e os tokens saírem pelo caminho de verdade
// (parcelas e buckets). O output de cada uma é calculado para somar perto de `custo`, com o
// preço padrão do modelo (US$ por milhão: Opus 5.5 4/20 e leitura de cache 0,2; Sonnet 5.5 2/10 e 0,1).
async function uso(porta: StoragePort, sessionId: string, model: string, inicio: number, fim: number, contexto: number, custo: number) {
  if (custo <= 0) return;
  const [pin, pout, pread] = model === OPUS ? [4, 20, 0.2] : [2, 10, 0.1];
  const n = 16;
  const input = 1_500;
  let fixo = 0;
  const leituras: number[] = [];
  for (let i = 0; i < n; i++) {
    // Cresce até o contexto final, sem passar dele: passar de 200 mil mudaria a janela (#140).
    const leitura = Math.round(((i + 1) / n) * (contexto - 2_000) + 1_000);
    leituras.push(leitura);
    fixo += (input * pin + leitura * pread) / 1e6;
  }
  const output = Math.max(50, Math.round(((custo - fixo) / n / pout) * 1e6));
  const total = emptyTokenCounts();
  for (let i = 0; i < n; i++) {
    const tokens = { input, output, cacheRead: leituras[i], cacheWrite5m: 0, cacheWrite1h: 0 };
    if (i === n - 1) tokens.cacheRead = Math.max(0, contexto - input - output);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += tokens[k];
    const em = new Date(inicio + ((fim - inicio) * (i + 1)) / (n + 1)).toISOString();
    await evento(porta, sessionId, `${sessionId}:main`, em, 'AssistantMessage', null, null, {
      usage: { messageId: `${sessionId}-m${i}`, requestId: null, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens, webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0 },
    });
  }
  const bucket: TokenUsage = {
    sessionId, model, speed: 'standard', inferenceGeo: '', serviceTier: 'standard', contextSize: '', tokens: total,
    webSearchRequests: 0, webFetchRequests: 0, codeExecutionRequests: 0, baseline: emptyTokenCounts(), updatedAt: new Date(fim).toISOString(),
  };
  await porta.putTokenUsage(bucket);
}

async function gravarEsta(porta: StoragePort, e: Esta, agora: number, filhas: string[]) {
  const id = SESSAO_DO_PAINEL;
  const cwd = `${RAIZ}/${e.projeto}`;
  const inicio = iso(agora, e.inicioMin);
  const s = sessaoBase(id, cwd, e.modelo, inicio, iso(agora, 0.05));
  s.name = e.titulo;
  s.status = e.status;
  if (e.espera) {
    s.awaitingInputSince = iso(agora, e.espera.haMin);
    s.awaitingReason = e.espera.motivo;
  }
  const background = Object.fromEntries((e.background ?? []).map((c, i) => [`bg-${i}`, { desde: inicio, comando: c }]));
  s.accountId = CONTAS.equipe.id;
  s.accountSource = CONTAS.equipe.source;
  s.metadata = {
    simulado: true,
    familia: { filhas: filhas.map((slug) => `sim-painel-${slug}`) },
    estados: { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: e.erro ? iso(agora, e.erro.haMin) : null, delegacoes: {}, background },
  };
  if (e.inicioMin === 0 && e.turno === 0) return; // P6: o núcleo ainda não viu a sessão
  await porta.putSession(s);

  const tool = e.status === 'active' && !e.espera ? (e.ferramenta?.nome ?? null) : null;
  await porta.putAgent(agente(`${id}:main`, id, 'main', inicio, { currentTool: tool, status: e.espera ? 'waiting' : e.status === 'error' ? 'error' : 'working' }));
  for (const [i, sub] of (e.subagentes ?? []).entries()) {
    const desde = iso(agora, sub.haMin + (sub.duracaoMin ?? 0));
    await porta.putAgent(
      agente(`${id}:a${i}`, id, 'subagent', desde, {
        subagentType: sub.tipo, name: sub.tarefa, status: sub.status, endedAt: sub.status === 'working' ? null : iso(agora, sub.haMin),
      }),
    );
  }

  const t0 = Date.parse(inicio);
  for (let i = 0; i < e.turno; i++) await evento(porta, id, null, new Date(t0 + (i * (agora - t0)) / (e.turno + 1)).toISOString(), 'UserPromptSubmit', null, 'prompt');
  await uso(porta, id, e.modelo, t0, agora - 0.5 * MIN, e.contexto, e.custo);
  if (e.plano) {
    // Cada plano anterior entra pendente e sai como acabou; o atual começa logo depois do último.
    // O plano vem antes da última ferramenta, que é a que pede permissão ou pergunta.
    const todoWrite = (min: number, passos: Passos, pendente = false) => {
      const todos = passos.map(([content, status]) => ({ content, status: pendente ? 'pending' : status, activeForm: content }));
      return evento(porta, id, null, iso(agora, min), 'PreToolUse', 'TodoWrite', 'plano', { tool_name: 'TodoWrite', tool_input: { todos }, tool_use_id: `${id}-plano-${seq}` });
    };
    const eventos = [];
    for (const a of e.anteriores ?? []) eventos.push(await todoWrite(a.desdeMin, a.passos, true), await todoWrite(a.desdeMin - a.duracaoMin, a.passos));
    const ultimo = e.anteriores?.at(-1);
    if (ultimo) eventos.push(await todoWrite(ultimo.desdeMin - ultimo.duracaoMin - 0.5, e.plano, true));
    eventos.push(await todoWrite((e.espera?.haMin ?? 0.3) + 0.2, e.plano));
    await atualizarPlano(porta, id, eventos);
  }
  if (e.ferramenta) {
    const entrada = e.pergunta ? { questions: [{ question: e.pergunta.texto, options: Array.from({ length: e.pergunta.opcoes }, (_, k) => ({ label: `opção ${k + 1}` })) }] } : { command: e.ferramenta.resumo };
    await evento(porta, id, null, iso(agora, e.espera?.haMin ?? 0.3), 'PreToolUse', e.ferramenta.nome, e.ferramenta.resumo, { tool_name: e.ferramenta.nome, tool_input: entrada });
  }
  if (e.notificacao) await evento(porta, id, null, iso(agora, e.espera?.haMin ?? 0), 'Notification', null, e.notificacao, { notification_type: e.pergunta ? 'elicitation_dialog' : 'permission_prompt' });
  if (e.erro) await evento(porta, id, null, iso(agora, e.erro.haMin), 'APIError', null, e.erro.texto);
}

async function gravarOutra(porta: StoragePort, o: Outra, agora: number) {
  const id = `sim-painel-${o.slug}`;
  const atualizada = iso(agora, o.updatedMin ?? o.espera?.haMin ?? 1);
  const s = sessaoBase(id, `${RAIZ}/${o.slug}`, o.modelo, iso(agora, 40), atualizada);
  s.name = o.titulo ?? o.slug;
  s.status = o.status;
  if (o.status === 'completed') s.endedAt = atualizada;
  if (o.espera) {
    s.awaitingInputSince = iso(agora, o.espera.haMin);
    s.awaitingReason = o.espera.motivo;
  }
  s.accountId = CONTAS[o.conta].id;
  s.accountSource = CONTAS[o.conta].source;
  s.metadata = {
    simulado: true,
    familia: o.relacao === 'filha' ? { mae: SESSAO_DO_PAINEL } : {},
    estados: { ultimoEvento: null, idsNoUltimoInstante: [], erroEm: o.status === 'error' ? atualizada : null, delegacoes: {}, background: {} },
  };
  await porta.putSession(s);
  await porta.putAgent(agente(`${id}:main`, id, 'main', s.startedAt, { status: o.espera ? 'waiting' : o.status === 'completed' ? 'completed' : 'working' }));
  if (o.ferramenta) await evento(porta, id, null, s.awaitingInputSince ?? atualizada, 'PreToolUse', o.ferramenta.nome, o.ferramenta.resumo, { tool_name: o.ferramenta.nome, tool_input: { command: o.ferramenta.resumo } });
  if (o.espera?.motivo === 'notification') await evento(porta, id, null, s.awaitingInputSince!, 'Notification', null, o.texto ?? null, { notification_type: 'permission_prompt' });
  if (o.espera?.motivo === 'stop' && o.texto) await evento(porta, id, `${id}:main`, s.awaitingInputSince!, 'AssistantMessage', null, o.texto);
  if (o.erro) await evento(porta, id, null, atualizada, 'APIError', null, o.erro);
}

/** Grava o cenário pela porta. A mãe de "esta sessão" (relação `mae`) é ligada pelos metadados. */
export async function semearCenariosDoPainel(porta: StoragePort, cenario: CenarioDoPainel = 'p1', agora = Date.now()): Promise<void> {
  const e = estaDo(cenario);
  const outras = OUTRAS[cenario];
  for (const c of Object.values(CONTAS)) {
    await porta.putAccount({
      id: c.id, accountUuid: c.accountUuid, organizationUuid: c.organizationUuid, organizationName: null, organizationType: c.tipo,
      label: c.label, color: c.color, configDirs: [], firstSeenAt: iso(agora, 60), lastSeenAt: iso(agora, 0), metadata: { simulado: true },
    });
  }
  const filhas = [...(e.filhas ?? []), ...outras.filter((o) => o.relacao === 'filha' && !(e.filhas ?? []).includes(o.slug)).map((o) => o.slug)];
  await gravarEsta(porta, e, agora, filhas);
  const mae = outras.find((o) => o.relacao === 'mae');
  if (mae) {
    const s = await porta.getSession(SESSAO_DO_PAINEL);
    if (s) await porta.putSession({ ...s, metadata: { ...s.metadata, familia: { ...(s.metadata.familia as object), mae: `sim-painel-${mae.slug}` } } });
  }
  for (const o of outras) await gravarOutra(porta, o, agora);
  estado.cwd = `${RAIZ}/${e.projeto}`;
  estado.esta = e;
}

/** GitHub falso do cenário: a issue e o PR de "esta sessão", e nada mais. */
export class FonteDeTrabalhoDoSimulador implements WorkSource {
  /** git falso: o branch, o remote e o upstream do cenário. */
  static git = async (_cwd: string, args: string[]): Promise<string | null> => {
    const e = estado.esta;
    if (!e) return null;
    if (args[0] === 'branch') return e.branch;
    if (args[0] === 'remote') return `https://github.com/${REPO_DO_SIMULADOR}.git`;
    if (args[0] === 'rev-parse') return e.semPush ? null : `origin/${e.branch}`;
    return null;
  };

  private no(): WorkNode | null {
    const i = estado.esta?.issue;
    if (!i) return null;
    return {
      key: `${REPO_DO_SIMULADOR}#${i.numero}`, repo: REPO_DO_SIMULADOR, number: i.numero, title: i.titulo,
      url: `https://github.com/${REPO_DO_SIMULADOR}/issues/${i.numero}`, state: 'OPEN', updatedAt: new Date().toISOString(),
      type: 'User Story', parent: null, progress: i.sub ? { completed: i.sub[0], total: i.sub[1], percent: Math.round((i.sub[0] / i.sub[1]) * 100) } : null,
    };
  }

  async listShallow(): Promise<WorkNode[]> {
    const n = this.no();
    return n ? [n] : [];
  }
  async nodes(keys: readonly string[]): Promise<WorkNode[]> {
    const n = this.no();
    return n && keys.includes(n.key) ? [n] : [];
  }
  async children(): Promise<ChildrenResult> {
    return { children: [], details: [] };
  }
  async detail(key: string): Promise<WorkDetail> {
    const pr = estado.esta?.issue?.pr;
    const prs: LinkedPullRequest[] = pr
      ? [{ number: pr.numero, url: `https://github.com/${REPO_DO_SIMULADOR}/pull/${pr.numero}`, state: 'OPEN', isDraft: !!pr.rascunho, review: pr.review, ci: pr.ci, checks: CHECKS_DO_P1[pr.ci ?? ''] ?? null }]
      : [];
    return { key, state: 'OPEN', pullRequests: prs, stage: stageOf('OPEN', prs) };
  }
}

/** A sessão mãe do P9: a de ontem, antes do /clear. Só existe na porta das decisões. */
export const MAE_DO_P9 = 'sim-painel-kanban-ontem';

/**
 * As decisões do P9, pela porta das decisões e pelas regras de lá (número, cadeia, família):
 * a sessão mãe decidiu ontem; esta, ligada a ela por /clear, decidiu o resto. Textos sintéticos.
 * Com elas, as outras três famílias da página Decisões (C21). Nos outros cenários, nada.
 */
export async function semearDecisoesDoPainel(porta: DecisionPort, cenario: CenarioDoPainel = 'p1', agora = Date.now()): Promise<void> {
  if (cenario !== 'p9') return;
  const repo = `${RAIZ}/${ESTA.p1.projeto}`;
  const branch = ESTA.p1.branch;
  const agoraIso = iso(agora, 0);
  let n = 0;
  const decidir = (sessionId: string, haMin: number, d: Pick<DecisionDraft, 'origin' | 'choice' | 'alternatives' | 'topic'> & Partial<DecisionDraft>) =>
    registerDecision(
      porta,
      {
        sourceKey: `sim:p9:${++n}`, sessionId, agentId: `${sessionId}:main`, repo, branch, context: null, decidedBy: 'usuario', inferred: false,
        message: { toolUseId: `sim-toolu-p9-${n}` }, decidedAt: iso(agora, haMin), metadata: { simulado: true }, ...d,
      },
      agoraIso,
    );
  await decidir(MAE_DO_P9, 20 * 60, { origin: 'pergunta', topic: 'pergunta:kanban arrasta', choice: 'Kanban só leitura, sem arrastar', alternatives: ['arrastar muda o status'] });
  await linkSession(porta, { sessionId: SESSAO_DO_PAINEL, parentSessionId: MAE_DO_P9, reason: 'clear', linkedAt: iso(agora, 45) }, agoraIso);
  await decidir(SESSAO_DO_PAINEL, 40, { origin: 'plano', topic: 'plano', choice: 'Plano de 5 passos aprovado', alternatives: ['plano com drag-and-drop'] });
  await decidir(SESSAO_DO_PAINEL, 33, { origin: 'pergunta', topic: 'pergunta:banco nos testes', choice: 'Postgres no Docker nos testes', alternatives: ['SQLite em memória'] });
  await decidir(SESSAO_DO_PAINEL, 14, { origin: 'correcao', topic: 'pergunta:banco nos testes', choice: 'SQLite em memória nos testes', alternatives: ['Postgres no Docker'] });
  await decidir(SESSAO_DO_PAINEL, 21, { origin: 'permissao', topic: 'permissao:Bash npm test', choice: 'Permitir npm test sem perguntar', alternatives: ['perguntar a cada vez'] });
  await decidir(SESSAO_DO_PAINEL, 6, {
    origin: 'sugerida', decidedBy: 'agente', inferred: true, topic: 'kanban:cards por coluna',
    choice: '10 cards por coluna, com "mostrar mais"', alternatives: ['20 por coluna', 'rolagem infinita'],
  });
  await semearDecisoesDaPagina(porta, agora);
}

/** Os registros a que a demonstração já promoveu decisões, por pasta sob /simulacao. */
const REGISTROS_DA_DEMO = {
  'vitrine-demo': ['0003-kanban-por-long-polling.md'],
  'motor-de-regras': ['0004-cobranca-em-servico-a-parte.md', '0005-contrato-da-cobranca-primeiro.md'],
  'painel-de-metricas': ['0006-cache-do-total-do-mes.md'],
  'ahrena-demo': [],
} as const;
const registro = (pasta: keyof typeof REGISTROS_DA_DEMO, i: number) => `docs/decisoes/${REGISTROS_DA_DEMO[pasta][i]}`;

/**
 * Para o "Promover a registro" da --demo gravar de verdade sem tocar em nada da máquina: uma pasta
 * por repositório sintético, sob `base` (uma pasta temporária), com `docs/decisoes` e os registros
 * já promovidos (só o título). Devolve a troca de `/simulacao/<pasta>` pela pasta de verdade.
 */
export function pastasDosRegistrosDaDemo(base: string): (repo: string) => string | null {
  for (const [pasta, nomes] of Object.entries(REGISTROS_DA_DEMO)) {
    const dir = join(base, pasta, 'docs', 'decisoes');
    mkdirSync(dir, { recursive: true });
    for (const nome of nomes) writeFileSync(join(dir, nome), `# ${nome.slice(0, 4)} · registro sintético da demonstração\n`);
  }
  return (repo) => {
    const pasta = repo.startsWith(`${RAIZ}/`) ? repo.slice(RAIZ.length + 1) : null;
    return pasta && pasta in REGISTROS_DA_DEMO ? join(base, pasta) : null;
  };
}

/** A sessão mãe da vitrine: a de ontem, antes do /clear. Só existe na porta das decisões. */
export const MAE_DA_VITRINE = 'sim-painel-vitrine-ontem';

type Rascunho = Pick<DecisionDraft, 'origin' | 'choice' | 'alternatives' | 'topic'> & Partial<DecisionDraft> & { haMin: number; promovida?: string };

/**
 * As outras três famílias da página Decisões (C21, docs/wireframes/capturas/console-decisoes.png),
 * cada uma num branch e numa pasta: `feat/42-kanban` (vitrine-demo, com a mãe de ontem),
 * `refactor/pagamentos` (motor-de-regras) e `perf/47-relatorio` (painel-de-metricas), com vigentes,
 * substituídas, promovidas a registro e a confirmar. Em ordem de `decidedAt`, para o número
 * na família (D1, D2…) seguir o tempo. Os caminhos dos registros são fictícios, como as pastas.
 */
async function semearDecisoesDaPagina(porta: DecisionPort, agora: number): Promise<void> {
  const agoraIso = iso(agora, 0);
  let n = 0;
  const decidir = async (sessionId: string, repo: string, branch: string, d: Rascunho) => {
    const { haMin, promovida, ...resto } = d;
    const { decision } = await registerDecision(
      porta,
      {
        sourceKey: `sim:c21:${++n}`, sessionId, agentId: `${sessionId}:main`, repo, branch, context: null, decidedBy: 'usuario', inferred: false,
        message: { toolUseId: `sim-toolu-c21-${n}` }, decidedAt: iso(agora, haMin), metadata: { simulado: true }, ...resto,
      },
      agoraIso,
    );
    if (promovida) await markPromoted(porta, decision.id, promovida, agoraIso);
  };

  const vitrine = (sessionId: string, d: Rascunho) => decidir(sessionId, `${RAIZ}/vitrine-demo`, 'feat/42-kanban', d);
  const kanban = 'sim-painel-vitrine-demo';
  await vitrine(MAE_DA_VITRINE, { haMin: 26 * 60, origin: 'pergunta', topic: 'kanban:arrastar', choice: 'Cards só leitura, sem arrastar', alternatives: ['arrastar muda o status'] });
  await linkSession(porta, { sessionId: kanban, parentSessionId: MAE_DA_VITRINE, reason: 'clear', linkedAt: iso(agora, 60) }, agoraIso);
  await vitrine(kanban, { haMin: 50, origin: 'plano', topic: 'plano', choice: 'Plano de 4 passos aprovado', alternatives: ['plano com drag-and-drop'], scope: 'sessao' });
  await vitrine(kanban, { haMin: 45, origin: 'pergunta', topic: 'kanban:banco', choice: 'Postgres no Docker nos testes', alternatives: ['SQLite em memória'], scope: 'sessao' });
  await vitrine(kanban, { haMin: 30, origin: 'permissao', topic: 'permissao:Bash npm run build', choice: 'Permitir npm run build sem perguntar', alternatives: ['perguntar a cada vez'], scope: 'sessao' });
  await vitrine(kanban, {
    haMin: 25, origin: 'pergunta', topic: 'kanban:atualizar', choice: 'Kanban atualiza por long polling', alternatives: ['recarregar a cada 5 s'], scope: 'branch',
    promovida: registro('vitrine-demo', 0),
  });
  await vitrine(kanban, { haMin: 20, origin: 'pergunta', topic: 'kanban:card', choice: 'Card com 3 linhas: título, branch e PR', alternatives: ['card com o resumo da conversa'] });
  await vitrine(kanban, { haMin: 16, origin: 'correcao', topic: 'kanban:banco', choice: 'SQLite em memória nos testes', alternatives: ['Postgres no Docker'], scope: 'sessao' });
  await vitrine(kanban, {
    haMin: 8, origin: 'sugerida', decidedBy: 'agente', inferred: true, topic: 'kanban:encerradas', scope: 'sessao',
    choice: 'Esconder sessões encerradas há mais de 7 dias', alternatives: ['mostrar todas'],
  });

  const pagamentos = (d: Rascunho) => decidir('sim-painel-motor-de-regras', `${RAIZ}/motor-de-regras`, 'refactor/pagamentos', d);
  await pagamentos({
    haMin: 60, origin: 'pergunta', topic: 'pagamentos:cobranca', choice: 'Cobrança vira um serviço à parte', alternatives: ['manter no módulo de pagamentos'],
    promovida: registro('motor-de-regras', 0),
  });
  await pagamentos({ haMin: 50, origin: 'pergunta', topic: 'pagamentos:pr', choice: 'Abrir o PR direto', alternatives: ['review antes do PR'] });
  await pagamentos({
    haMin: 40, origin: 'plano', topic: 'plano', choice: 'Contrato da API de cobrança antes do código', alternatives: ['começar pelo código'],
    promovida: registro('motor-de-regras', 1),
  });
  await pagamentos({ haMin: 35, origin: 'pergunta', topic: 'pagamentos:eventos', choice: 'Eventos de cobrança pela fila', alternatives: ['chamada direta entre serviços'], scope: 'branch' });
  await pagamentos({ haMin: 27, origin: 'correcao', topic: 'pagamentos:pr', choice: 'Review por code-reviewer antes do PR', alternatives: ['abrir o PR direto'] });

  const relatorio = (d: Rascunho) => decidir('sim-painel-painel-de-metricas', `${RAIZ}/painel-de-metricas`, 'perf/47-relatorio', d);
  await relatorio({ haMin: 90, origin: 'plano', topic: 'plano', choice: 'Medir antes de otimizar', alternatives: ['reescrever a consulta direto'] });
  await relatorio({ haMin: 70, origin: 'pergunta', topic: 'relatorio:granularidade', choice: 'Consulta por dia', alternatives: ['consulta por mês'] });
  await relatorio({ haMin: 55, origin: 'correcao', topic: 'relatorio:granularidade', choice: 'Consulta por mês, não por dia', alternatives: ['consulta por dia'] });
  await relatorio({
    haMin: 45, origin: 'pergunta', topic: 'relatorio:cache', choice: 'Cachear o total do mês por 5 min', alternatives: ['sem cache'], scope: 'branch',
    promovida: registro('painel-de-metricas', 0),
  });
  await relatorio({
    haMin: 40, origin: 'sugerida', decidedBy: 'agente', inferred: true, topic: 'relatorio:indice', scope: 'sessao',
    choice: 'Índice composto em (mes, conta)', alternatives: ['view materializada'],
  });
}
