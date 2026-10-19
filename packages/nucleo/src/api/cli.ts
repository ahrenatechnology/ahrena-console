#!/usr/bin/env node
// Sobe a API local do núcleo: importa o histórico, segue os transcripts, recebe os hooks, roda a
// máquina de estados e responde ao painel, tudo em 127.0.0.1. `npm run api -- --help`.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { HookDecisionCapture } from '../decisoes/captura-hooks.ts';
import { SqliteDecisionStore } from '../decisoes/sqlite.ts';
import { MaquinaDeEstados } from '../estados/maquina.ts';
import { GithubCache } from '../github/cache.ts';
import { ghCliToken, GithubGraphqlSource } from '../github/github-source.ts';
import { SqliteCacheStore } from '../github/sqlite-cache.ts';
import { defaultProjectsRoot } from '../ingest/historico/files.ts';
import { followTranscripts } from '../ingest/historico/follower.ts';
import {
  CENARIOS_DO_PAINEL,
  FonteDeTrabalhoDoSimulador,
  SESSAO_DO_PAINEL,
  semearCenariosDoPainel,
  semearDecisoesDoPainel,
  type CenarioDoPainel,
} from '../simulador/painel.ts';
import { Contas } from './contas.ts';
import { IndiceDoDesktop } from './indice-desktop.ts';
import { MontadorDoPainel } from './painel.ts';
import { capturarDoTranscript, LIMPEZA_DAS_DECISOES, limparDecisoes, REPROCESSAMENTO, reprocessarHistorico } from './reprocessamento.ts';
import { iniciarApiLocal } from './servidor.ts';
import { TrabalhoPorBranch } from './trabalho.ts';

const AJUDA = `Uso: npm run api -- [opções]

  --porta <n>         Porta em 127.0.0.1. Padrão AHRENA_CONSOLE_PORT ou 4720
  --banco <arquivo>   SQLite do núcleo. Padrão AHRENA_CONSOLE_DB ou ~/.ahrena-console/nucleo.sqlite
  --projetos <pasta>  Transcripts a seguir. Padrão ~/.claude/projects
  --sem-historico     Não importa nem segue transcripts (só hooks)
  --varredura <s>     Varredura de reserva do seguidor, em segundos. Padrão 30: o fs.watch
                      avisa cada escrita na hora; a varredura só cobre o aviso perdido
  --sem-desktop       Não lê o índice de sessões do Claude Desktop
  --sem-github        O trabalho mostra só o branch, sem chamar o GitHub
  --demo              Banco em memória com um cenário do painel do simulador, sem histórico,
                      sem Desktop e sem GitHub: só dados sintéticos. A sessão do painel,
                      seja qual for, mostra o cenário
  --cenario <p1..p9>  O cenário da demonstração (padrão p1), como nos wireframes
  --help
`;

