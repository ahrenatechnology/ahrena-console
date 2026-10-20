#!/usr/bin/env node
// Sobe a API local do núcleo: importa o histórico, segue os transcripts, recebe os hooks, roda a
// máquina de estados e responde ao painel, tudo em 127.0.0.1. `npm run api -- --help`.
//
// One core per installation (#221, decision 0010, src/owner/): if this installation's core is
// already up (the lock in its data folder), this process adopts it (prints the port and version and
// exits 0) instead of starting another. A core of another installation is never adopted. By default
// the port is 0: the system picks a free one, and the core announces it in the log, in the lock and
// in the instance registry (~/.ahrena-console/instances/).

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { HookDecisionCapture } from '../decisions/capture-hooks.ts';
import { SqliteDecisionStore } from '../decisions/sqlite.ts';
import { SessionStateMachine } from '../states/machine.ts';
import { createMcpServer } from '../mcp/index.ts';
import { GithubCache } from '../github/cache.ts';
import { ghCliToken, GithubGraphqlSource } from '../github/github-source.ts';
import { SqliteCacheStore } from '../github/sqlite-cache.ts';
import { GithubCallQueue } from '../github/call-queue.ts';
import { createGithubProject, GithubProject, type ProjectRef } from '../github/project.ts';
import { defaultProjectsRoot } from '../ingest/history/files.ts';
import { followTranscripts } from '../ingest/history/follower.ts';
import { Profiles } from '../profiles/profiles.ts';
import { registerClient } from '../owner/clients.ts';
import { isOlderCommit } from '../owner/commit.ts';
import { claimLock, codeWarning, planStart, watchParent } from '../owner/owner.ts';
import { waitForCore, isPidAlive, reservePort, releasePort } from '../owner/probe.ts';
import { readLock, releaseLock, prepareDir } from '../owner/lock.ts';
import { defaultDataDir, parseInstallation, resolveDataDir, resolvePort } from '../owner/installation.ts';
import { instanceId, listInstances, removeInstance, writeInstance } from '../owner/registry.ts';
import { acquireStartGuard, type StartGuard } from '../owner/start-guard.ts';
import { ChangeCursor } from '../changes/cursor.ts';
import { onMachineChange, withChanges, SessionAccounts, decisionsWithChanges } from '../changes/sources.ts';
import { waitForChanges } from '../changes/mcp.ts';
import {
  apelidoDaDemo,
  CENARIOS_DO_PAINEL,
  FonteDeTrabalhoDoSimulador,
  pastasDosRegistrosDaDemo,
  semearCenariosDoPainel,
  semearDecisoesDoPainel,
  type CenarioDoPainel,
} from '../simulator/panel.ts';
import { semearWorkflowsDoDemo } from '../simulator/workflows.ts';
import { semearHistoricoDoPainel } from '../simulator/history-ended.ts';
import { SessionHistory } from '../history/reading.ts';
import { PROJECT_DO_SIMULADOR, ProjetoDoSimulador } from '../simulator/project.ts';
import { semearHistorico } from '../simulator/history.ts';
import { localDaDemo, semearDetalhe } from '../simulator/detail.ts';
import { mountDemoAgentConfig, knownProjects } from '../agent-config/index.ts';
import { createAgentConfigRoute } from './agent-config.ts';
import { Contas } from './contas.ts';
import { DecisoesDaUi } from './decisoes-ui.ts';
import { QuadroKanban } from './kanban.ts';
import { LeiturasDoDetalhe } from './detalhe.ts';
import { IndiceDoDesktop } from './indice-desktop.ts';
import { RotaAnalytics } from './rota-analytics.ts';
import { MontadorDoPainel } from './painel.ts';
import {
  capturarDoTranscript,
  LIMPEZA_DAS_DECISOES,
  limparDecisoes,
  REPROCESSAMENTO,
  REPROCESSAMENTO_DO_CONTEXTO,
  reprocessarContexto,
  reprocessarHistorico,
} from './reprocessamento.ts';
import { criarReposDoNucleo } from './repos.ts';
import { createCoreAgentInstructions } from './agent-instructions.ts';
import { iniciarApiLocal, VERSAO_DA_API, type ApiLocal } from './servidor.ts';
import { ListaDeSessoes } from './sessoes.ts';
import { FeedDeEventos } from './eventos.ts';
import { TrabalhoPorBranch } from './trabalho.ts';
import { createDevConsole, disabledDevConsoleSource, GithubDevConsoleSource } from '../dev-console/index.ts';
import { DEV_CONSOLE_SIMULATOR_CONTEXTS, devConsoleSimulatorGit, SimulatedDevConsoleSource } from '../simulator/dev-console.ts';
import { AlertTracker } from '../telemetry/alerts.ts';
import { collectorFor } from '../telemetry/adapters/system.ts';
import { SqliteTelemetryStore } from '../telemetry/adapters/sqlite.ts';
import { publishAlertChanges, TelemetrySampler } from '../telemetry/sampler.ts';
import { localMachine, TelemetryService, type MachineEntry } from '../telemetry/service.ts';
import { loadMachinesConfig } from '../telemetry/machines-config.ts';
import { publishRemoteAttentionChanges, RemoteMachine } from '../telemetry/remote.ts';
import { loopbackGet } from '../telemetry/adapters/loopback-http.ts';
import type { TelemetryCollector } from '../telemetry/ports.ts';
import { SIMULATED_WORKSTATION, SimulatedCollector, seedTelemetry } from '../simulator/telemetry.ts';

