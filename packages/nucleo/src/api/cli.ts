#!/usr/bin/env node
// Sobe a API local do núcleo: importa o histórico, segue os transcripts, recebe os hooks, roda a
// máquina de estados e responde ao painel, tudo em 127.0.0.1. `npm run api -- --help`.
//
// Um núcleo por máquina (#86, src/dono/): se já há um de pé, este processo o adota (imprime a porta
// e a versão e sai com 0) em vez de subir outro.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { HookDecisionCapture } from '../decisoes/captura-hooks.ts';
import { SqliteDecisionStore } from '../decisoes/sqlite.ts';
import { MaquinaDeEstados } from '../estados/maquina.ts';
import { criarServidorMcp } from '../mcp/index.ts';
import { GithubCache } from '../github/cache.ts';
import { ghCliToken, GithubGraphqlSource } from '../github/github-source.ts';
import { SqliteCacheStore } from '../github/sqlite-cache.ts';
import { defaultProjectsRoot } from '../ingest/historico/files.ts';
import { followTranscripts } from '../ingest/historico/follower.ts';
import { Perfis } from '../perfis/perfis.ts';
import { registrarCliente } from '../dono/clientes.ts';
import { commitMaisVelho } from '../dono/codigo.ts';
import { assumirTrava, avisoDeCodigo, planejarSubida, vigiarPai } from '../dono/dono.ts';
import { esperarNucleo, pidVivo, reservarPorta, soltarPorta } from '../dono/sonda.ts';
import { lerTrava, liberarTrava, pastaPadrao, prepararPasta } from '../dono/trava.ts';
import { CursorDeMudancas } from '../mudancas/cursor.ts';
import { aoMudarDaMaquina, comMudancas, ContasDasSessoes, decisoesComMudancas } from '../mudancas/fontes.ts';
import { waitForChanges } from '../mudancas/mcp.ts';
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
import {
  capturarDoTranscript,
  LIMPEZA_DAS_DECISOES,
  limparDecisoes,
  REPROCESSAMENTO,
  REPROCESSAMENTO_DO_CONTEXTO,
  reprocessarContexto,
  reprocessarHistorico,
} from './reprocessamento.ts';
import { iniciarApiLocal, VERSAO_DA_API, type ApiLocal } from './servidor.ts';
import { FeedDeEventos } from './eventos.ts';
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
  --cenario <p1..p13> O cenário da demonstração (padrão p1), como nos wireframes
  --pai <pid>         Sai quando este processo some (o app ou a extensão), a menos que outro
                      cliente esteja registrado. Se adotar, registra o pid como cliente
  --substituir        Se o núcleo de pé for mais velho que este (versão, ou commit ancestral
                      deste), para ele e sobe este. De outro código, só avisa
  --sem-trava         Não lê nem grava ~/.ahrena-console/nucleo.json (medições numa porta à
                      parte). A --demo já é sem trava. As duas falham se a porta tem dono

Se já há um núcleo de pé nesta máquina, este não sobe outro: adota o de pé (imprime a porta e a
versão, avisa se o código é outro) e sai com 0. Ver src/dono/README.md.
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
if (pai !== null && !pidVivo(pai)) throw new Error(`--pai: o pid ${pai} não existe`);
const comTrava = !demo && !o['sem-trava'];
const commit = commitDoCheckout();
const codigo = { versao: VERSAO_DA_API, commit, commitMaisVelho };

function adotar(p: number, versao: string, aviso: string | null = null): never {
  if (aviso) log(`atenção: ${aviso}`);
  if (pai !== null && comTrava) registrarCliente(pai);
  process.stdout.write(`núcleo de pé em http://127.0.0.1:${p} · versão ${versao} (adotado)\n`);
  process.exit(0);
}

// Antes de abrir o banco: adota o núcleo vivo da trava, ou a recupera se for órfã.
if (comTrava) {
  const plano = await planejarSubida({ ...codigo, substituir: o.substituir, log });
  if (plano.acao === 'adotar') adotar(plano.trava.porta, plano.trava.versao, plano.aviso);
  if (plano.recuperou) log(`trava órfã recuperada: ${plano.recuperou}`);
}

// A porta é de um só: quem não a prende espera o núcleo que a prendeu e o adota.
// A --demo e a --sem-trava não adotam: quem pede a demo nunca recebe o núcleo real, nem o contrário.
async function adotarQuemTemAPorta(): Promise<never> {
  const v = await esperarNucleo(porta, 30_000);
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
    const aviso = [semTrava ? 'o núcleo nesta porta não tem trava (uma --demo, uma --sem-trava ou um núcleo de antes da #86)' : null, avisoDeCodigo(v, codigo)];
    adotar(porta, v.versao, aviso.filter(Boolean).join('; ') || null);
  }
  log(`a porta ${porta} está ocupada e não responde como núcleo`);
  process.exit(1);
}
function travaDaPorta(): number | null {
  const t = lerTrava();
  return t && t !== 'invalida' && t.porta === porta ? t.pid : null;
}
const reserva = await reservarPorta(porta);
if (reserva === 'ocupada') await adotarQuemTemAPorta();
const banco = demo ? ':memory:' : (o.banco ?? process.env.AHRENA_CONSOLE_DB ?? join(homedir(), '.ahrena-console', 'nucleo.sqlite'));
if (banco !== ':memory:') {
  // A pasta do núcleo fecha em 0700 (o banco mora nela); outra pasta dada em --banco fica como está.
  if (dirname(banco) === pastaPadrao()) prepararPasta();
  else mkdirSync(dirname(banco), { recursive: true });
}