const { values: o } = parseArgs({
  options: {
    porta: { type: 'string' },
    banco: { type: 'string' },
    projetos: { type: 'string' },
    varredura: { type: 'string', default: '30' },
    'sem-historico': { type: 'boolean', default: false },
    'sem-desktop': { type: 'boolean', default: false },
    'sem-github': { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    cenario: { type: 'string', default: 'p1' },
    help: { type: 'boolean', default: false },
  },
});
if (o.help) {
  process.stdout.write(AJUDA);
  process.exit(0);
}

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
const porta = Number(o.porta ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
const demo = o.demo;
const banco = demo ? ':memory:' : (o.banco ?? process.env.AHRENA_CONSOLE_DB ?? join(homedir(), '.ahrena-console', 'nucleo.sqlite'));
if (banco !== ':memory:') mkdirSync(dirname(banco), { recursive: true });

const storage = openSqliteStorage({ path: banco });
// As decisões da sessão (#99) no mesmo banco: os hooks capturam, o painel lê e confirma (#102).
const decisoes = new SqliteDecisionStore(storage.db);
const captura = new HookDecisionCapture({ decisions: decisoes });
const maquina = new MaquinaDeEstados({ storage, log, ...(demo ? { sonda: null } : {}) });
const desktop = demo || o['sem-desktop'] ? null : new IndiceDoDesktop();
const fonte = demo ? new FonteDeTrabalhoDoSimulador() : o['sem-github'] ? null : new GithubGraphqlSource({ token: () => ghCliToken() });
const trabalho = new TrabalhoPorBranch({
  fonte,
  cache: new GithubCache({ store: new SqliteCacheStore(storage.db) }),
  ...(demo ? { git: FonteDeTrabalhoDoSimulador.git } : {}),
});
// O commit do checkout da API, para o rodapé do painel dizer qual versão está no ar.
function commitDoCheckout(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const montador = new MontadorDoPainel({
  commit: commitDoCheckout(),
  storage,
  contas: new Contas({ storage, ...(demo ? { arquivo: null } : {}) }),
  desktop,
  trabalho,
  decisoes,
  ...(demo ? { apelido: () => SESSAO_DO_PAINEL } : {}),
});

if (demo) {
  const cenario = o.cenario as CenarioDoPainel;
  if (!CENARIOS_DO_PAINEL.includes(cenario)) throw new Error(`--cenario: um de ${CENARIOS_DO_PAINEL.join(', ')}`);
  await semearCenariosDoPainel(storage, cenario);
  await semearDecisoesDoPainel(decisoes, cenario);
}

let historicoPronto = false;
const follower =
  demo || o['sem-historico']
    ? null
    : followTranscripts({
        storage,
        root: o.projetos,
        scanIntervalMs: Math.max(1, Number(o.varredura) || 30) * 1000,
        // As decisões que só o transcript traz (respostas, planos, recusas), também de sessões sem hook.
        onSession: (sessao) => capturarDoTranscript(decisoes, sessao).then(() => undefined),
        onError: (e) => log(`seguidor: ${(e as Error).message}`),
      });

const api = await iniciarApiLocal({
  montador,
  hooks: {
    storage,
    onEvent: async (r) => {
      await maquina.aoReceberHook(r);
      await captura.onEvent(r.event);
    },
    log,
  },
  port: porta,
  log,
  carga: () => ({
    historico: follower ? (historicoPronto ? 'pronto' : 'importando') : 'desligado',
    seguidor: follower?.stats() ?? null,
    desktopLidos: desktop?.lidos ?? 0,
    trabalho: trabalho.chamadas,
  }),
});
log(`API local em ${api.url}${demo ? ` (demo ${o.cenario}: dados sintéticos do simulador)` : ` · banco ${banco}`}`);

// A importação inicial roda depois que a porta já responde: o painel não espera o histórico.
const pararVigia = demo ? () => {} : maquina.iniciar();
if (follower) {
  follower
    .start()
    .then(() => {
      historicoPronto = true;
      log(`histórico importado; seguindo ${o.projetos ?? '~/.claude/projects'}`);
      return reprocessarUmaVez();
    })
    .catch((e) => log(`seguidor não começou: ${(e as Error).message}`));
}

// Uma vez por banco, depois da importação inicial: planos e decisões das sessões importadas antes
// da captura existir, e a limpeza do que a captura antiga gravou e não é decisão.
async function reprocessarUmaVez() {
  if (!storage.reprocessado(REPROCESSAMENTO)) {
    const inicio = Date.now();
    const r = await reprocessarHistorico({ storage, decisoes, raiz: o.projetos ?? defaultProjectsRoot(), log });
    storage.marcarReprocessado(REPROCESSAMENTO, new Date().toISOString());
    log(`reprocessado em ${Math.round((Date.now() - inicio) / 1000)} s: ${r.sessoes} sessões, ${r.planos} planos em ${r.comPlano}, ${r.decisoes} decisões`);
  }
  if (!storage.reprocessado(LIMPEZA_DAS_DECISOES)) {
    const r = await limparDecisoes(storage, decisoes);
    storage.marcarReprocessado(LIMPEZA_DAS_DECISOES, new Date().toISOString());
    log(`decisões limpas: ${r.ruido} fora das listas, ${r.encurtadas} com o título encurtado`);
  }
}

async function desligar() {
  pararVigia();
  await follower?.stop().catch(() => undefined);
  await api.close().catch(() => undefined);
  await storage.close();
  process.exit(0);
}
process.on('SIGINT', () => void desligar());
process.on('SIGTERM', () => void desligar());