const AJUDA = `Uso: npm run api -- [opções]

  --port <n>          Porta em 127.0.0.1. Padrão AHRENA_CONSOLE_CORE_PORT, AHRENA_CONSOLE_PORT ou 0:
                      o sistema escolhe uma livre, e o núcleo a anuncia no log, na trava e no
                      registro de instâncias (~/.ahrena-console/instances/)
  --installation <i>  app, dev ou mcpb (padrão dev). Cada instalação tem o próprio núcleo, a própria
                      pasta de dados e nunca adota o núcleo de outra
  --data-dir <pasta>  Banco, log, clientes e trava. Padrão AHRENA_CONSOLE_DATA_DIR ou a pasta da
                      instalação: dev ~/.ahrena-console, app ~/Library/Application Support/
                      dev.ahrena.console, mcpb ~/.ahrena-console/installations/mcpb
  --db <arquivo>      SQLite do núcleo. Padrão AHRENA_CONSOLE_DB ou <data-dir>/nucleo.sqlite
  --projetos <pasta>  Transcripts a seguir. Padrão ~/.claude/projects
  --sem-historico     Não importa nem segue transcripts (só hooks)
  --varredura <s>     Varredura de reserva do seguidor, em segundos. Padrão 30: o fs.watch
                      avisa cada escrita na hora; a varredura só cobre o aviso perdido
  --sem-desktop       Não lê o índice de sessões do Claude Desktop
  --sem-github        O trabalho mostra só o branch, sem chamar o GitHub, o kanban do
                      projeto (/api/project) responde 503 e os repositórios (/api/repos) e as
                      instruções dos agentes (/api/agent-instructions) respondem "sem-github"
  --demo              Banco em memória com um cenário do painel do simulador, sem histórico,
                      sem Desktop e sem GitHub: só dados sintéticos. A sessão do painel,
                      seja qual for, mostra o cenário, e o kanban do projeto é o do
                      wireframe C11, num GitHub falso (mover vale em memória). A tela
                      Agent Config lê uma pasta de configuração e um projeto fictícios
                      num temporário, apagado ao sair
  --cenario <p1..p13> O cenário da demonstração (padrão p1), como nos wireframes
                      A demo grava também o Detalhe da /ui: uma sessão que pede permissão
                      (/ui/sessoes/sim-detalhe-pedidos) e as ferramentas da sessão do cenário
  --parent <pid>      Sai quando este processo some (o app ou a extensão), a menos que outro
                      cliente esteja registrado. Se adotar, registra o pid como cliente
  --replace           Se o núcleo de pé for mais velho que este (versão, ou commit ancestral
                      deste), para ele e sobe este. De outro código, só avisa
  --no-lock           Não lê nem grava <data-dir>/nucleo.json nem o registro de instâncias
                      (medições numa porta à parte). A --demo já é sem trava. As duas falham se
                      a porta tem dono
  --no-telemetry      Não mede esta máquina: /api/machines e /api/telemetry respondem 404.
                      Na --demo, a telemetria é sintética (esta máquina e uma "workstation")
  --machines <arq>    As máquinas remotas (padrão ~/.ahrena-console/machines.json, #176):
                      { "machines": [{ "id", "label", "port" }] }, port é a porta deste Mac
                      que o seu túnel encaminha para a 4720 de lá. Sem arquivo, só esta
                      máquina. Lido ao subir; a --demo não o lê

Kanban do projeto (GET /api/project, POST /api/project/move): o Project em
AHRENA_CONSOLE_PROJECT=dono/número, com o token do \`gh\` (escopo \`project\`) e o cache no
banco do núcleo. Sem a variável, não há Project: a tela explica como escolher um.

Se já há um núcleo de pé nesta instalação, este não sobe outro: adota o de pé (imprime a porta e a
versão, avisa se o código é outro) e sai com 0. Ver src/owner/README.md.
Os nomes antigos (--porta, --banco, --pai, --substituir, --sem-trava) continuam aceitos; se vierem
os dois, vale o novo.
  --help
`;

