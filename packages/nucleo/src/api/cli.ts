#!/usr/bin/env node
// Sobe a API local do núcleo: importa o histórico, segue os transcripts, recebe os hooks, roda a
// máquina de estados e responde ao painel, tudo em 127.0.0.1. `npm run api -- --help`.
//
// One core per machine (#86, src/owner/): if one is already up, this process adopts it (prints the
// port and version and exits 0) instead of starting another.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { createGithubProject, GithubProject, type ProjectRef } from '../github/project.ts';
import { defaultProjectsRoot } from '../ingest/history/files.ts';
import { followTranscripts } from '../ingest/history/follower.ts';
import { Profiles } from '../profiles/profiles.ts';
import { registerClient } from '../owner/clients.ts';
import { isOlderCommit } from '../owner/commit.ts';
import { claimLock, codeWarning, planStart, watchParent } from '../owner/owner.ts';
import { waitForCore, isPidAlive, reservePort, releasePort } from '../owner/probe.ts';
import { readLock, releaseLock, defaultDir, prepareDir } from '../owner/lock.ts';
import { ChangeCursor } from '../changes/cursor.ts';
import { onMachineChange, withChanges, SessionAccounts, decisionsWithChanges } from '../changes/sources.ts';
import { waitForChanges } from '../changes/mcp.ts';
import {
  demoAlias,
  PANEL_SCENARIOS,
  SimulatorWorkSource,
  demoRecordFolders,
  seedPanelScenario,
  seedPanelDecisions,
  type PanelScenario,
} from '../simulator/panel.ts';
import { seedDemoWorkflows } from '../simulator/workflows.ts';
import { seedPanelHistory } from '../simulator/history-ended.ts';
import { SessionHistory } from '../history/reading.ts';
import { SIMULATOR_PROJECT, SimulatorProject } from '../simulator/project.ts';
import { seedHistory } from '../simulator/history.ts';
import { demoLocal, seedDetail } from '../simulator/detail.ts';
import { upgradeDemoUrl } from '../simulator/legacy-ids.ts';
import { mountDemoAgentConfig, knownProjects } from '../agent-config/index.ts';
import { createAgentConfigRoute } from './agent-config.ts';
import { Contas } from './accounts.ts';
import { DecisoesDaUi } from './decisions-ui.ts';
import { QuadroKanban } from './kanban.ts';
import { LeiturasDoDetalhe } from './session-detail.ts';
import { IndiceDoDesktop } from './desktop-index.ts';
import { RotaAnalytics } from './analytics-route.ts';
import { MontadorDoPainel } from './panel.ts';
import {
  capturarDoTranscript,
  LIMPEZA_DAS_DECISOES,
  limparDecisoes,
  REPROCESSAMENTO,
  REPROCESSAMENTO_DO_CONTEXTO,
  reprocessarContexto,
  reprocessarHistorico,
} from './reprocessing.ts';
import { criarReposDoNucleo } from './repos.ts';
import { iniciarApiLocal, VERSAO_DA_API, type ApiLocal } from './server.ts';
import { ListaDeSessoes } from './sessions.ts';
import { FeedDeEventos } from './events.ts';
import { TrabalhoPorBranch } from './work.ts';
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

  --porta <n>         Porta em 127.0.0.1. Padrão AHRENA_CONSOLE_PORT ou 4720
  --banco <arquivo>   SQLite do núcleo. Padrão AHRENA_CONSOLE_DB ou ~/.ahrena-console/nucleo.sqlite
  --projetos <pasta>  Transcripts a seguir. Padrão ~/.claude/projects
  --sem-historico     Não importa nem segue transcripts (só hooks)
  --varredura <s>     Varredura de reserva do seguidor, em segundos. Padrão 30: o fs.watch
                      avisa cada escrita na hora; a varredura só cobre o aviso perdido
  --sem-desktop       Não lê o índice de sessões do Claude Desktop
  --sem-github        O trabalho mostra só o branch, sem chamar o GitHub, o kanban do
                      projeto (/api/project) responde 503 e os repositórios (/api/repos)
                      respondem "sem-github"
  --demo              Banco em memória com um cenário do painel do simulador, sem histórico,
                      sem Desktop e sem GitHub: só dados sintéticos. A sessão do painel,
                      seja qual for, mostra o cenário, e o kanban do projeto é o do
                      wireframe C11, num GitHub falso (mover vale em memória). A tela
                      Agent Config lê uma pasta de configuração e um projeto fictícios
                      num temporário, apagado ao sair
  --cenario <p1..p13> O cenário da demonstração (padrão p1), como nos wireframes
                      A demo grava também o Detalhe da /ui: uma sessão que pede permissão
                      (/ui/sessions/sim-detail-orders) e as ferramentas da sessão do cenário
  --pai <pid>         Sai quando este processo some (o app ou a extensão), a menos que outro
                      cliente esteja registrado. Se adotar, registra o pid como cliente
  --substituir        Se o núcleo de pé for mais velho que este (versão, ou commit ancestral
                      deste), para ele e sobe este. De outro código, só avisa
  --sem-trava         Não lê nem grava ~/.ahrena-console/nucleo.json (medições numa porta à
                      parte). A --demo já é sem trava. As duas falham se a porta tem dono
  --no-telemetry      Não mede esta máquina: /api/machines e /api/telemetry respondem 404.
                      Na --demo, a telemetria é sintética (esta máquina e uma "workstation")
  --machines <arq>    As máquinas remotas (padrão ~/.ahrena-console/machines.json, #176):
                      { "machines": [{ "id", "label", "port" }] }, port é a porta deste Mac
                      que o seu túnel encaminha para a 4720 de lá. Sem arquivo, só esta
                      máquina. Lido ao subir; a --demo não o lê

Kanban do projeto (GET /api/project, POST /api/project/move): o Project em
AHRENA_CONSOLE_PROJECT=dono/número, com o token do \`gh\` (escopo \`project\`) e o cache no
banco do núcleo. Sem a variável, não há Project: a tela explica como escolher um.

Se já há um núcleo de pé nesta máquina, este não sobe outro: adota o de pé (imprime a porta e a
versão, avisa se o código é outro) e sai com 0. Ver src/owner/README.md.
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
const porta = Number(o.porta ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
const demo = o.demo;
const pai = o.pai === undefined ? null : Number(o.pai);
if (pai !== null && !(Number.isInteger(pai) && pai > 0)) throw new Error('--pai: um pid');
if (pai !== null && !isPidAlive(pai)) throw new Error(`--pai: o pid ${pai} não existe`);
const comTrava = !demo && !o['sem-trava'];
const commit = commitDoCheckout();
const codigo = { version: VERSAO_DA_API, commit, isOlderCommit };

function adotar(p: number, versao: string, aviso: string | null = null): never {
  if (aviso) log(`atenção: ${aviso}`);
  if (pai !== null && comTrava) registerClient(pai);
  process.stdout.write(`núcleo de pé em http://127.0.0.1:${p} · versão ${versao} (adotado)\n`);
  process.exit(0);
}

