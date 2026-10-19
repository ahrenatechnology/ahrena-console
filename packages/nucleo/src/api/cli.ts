#!/usr/bin/env node
// Sobe a API local do núcleo: importa o histórico, segue os transcripts, recebe os hooks, roda a
// máquina de estados e responde ao painel, tudo em 127.0.0.1. `npm run api -- --help`.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { MaquinaDeEstados } from '../estados/maquina.ts';
import { GithubCache } from '../github/cache.ts';
import { ghCliToken, GithubGraphqlSource } from '../github/github-source.ts';
import { SqliteCacheStore } from '../github/sqlite-cache.ts';
import { followTranscripts } from '../ingest/historico/follower.ts';
import { CENARIOS_DO_PAINEL, FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel, type CenarioDoPainel } from '../simulador/painel.ts';
import { Contas } from './contas.ts';
import { IndiceDoDesktop } from './indice-desktop.ts';
import { MontadorDoPainel } from './painel.ts';
import { iniciarApiLocal } from './servidor.ts';
import { TrabalhoPorBranch } from './trabalho.ts';

const AJUDA = `Uso: npm run api -- [opções]

  --porta <n>         Porta em 127.0.0.1. Padrão AHRENA_CONSOLE_PORT ou 4720
  --banco <arquivo>   SQLite do núcleo. Padrão AHRENA_CONSOLE_DB ou ~/.ahrena-console/nucleo.sqlite
  --projetos <pasta>  Transcripts a seguir. Padrão ~/.claude/projects
  --sem-historico     Não importa nem segue transcripts (só hooks)
  --sem-desktop       Não lê o índice de sessões do Claude Desktop
  --sem-github        O trabalho mostra só o branch, sem chamar o GitHub
  --demo              Banco em memória com um cenário do painel do simulador, sem histórico,
                      sem Desktop e sem GitHub: só dados sintéticos. A sessão do painel,
                      seja qual for, mostra o cenário
  --cenario <p1..p7>  O cenário da demonstração (padrão p1), como nos wireframes
  --help
`;

const { values: o } = parseArgs({
  options: {
    porta: { type: 'string' },
    banco: { type: 'string' },
    projetos: { type: 'string' },
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
const maquina = new MaquinaDeEstados({ storage, log, ...(demo ? { sonda: null } : {}) });
const desktop = demo || o['sem-desktop'] ? null : new IndiceDoDesktop();
const fonte = demo ? new FonteDeTrabalhoDoSimulador() : o['sem-github'] ? null : new GithubGraphqlSource({ token: () => ghCliToken() });
const trabalho = new TrabalhoPorBranch({
  fonte,
  cache: new GithubCache({ store: new SqliteCacheStore(storage.db) }),
  ...(demo ? { git: FonteDeTrabalhoDoSimulador.git } : {}),
});
const montador = new MontadorDoPainel({
  storage,
  contas: new Contas(demo ? { arquivo: null } : {}),
  desktop,
  trabalho,
  ...(demo ? { apelido: () => SESSAO_DO_PAINEL } : {}),
});

if (demo) {
  const cenario = o.cenario as CenarioDoPainel;
  if (!CENARIOS_DO_PAINEL.includes(cenario)) throw new Error(`--cenario: um de ${CENARIOS_DO_PAINEL.join(', ')}`);
  await semearCenariosDoPainel(storage, cenario);
}

let historicoPronto = false;
const follower = demo || o['sem-historico'] ? null : followTranscripts({ storage, root: o.projetos, onError: (e) => log(`seguidor: ${(e as Error).message}`) });

const api = await iniciarApiLocal({
  montador,
  hooks: { storage, onEvent: maquina.aoReceberHook, log },
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
    })
    .catch((e) => log(`seguidor não começou: ${(e as Error).message}`));
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