const { values: o } = parseArgs({
  options: {
    port: { type: 'string' },
    installation: { type: 'string' },
    'data-dir': { type: 'string' },
    db: { type: 'string' },
    parent: { type: 'string' },
    replace: { type: 'boolean', default: false },
    'no-lock': { type: 'boolean', default: false },
    // Old names, accepted until phase 6 of #173 (the new one wins if both are given).
    porta: { type: 'string' },
    banco: { type: 'string' },
    projetos: { type: 'string' },
    varredura: { type: 'string', default: '30' },
    'sem-historico': { type: 'boolean', default: false },
    'sem-desktop': { type: 'boolean', default: false },
    'sem-github': { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    cenario: { type: 'string', default: 'p1' },
    pai: { type: 'string' },
    substituir: { type: 'boolean', default: false },
    'sem-trava': { type: 'boolean', default: false },
    'no-telemetry': { type: 'boolean', default: false },
    machines: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (o.help) {
  process.stdout.write(AJUDA);
  process.exit(0);
}

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
// The port asked for; 0 (the default) lets the system pick. `boundPort`, below, is the one it got.
const porta = resolvePort(o.port ?? o.porta);
const installation = parseInstallation(o.installation);
const dataDir = resolveDataDir({ installation, dataDir: o['data-dir'] });
const demo = o.demo;
const parentOption = o.parent ?? o.pai;
const pai = parentOption === undefined ? null : Number(parentOption);
if (pai !== null && !(Number.isInteger(pai) && pai > 0)) throw new Error('--parent: um pid');
if (pai !== null && !isPidAlive(pai)) throw new Error(`--parent: o pid ${pai} não existe`);
const comTrava = !demo && !o['no-lock'] && !o['sem-trava'];
const replace = o.replace || o.substituir;
const commit = commitDoCheckout();
const codigo = { version: VERSAO_DA_API, commit, isOlderCommit };
/** The start guard of the data folder, held from before the database opens until the lock is written. */
let startGuard: StartGuard | null = null;
// Until the shutdown below is ready, a signal still exits through `exit`, whose handlers release the
// start guard and the registry entry.
const exitOnSignal = (signal: NodeJS.Signals) => process.exit(signal === 'SIGINT' ? 130 : 143);
process.on('SIGINT', exitOnSignal);
process.on('SIGTERM', exitOnSignal);

function adotar(p: number, versao: string, aviso: string | null = null): never {
  if (aviso) log(`atenção: ${aviso}`);
  if (pai !== null && comTrava) registerClient(pai, dataDir);
  startGuard?.release();
  process.stdout.write(`núcleo de pé em http://127.0.0.1:${p} · versão ${versao} (adotado)\n`);
  process.exit(0);
}

// Antes de abrir o banco: adota o núcleo vivo da trava desta instalação, ou a recupera se for órfã.
async function planOrAdopt(): Promise<void> {
  const plano = await planStart({ ...codigo, dir: dataDir, replace, log });
  if (plano.action === 'adopt') adotar(plano.lock.port, plano.lock.version, plano.warning);
  if (plano.recovered) log(`trava órfã recuperada: ${plano.recovered}`);
}
if (comTrava) await planOrAdopt();
// With port 0 two starts of this installation get different ports, and a port-0 start and a
// forced-port start of the same folder do too: the port no longer decides who opens the database.
// The start guard of the data folder does. Whoever holds it looks at the lock again (another start
// may have finished between the first look and the guard), and adopts the core it finds.
if (comTrava) {
  process.once('exit', () => startGuard?.release());
  try {
    startGuard = await acquireStartGuard(dataDir);
  } catch (e) {
    await planOrAdopt();
    throw e;
  }
  await planOrAdopt();
  log(`start guard taken for ${dataDir}`);
}

// A porta é de um só: quem não a prende espera o núcleo que a prendeu e o adota.
// A --demo e a --sem-trava não adotam: quem pede a demo nunca recebe o núcleo real, nem o contrário.
async function adotarQuemTemAPorta(): Promise<never> {
  const v = await waitForCore(porta, 30_000);
  if (v && !comTrava) {
    log(`a porta ${porta} já tem um núcleo (pid ${v.pid ?? '?'}); ${demo ? 'a --demo' : 'a --sem-trava'} precisa de uma porta livre: use --porta`);
    process.exit(1);
  }
  if (v) {
    // Quem ganhou a porta grava a trava logo depois de ouvir: espera um pouco antes de dizer que não tem.
    let semTrava = v.pid === null;
    for (let i = 0; !semTrava && v.pid !== travaDaPorta(); i++) {
      if (i === 20) semTrava = true;
      else await new Promise((r) => setTimeout(r, 100));
    }
    // A core of another installation is never adopted (decision 0010): it has its own database.
    if (semTrava && isOtherInstallation(v.pid)) {
      log(`port ${porta} has the core of another installation (pid ${v.pid}); this one (${installation}, ${dataDir}) needs a free port: use --port`);
      process.exit(1);
    }
    const aviso = [semTrava ? 'o núcleo nesta porta não tem trava (uma --demo, uma --sem-trava ou um núcleo de antes da #86)' : null, codeWarning(v, codigo)];
    adotar(porta, v.version, aviso.filter(Boolean).join('; ') || null);
  }
  log(`a porta ${porta} está ocupada e não responde como núcleo`);
  process.exit(1);
}
function travaDaPorta(): number | null {
  const t = readLock(dataDir);
  return t && t !== 'invalid' && t.port === porta ? t.pid : null;
}
/** The same folder, even through a symbolic link (/tmp and /private/tmp on macOS). */
function sameDir(a: string, b: string): boolean {
  const real = (d: string) => {
    try {
      return realpathSync(d);
    } catch {
      return resolve(d);
    }
  };
  return real(a) === real(b);
}
/** The pid is the core of another data folder: in the registry, or holding the `dev` folder's lock. */
function isOtherInstallation(pid: number | null): boolean {
  if (pid === null) return false;
  const registered = listInstances().find((i) => i.pid === pid);
  if (registered) return !sameDir(registered.dataDir, dataDir);
  const devDir = defaultDataDir('dev');
  if (sameDir(devDir, dataDir)) return false;
  const t = readLock(devDir);
  return t !== null && t !== 'invalid' && t.pid === pid;
}
const reserved = await reservePort(porta);
const reserva = reserved === 'in-use' ? await adotarQuemTemAPorta() : reserved;
const boundPort = (reserva.address() as AddressInfo).port;
const banco = demo ? ':memory:' : resolve(o.db ?? o.banco ?? process.env.AHRENA_CONSOLE_DB ?? join(dataDir, 'nucleo.sqlite'));
// AHRENA_CONSOLE_DB applies to any installation: two installations with it exported would share a
// database under two locks. Say so.
if (banco !== ':memory:' && !sameDir(dirname(banco), dataDir)) log(`warning: the database ${banco} is outside the data folder ${dataDir} (--db or AHRENA_CONSOLE_DB); another installation must not use the same file`);
if (banco !== ':memory:') {
  // A pasta de dados fecha em 0700 (o banco mora nela); outra pasta dada em --db fica como está.
  if (sameDir(dirname(banco), dataDir)) prepareDir(dataDir);
  else mkdirSync(dirname(banco), { recursive: true });
}

// Toda gravação passa pelo cursor de mudanças (item 2.4): é dele que sai o long polling.
const mudancas = new ChangeCursor();
const sqlite = openSqliteStorage({ path: banco });
const contasDasSessoes = new SessionAccounts(sqlite);
const storage = withChanges(sqlite, mudancas, contasDasSessoes);
// As decisões da sessão (#99) no mesmo banco: os hooks capturam, o painel lê e confirma (#102).
const decisoes = decisionsWithChanges(new SqliteDecisionStore(sqlite.db), mudancas, contasDasSessoes);
const captura = new HookDecisionCapture({ decisions: decisoes });
const maquina = new SessionStateMachine({
  storage,
  log,
  onChange: onMachineChange(mudancas, contasDasSessoes),
  ...(demo ? { probe: null } : {}),
});
const desktop = demo || o['sem-desktop'] ? null : new IndiceDoDesktop();
const fonte = demo ? new FonteDeTrabalhoDoSimulador() : o['sem-github'] ? null : new GithubGraphqlSource({ token: () => ghCliToken() });
// Um cache do GitHub só, no banco, para o trabalho e os repositórios: a pausa por limite vale para os dois.
const cacheDoGithub = new GithubCache({ store: new SqliteCacheStore(storage.db) });
const trabalho = new TrabalhoPorBranch({
  fonte,
  cache: cacheDoGithub,
  ...(demo ? { git: FonteDeTrabalhoDoSimulador.git } : {}),
});
// O kanban do projeto (#80): o GitHub falso do C11 na --demo; senão o Project de AHRENA_CONSOLE_PROJECT.
// Sem a variável não há Project padrão: a tela explica como escolher um.
function projetoDoAmbiente(valor = process.env.AHRENA_CONSOLE_PROJECT ?? ''): ProjectRef | null {
  if (!valor.trim()) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(\d{1,9})$/.exec(valor.trim());
  if (!m) throw new Error(`AHRENA_CONSOLE_PROJECT: dono/número, como minha-org/3 (veio "${valor}")`);
  return { owner: m[1], number: Number(m[2]) };
}
const projetoEscolhido = demo || o['sem-github'] ? null : projetoDoAmbiente();
const cacheDoProjeto = new GithubCache({ store: new SqliteCacheStore(storage.db) });
const kanban = demo
  ? new GithubProject({ source: new ProjetoDoSimulador(), cache: cacheDoProjeto, project: PROJECT_DO_SIMULADOR })
  : projetoEscolhido
    ? createGithubProject({ project: projetoEscolhido, cache: cacheDoProjeto, token: () => ghCliToken() })
    : null;

// O commit do checkout da API, para o rodapé do painel dizer qual versão está no ar.
function commitDoCheckout(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// O commit da pasta agora, conferido no máximo a cada 30 s: se mudou desde a subida, o rodapé avisa.
let pasta = { em: 0, commit: null as string | null };
function commitDaPasta(): string | null {
  if (Date.now() - pasta.em > 30_000) pasta = { em: Date.now(), commit: commitDoCheckout() };
  return pasta.commit;
}

// No macOS, a API abre a conversa no Claude Desktop: `open` com o endereço como argumento, sem shell.
const abrirNoDesktop =
  process.platform === 'darwin' && !demo
    ? (url: string) =>
        new Promise<void>((resolve, reject) => execFile('open', [url], { timeout: 5_000 }, (err) => (err ? reject(err) : resolve())))
    : null;

// A mesma `Contas` no painel e no MCP: o rótulo "conta 1" é o mesmo nas duas superfícies.
const contas = new Contas({ storage, ...(demo ? { arquivo: null } : {}) });
const montador = new MontadorDoPainel({
  commit,
  commitDaPasta,
  abreSessao: abrirNoDesktop !== null,
  storage,
  contas,
  desktop,
  trabalho,
  decisoes,
  ...(demo ? { apelido: apelidoDaDemo } : {}),
});

// A página e a aba Decisões da /ui (#103). Na demo, o Promover grava numa pasta temporária, criada
// agora e apagada na saída, no lugar de /simulacao; fora da demo, no próprio repositório da decisão.
const pastaDaDemo = demo ? mkdtempSync(join(tmpdir(), 'ahrena-console-demo-')) : null;
const decisoesUi = new DecisoesDaUi({
  decisions: decisoes,
  storage,
  // A aba e o Promover enxergam a sessão como o Confirmar do painel: a mesma regra, a do montador.
  alvoDe: (id) => montador.alvoDaSessao(id),
  ...(pastaDaDemo ? { raiz: pastasDosRegistrosDaDemo(pastaDaDemo) } : {}),
  localDe: async (id) => {
    await desktop?.atualizar();
    return desktop?.sessaoPorCli(id)?.localId ?? null;
  },
});

if (demo) {
  const cenario = o.cenario as CenarioDoPainel;
  if (!CENARIOS_DO_PAINEL.includes(cenario)) throw new Error(`--cenario: um de ${CENARIOS_DO_PAINEL.join(', ')}`);
  await semearCenariosDoPainel(storage, cenario);
  await semearDecisoesDoPainel(decisoes, cenario);
  if (cenario === 'p4') await semearWorkflowsDoDemo(storage); // #96 e #97: as sessões das telas Workflows
  // Histórico simulado (semente fixa, de ontem para trás) para os gráficos da tela Analytics.
  await semearHistorico(storage);
  await semearDetalhe(storage);
  await semearHistoricoDoPainel(storage, decisoes, cenario);
}
const detalhe = new LeiturasDoDetalhe({ storage, montador, ...(demo ? { local: localDaDemo } : {}) });

// O histórico das sessões encerradas (#33), com o título do índice do Desktop quando há.
const historico = new SessionHistory({ storage, decisions: decisoes, titleOf: (s) => desktop?.sessaoPorCli(s.id)?.titulo ?? null });

// Profiles: the current account of each configuration folder goes to the port, with the org name
// as its label. Re-read every minute, to pick up a new `claude auth login`.
const perfis = demo ? null : new Profiles({ storage });
const sincronizarPerfis = () =>
  perfis
    ?.sync()
    .then((ps) => ps.length)
    .catch((e) => (log(`profiles: ${(e as Error).message}`), 0));
if (perfis) log(`profiles: ${await sincronizarPerfis()} configuration folder(s)`);
// The Agent Config screen (#63): the profiles' folders and the sessions' cwd; in the demo, fictitious folders.
const demoAgentConfig = demo ? mountDemoAgentConfig() : null;
if (demoAgentConfig) process.once('exit', demoAgentConfig.remove);
const agentConfig = demoAgentConfig
  ? createAgentConfigRoute({ folders: async () => demoAgentConfig.folders, projects: async () => [demoAgentConfig.project], backups: demoAgentConfig.backups, log })
  : createAgentConfigRoute({ folders: () => perfis!.list(), projects: () => knownProjects(storage), log });
const relerPerfis = perfis ? setInterval(() => void sincronizarPerfis(), 60_000) : null;
relerPerfis?.unref();

// New tools (e.g. `wait_for_changes`, 2.4) come in here with `mcp.server.register(...)`.
const mcp = createMcpServer({ storage, accounts: contas, desktop, log });
mcp.server.register(waitForChanges({ changes: mudancas, accounts: contas }));
// Uma fila só para as chamadas ao GitHub por trás das telas (decisão 0001, item 6): repositórios e instruções.
const githubQueue = new GithubCallQueue();
const repos = criarReposDoNucleo({ demo, semGithub: o['sem-github'], cache: cacheDoGithub, frota: mcp.fleet, mudancas, log, queue: githubQueue });
// The Instructions tab of a repository (#183): the fake GitHub under --demo; otherwise GitHub through the 0001 cache.
const agentInstructions = createCoreAgentInstructions({ demo, noGithub: o['sem-github'], cache: cacheDoGithub, changes: mudancas, queue: githubQueue, log });

// The Dev Console (#177): the synthetic context and the fake GitHub under --demo; otherwise GitHub through the 0001 cache.
const devConsole = createDevConsole({
  storage,
  frota: mcp.fleet,
  decisions: decisoes,
  cache: cacheDoGithub,
  source: demo ? new SimulatedDevConsoleSource() : o['sem-github'] ? disabledDevConsoleSource() : new GithubDevConsoleSource(),
  ...(demo ? { file: null, contexts: DEV_CONSOLE_SIMULATOR_CONTEXTS, git: devConsoleSimulatorGit } : {}),
});

// Machine telemetry (#175, decision 0008): one sample every 30 s, 12 h in the database, and each
// alert that enters or exits on /api/changes. In --demo, the simulator's synthetic readings, with
// 12 h already seeded, plus a synthetic "workstation". Outside the demo, each remote machine of
// machines.json (#176) is read every 30 s through the port the user's tunnel forwards.
const sampleStore = new SqliteTelemetryStore(sqlite.db);
const alertTracker = new AlertTracker();
const machineEntries: MachineEntry[] = [localMachine()];
const samplers: TelemetrySampler[] = [];
const remoteMachines: RemoteMachine[] = [];
function addSampler(machineId: string, collector: TelemetryCollector) {
  samplers.push(new TelemetrySampler({ machineId, collector, store: sampleStore, tracker: alertTracker, onAlertChange: publishAlertChanges(mudancas), log }));
}
if (demo) {
  machineEntries.push({ ...SIMULATED_WORKSTATION, state: () => 'connected' });
  await seedTelemetry(sampleStore, 'local', 'local');
  await seedTelemetry(sampleStore, SIMULATED_WORKSTATION.id, 'workstation');
  addSampler('local', new SimulatedCollector('local'));
  addSampler(SIMULATED_WORKSTATION.id, new SimulatedCollector('workstation'));
} else if (!o['no-telemetry']) {
  const platformCollector = collectorFor();
  if (platformCollector) addSampler('local', platformCollector);
  else log(`telemetry: no collector for ${process.platform}`);
  const machinesConfig = await loadMachinesConfig({ ...(o.machines ? { file: o.machines } : {}), log });
  const get = loopbackGet();
  for (const config of machinesConfig.machines) {
    if (config.port === boundPort) {
      log(`machines: ${config.id} uses port ${config.port}, this núcleo's own; skipped`);
      continue;
    }
    const remote = new RemoteMachine({
      config,
      get,
      store: sampleStore,
      tracker: alertTracker,
      onAlertChange: publishAlertChanges(mudancas),
      onAttentionChange: publishRemoteAttentionChanges(mudancas),
      log,
    });
    remoteMachines.push(remote);
    machineEntries.push(remote);
  }
  if (remoteMachines.length > 0) log(`telemetry: ${remoteMachines.length} remote machine(s): ${remoteMachines.map((m) => `${m.id} on port ${m.port}`).join(', ')}`);
}
const telemetryService = samplers.length > 0 || remoteMachines.length > 0 ? new TelemetryService({ store: sampleStore, tracker: alertTracker, machines: machineEntries }) : null;

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

// The API takes over the socket reserved above: the port is never free in between (with port 0,
// the one the system assigned stays this core's).
const api: ApiLocal = await iniciarApiLocal({
  listenOn: reserva,
  montador,
  hooks: {
    storage,
    // Os mesmos perfis: a pasta que um hook revela entra nas próximas listagens.
    profiles: perfis ?? undefined,
    onEvent: async (r) => {
      await maquina.onHook(r);
      await captura.onEvent(r.event);
    },
    log,
  },
  port: boundPort,
  log,
  abrirNoDesktop,
  mcp: mcp.server,
  commit,
  mudancas,
  decisoesUi,
  projeto: { kanban, fonte: demo ? 'demo' : 'github', semProjeto: !demo && !o['sem-github'] && !projetoEscolhido, log },
  detalhe,
  eventos: new FeedDeEventos({ storage }),
  frota: mcp.fleet,
  remoteAttention: remoteMachines,
  analytics: new RotaAnalytics({ storage, contas, versao: () => mudancas.current }),
  sessoes: new ListaDeSessoes({ storage, contas, desktop }),
  historico,
  kanban: new QuadroKanban({ storage, contas, desktop }),
  repos: repos.rota,
  agentInstructions: agentInstructions.route,
  devConsole,
  agentConfig,
  telemetry: telemetryService,
  carga: () => ({
    history: follower ? (historicoPronto ? 'ready' : 'importing') : 'off',
    follower: follower?.stats() ?? null,
    desktopRead: desktop?.lidos ?? 0,
    work: trabalho.chamadas,
  }),
}).catch(async (e: unknown) => {
  await releasePort(reserva).catch(() => undefined);
  throw e;
});
const apiPort = (api.server.address() as AddressInfo).port;

const trava = comTrava ? await claimLock({ dir: dataDir, port: apiPort, version: VERSAO_DA_API, parent: pai }) : null;
if (trava && 'conflict' in trava) {
  await api.close().catch(() => undefined);
  await storage.close();
  adotar(trava.conflict.port, trava.conflict.version);
}
startGuard?.release();
// The instance registry (decision 0010, item 3): only cores with a lock. A --demo or a --no-lock
// core is not this installation's core, so nobody should find it there.
const instance = trava
  ? { id: instanceId(installation), installation, pid: process.pid, port: apiPort, version: VERSAO_DA_API, commit, dataDir, startedAt: trava.startedAt }
  : null;
const unregister = () => {
  if (!instance) return;
  try {
    removeInstance(instance.id, { pid: process.pid });
  } catch (e) {
    log(`registry: ${(e as Error).message}`);
  }
};
if (instance) {
  process.once('exit', unregister);
  // The registry is only for finding the core: a failure here is logged, it does not stop the core.
  try {
    writeInstance(instance);
  } catch (e) {
    log(`registry: could not write ${instance.id}: ${(e as Error).message}`);
  }
}
log(`listening on port ${apiPort} · installation ${installation} · data ${demo ? '(demo, in memory)' : dataDir}${instance ? ` · instance ${instance.id}` : ''}`);
log(`API local em ${api.url} · MCP em ${api.url}/mcp${demo ? ` (demo ${o.cenario}: dados sintéticos do simulador)` : ` · banco ${banco}`}`);

const pararDeVigiarPai =
  pai === null
    ? () => {}
    : watchParent({
        parent: pai,
        dir: dataDir,
        onGone: (motivo) => {
          log(`${motivo}; saindo`);
          void desligar();
        },
      });

// A importação inicial roda depois que a porta já responde: o painel não espera o histórico.
const pararVigia = demo ? () => {} : maquina.start();
for (const a of samplers) a.start();
for (const m of remoteMachines) m.start();
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
// da captura existir, a limpeza do que a captura antiga gravou e não é decisão, e os medidores
// de contexto das sessões importadas antes do item 1.7.
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
  if (!storage.reprocessado(REPROCESSAMENTO_DO_CONTEXTO)) {
    const r = await reprocessarContexto({ storage, raiz: o.projetos ?? defaultProjectsRoot(), log });
    storage.marcarReprocessado(REPROCESSAMENTO_DO_CONTEXTO, new Date().toISOString());
    log(`medidor de contexto refeito: ${r.medidores} medidores em ${r.sessoes} sessões`);
  }
}

async function desligar() {
  pararVigia();
  if (relerPerfis) clearInterval(relerPerfis);
  pararDeVigiarPai();
  unregister();
  if (trava && !('conflict' in trava)) releaseLock(trava.token, dataDir);
  await follower?.stop().catch(() => undefined);
  await Promise.all([...samplers, ...remoteMachines].map((a) => a.stop()));
  await api.close().catch(() => undefined);
  await storage.close();
  if (pastaDaDemo) rmSync(pastaDaDemo, { recursive: true, force: true });
  process.exit(0);
}
process.off('SIGINT', exitOnSignal);
process.off('SIGTERM', exitOnSignal);
process.on('SIGINT', () => void desligar());
process.on('SIGTERM', () => void desligar());