// Antes de abrir o banco: adota o núcleo vivo da trava, ou a recupera se for órfã.
if (comTrava) {
  const plano = await planStart({ ...codigo, replace: o.substituir, log });
  if (plano.action === 'adopt') adotar(plano.lock.port, plano.lock.version, plano.warning);
  if (plano.recovered) log(`trava órfã recuperada: ${plano.recovered}`);
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
    const aviso = [semTrava ? 'o núcleo nesta porta não tem trava (uma --demo, uma --sem-trava ou um núcleo de antes da #86)' : null, codeWarning(v, codigo)];
    adotar(porta, v.version, aviso.filter(Boolean).join('; ') || null);
  }
  log(`a porta ${porta} está ocupada e não responde como núcleo`);
  process.exit(1);
}
function travaDaPorta(): number | null {
  const t = readLock();
  return t && t !== 'invalid' && t.port === porta ? t.pid : null;
}
const reserva = await reservePort(porta);
if (reserva === 'in-use') await adotarQuemTemAPorta();
const banco = demo ? ':memory:' : (o.banco ?? process.env.AHRENA_CONSOLE_DB ?? join(homedir(), '.ahrena-console', 'nucleo.sqlite'));
if (banco !== ':memory:') {
  // A pasta do núcleo fecha em 0700 (o banco mora nela); outra pasta dada em --banco fica como está.
  if (dirname(banco) === defaultDir()) prepareDir();
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
const fonte = demo ? new SimulatorWorkSource() : o['sem-github'] ? null : new GithubGraphqlSource({ token: () => ghCliToken() });
// Um cache do GitHub só, no banco, para o trabalho e os repositórios: a pausa por limite vale para os dois.
const cacheDoGithub = new GithubCache({ store: new SqliteCacheStore(storage.db) });
const trabalho = new TrabalhoPorBranch({
  fonte,
  cache: cacheDoGithub,
  ...(demo ? { git: SimulatorWorkSource.git } : {}),
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
  ? new GithubProject({ source: new SimulatorProject(), cache: cacheDoProjeto, project: SIMULATOR_PROJECT })
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
  ...(demo ? { apelido: demoAlias } : {}),
});

// A página e a aba Decisões da /ui (#103). Na demo, o Promover grava numa pasta temporária, criada
// agora e apagada na saída, no lugar de /simulacao; fora da demo, no próprio repositório da decisão.
const pastaDaDemo = demo ? mkdtempSync(join(tmpdir(), 'ahrena-console-demo-')) : null;
const decisoesUi = new DecisoesDaUi({
  decisions: decisoes,
  storage,
  // A aba e o Promover enxergam a sessão como o Confirmar do painel: a mesma regra, a do montador.
  alvoDe: (id) => montador.alvoDaSessao(id),
  ...(pastaDaDemo ? { raiz: demoRecordFolders(pastaDaDemo) } : {}),
  localDe: async (id) => {
    await desktop?.atualizar();
    return desktop?.sessaoPorCli(id)?.localId ?? null;
  },
});

if (demo) {
  const cenario = o.cenario as PanelScenario;
  if (!PANEL_SCENARIOS.includes(cenario)) throw new Error(`--cenario: um de ${PANEL_SCENARIOS.join(', ')}`);
  await seedPanelScenario(storage, cenario);
  await seedPanelDecisions(decisoes, cenario);
  if (cenario === 'p4') await seedDemoWorkflows(storage); // #96 e #97: as sessões das telas Workflows
  // Histórico simulado (semente fixa, de ontem para trás) para os gráficos da tela Analytics.
  await seedHistory(storage);
  await seedDetail(storage);
  await seedPanelHistory(storage, decisoes, cenario);
}
const detalhe = new LeiturasDoDetalhe({ storage, montador, ...(demo ? { local: demoLocal } : {}) });

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
const repos = criarReposDoNucleo({ demo, semGithub: o['sem-github'], cache: cacheDoGithub, frota: mcp.fleet, mudancas, log });

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
    if (config.port === porta) {
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

if (reserva !== 'in-use') await releasePort(reserva);
const api: ApiLocal = await iniciarApiLocal({
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
  port: porta,
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
  // The demo's old session ids (before #173) still open the session (src/simulator/legacy-ids.ts).
  ...(demo ? { demoUrl: upgradeDemoUrl } : {}),
  devConsole,
  agentConfig,
  telemetry: telemetryService,
  carga: () => ({
    history: follower ? (historicoPronto ? 'ready' : 'importing') : 'off',
    follower: follower?.stats() ?? null,
    desktopRead: desktop?.lidos ?? 0,
    work: trabalho.chamadas,
  }),
}).catch(async (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  await storage.close();
  return adotarQuemTemAPorta();
});

const trava = comTrava ? await claimLock({ port: porta, version: VERSAO_DA_API, parent: pai }) : null;
if (trava && 'conflict' in trava) {
  await api.close().catch(() => undefined);
  await storage.close();
  adotar(trava.conflict.port, trava.conflict.version);
}
log(`API local em ${api.url} · MCP em ${api.url}/mcp${demo ? ` (demo ${o.cenario}: dados sintéticos do simulador)` : ` · banco ${banco}`}`);

const pararDeVigiarPai =
  pai === null
    ? () => {}
    : watchParent({
        parent: pai,
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
  if (trava && !('conflict' in trava)) releaseLock(trava.token);
  await follower?.stop().catch(() => undefined);
  await Promise.all([...samplers, ...remoteMachines].map((a) => a.stop()));
  await api.close().catch(() => undefined);
  await storage.close();
  if (pastaDaDemo) rmSync(pastaDaDemo, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void desligar());
process.on('SIGTERM', () => void desligar());