// Toda gravação passa pelo cursor de mudanças (item 2.4): é dele que sai o long polling.
const mudancas = new CursorDeMudancas();
const sqlite = openSqliteStorage({ path: banco });
const contasDasSessoes = new ContasDasSessoes(sqlite);
const storage = comMudancas(sqlite, mudancas, contasDasSessoes);
// As decisões da sessão (#99) no mesmo banco: os hooks capturam, o painel lê e confirma (#102).
const decisoes = decisoesComMudancas(new SqliteDecisionStore(sqlite.db), mudancas, contasDasSessoes);
const captura = new HookDecisionCapture({ decisions: decisoes });
const maquina = new MaquinaDeEstados({
  storage,
  log,
  aoMudar: aoMudarDaMaquina(mudancas, contasDasSessoes),
  ...(demo ? { sonda: null } : {}),
});
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
  ...(demo ? { apelido: () => SESSAO_DO_PAINEL } : {}),
});

if (demo) {
  const cenario = o.cenario as CenarioDoPainel;
  if (!CENARIOS_DO_PAINEL.includes(cenario)) throw new Error(`--cenario: um de ${CENARIOS_DO_PAINEL.join(', ')}`);
  await semearCenariosDoPainel(storage, cenario);
  await semearDecisoesDoPainel(decisoes, cenario);
}

// Perfis: a conta atual de cada pasta de configuração vai para a porta, com o nome da org como
// rótulo. Relido a cada minuto, para pegar um `claude auth login` novo.
const perfis = demo ? null : new Perfis({ storage });
const sincronizarPerfis = () =>
  perfis
    ?.sincronizar()
    .then((ps) => ps.length)
    .catch((e) => (log(`perfis: ${(e as Error).message}`), 0));
if (perfis) log(`perfis: ${await sincronizarPerfis()} pasta(s) de configuração`);
const relerPerfis = perfis ? setInterval(() => void sincronizarPerfis(), 60_000) : null;
relerPerfis?.unref();

// Ferramentas novas (ex.: `wait_for_changes`, 2.4) entram com `mcp.servidor.registrar(...)` aqui.
const mcp = criarServidorMcp({ storage, contas, desktop, log });
mcp.servidor.registrar(waitForChanges({ mudancas, contas }));

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

if (reserva !== 'ocupada') await soltarPorta(reserva);
const api: ApiLocal = await iniciarApiLocal({
  montador,
  hooks: {
    storage,
    // Os mesmos perfis: a pasta que um hook revela entra nas próximas listagens.
    perfis: perfis ?? undefined,
    onEvent: async (r) => {
      await maquina.aoReceberHook(r);
      await captura.onEvent(r.event);
    },
    log,
  },
  port: porta,
  log,
  abrirNoDesktop,
  mcp: mcp.servidor,
  commit,
  mudancas,
  eventos: new FeedDeEventos({ storage }),
  carga: () => ({
    historico: follower ? (historicoPronto ? 'pronto' : 'importando') : 'desligado',
    seguidor: follower?.stats() ?? null,
    desktopLidos: desktop?.lidos ?? 0,
    trabalho: trabalho.chamadas,
  }),
}).catch(async (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  await storage.close();
  return adotarQuemTemAPorta();
});

const trava = comTrava ? await assumirTrava({ porta, versao: VERSAO_DA_API, pai }) : null;
if (trava && 'conflito' in trava) {
  await api.close().catch(() => undefined);
  await storage.close();
  adotar(trava.conflito.porta, trava.conflito.versao);
}
log(`API local em ${api.url} · MCP em ${api.url}/mcp${demo ? ` (demo ${o.cenario}: dados sintéticos do simulador)` : ` · banco ${banco}`}`);

const pararDeVigiarPai =
  pai === null
    ? () => {}
    : vigiarPai({
        pai,
        aoSumir: (motivo) => {
          log(`${motivo}; saindo`);
          void desligar();
        },
      });

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
  if (trava && !('conflito' in trava)) liberarTrava(trava.token);
  await follower?.stop().catch(() => undefined);
  await api.close().catch(() => undefined);
  await storage.close();
  process.exit(0);
}
process.on('SIGINT', () => void desligar());
process.on('SIGTERM', () => void desligar());
