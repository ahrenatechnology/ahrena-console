#!/usr/bin/env node
// Mede quanto o núcleo pesa sob a carga dos painéis (issue #81, decisão 0004).
//
// Sobe o núcleo numa porta separada, simula as sessões consultando, e mede CPU e
// memória do processo do núcleo (`ps`) e a latência de cada pedido. No fim desliga o
// núcleo. Não chama o GitHub.
//
// Uso:
//   node scripts/medir-carga.mjs [--rota painel|sessao|frota] [--sessoes 20] [--abertos 1]
//                                [--segundos 60] [--porta 4799] [--servidor caminho]
//                                [--hooks-por-min 0] [--sessao <id>] [--varredura <s>]
//
//   --rota painel  a API de produção (packages/nucleo/src/api/cli.ts): importa e segue
//                  ~/.claude/projects de verdade, num banco temporário, e só começa a
//                  medir depois da importação inicial. Os `--abertos` painéis pedem
//                  /api/panel/<sessão> a cada 5 s; a sessão é `--sessao` ou o transcript
//                  mais recente. `--hooks-por-min` soma hooks sintéticos das `--sessoes`
//                  (POST /api/hooks), como sessões trabalhando ao mesmo tempo.
//                  `--varredura` passa ao núcleo o intervalo da varredura de reserva.
//   --rota sessao  núcleo de teste: só os `--abertos` painéis consultam, cada um
//                  /api/sessao/<id> a cada 5 s; as outras sessões não pedem nada.
//   --rota frota   núcleo de teste, comportamento antigo: todas as `--sessoes` consultam
//                  /api/fleet a cada 5 s, com o painel aberto ou não (`--abertos` não conta).
//   --servidor     o servidor a medir (padrão: o da rota).
//
// CPU é o tempo de CPU do processo do núcleo durante a janela de carga dividido pela
// duração da janela: 100% é um núcleo de CPU inteiro.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pares, a, i, l) => (a.startsWith('--') ? [...pares, [a.slice(2), l[i + 1]]] : pares), []),
);
const rota = args.rota ?? 'painel';
const sessoes = Number(args.sessoes ?? 20);
const abertos = rota === 'frota' ? sessoes : Math.min(sessoes, Number(args.abertos ?? 1));
const segundos = Number(args.segundos ?? 60);
const porta = Number(args.porta ?? 4799);
const servidor = resolve(raiz, args.servidor ?? (rota === 'painel' ? 'packages/nucleo/src/api/cli.ts' : 'spikes/nucleo-teste/server.mjs'));
const hooksPorMin = Number(args['hooks-por-min'] ?? 0);
const base = `http://127.0.0.1:${porta}`;
const INTERVALO_MS = 5000;

if (!['painel', 'sessao', 'frota'].includes(rota)) throw new Error(`--rota painel, sessao ou frota, não ${rota}`);

// A sessão que o painel olha: a dada, ou a do transcript mais recente (só o nome do arquivo).
function sessaoRecente() {
  const projetos = join(homedir(), '.claude', 'projects');
  let melhor = { id: 'sem-transcript', mtime: 0 };
  for (const p of readdirSync(projetos, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    for (const f of readdirSync(join(projetos, p.name))) {
      const m = /^([0-9a-f-]{36})\.jsonl$/.exec(f);
      if (!m) continue;
      const mtime = statSync(join(projetos, p.name, f)).mtimeMs;
      if (mtime > melhor.mtime) melhor = { id: m[1], mtime };
    }
  }
  return melhor.id;
}
const sessaoDoPainel = rota === 'painel' ? (args.sessao ?? sessaoRecente()) : null;
if (porta === 4720) throw new Error('a 4720 é a porta do núcleo de uso; meça em outra');

// `ps -o time=` no macOS e no Linux: [[dd-]hh:]mm:ss.cc
const segundosDe = (t) => t.trim().replace(/^(\d+)-/, (_, d) => `${d * 24}:`).split(':').reduce((s, p) => s * 60 + Number(p), 0);
function amostra(pid) {
  const [time, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
  return { cpu: segundosDe(time), rssMb: Math.round(Number(rss) / 1024) };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarNucleo(filho) {
  for (let i = 0; i < 100; i++) {
    if (filho.exitCode !== null) throw new Error(`o núcleo saiu com código ${filho.exitCode}`);
    try { if ((await fetch(`${base}/api/overview`)).ok) return; } catch {}
    await dormir(200);
  }
  throw new Error('o núcleo não respondeu em 20 s');
}

const pastaTemp = rota === 'painel' ? mkdtempSync(join(tmpdir(), 'ahrena-carga-')) : null;
const nucleo = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', servidor, ...(rota === 'painel' ? ['--sem-github', '--sem-trava', ...(args.varredura ? ['--varredura', args.varredura] : [])] : [])], {
  env: { ...process.env, AHRENA_CONSOLE_PORT: String(porta), ...(pastaTemp ? { AHRENA_CONSOLE_DB: join(pastaTemp, 'nucleo.sqlite') } : {}) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const desligar = () => {
  if (nucleo.exitCode === null) nucleo.kill('SIGTERM');
  if (pastaTemp) rmSync(pastaTemp, { recursive: true, force: true });
};
process.on('exit', desligar);
process.on('SIGINT', () => process.exit(130));

try {
  await esperarNucleo(nucleo);
  let importacao = null;
  if (rota === 'painel') {
    // A importação inicial do histórico é uma vez só; o que se mede é o regime depois dela.
    const t = performance.now();
    for (;;) {
      const c = await (await fetch(`${base}/api/load`)).json();
      if (c.historico !== 'importando') break;
      if (performance.now() - t > 15 * 60_000) throw new Error('a importação passou de 15 min');
      await dormir(1000);
    }
    importacao = { segundos: Math.round((performance.now() - t) / 1000), ...amostra(nucleo.pid) };
  }
  // Aquecimento: a primeira leitura monta o índice; o que se mede é o regime.
  await fetch(rota === 'frota' ? `${base}/api/fleet` : rota === 'painel' ? `${base}/api/panel/${sessaoDoPainel}` : `${base}/api/sessao/aquecimento`).then((r) => r.text());
  await dormir(2000);

  const lat = [];
  let erros = 0;
  const caminho = (i) => (rota === 'frota' ? '/api/fleet?cols=121' : rota === 'painel' ? `/api/panel/${sessaoDoPainel}` : `/api/sessao/carga-${i}`);
  async function pedir(i) {
    const t = performance.now();
    try {
      const r = await fetch(base + caminho(i));
      await r.text();
      if (!r.ok) erros++;
    } catch { erros++; }
    lat.push(performance.now() - t);
  }

  const antes = amostra(nucleo.pid);
  const antesCarga = rota === 'painel' ? await (await fetch(`${base}/api/load`)).json() : null;
  const t0 = performance.now();
  const timers = [];
  // Hooks sintéticos das sessões abertas: um PreToolUse por vez, espalhados no minuto.
  let hooks = 0;
  if (hooksPorMin > 0) {
    let n = 0;
    timers.push(setInterval(() => {
      const s = `carga-hook-${n++ % sessoes}`;
      const corpo = { session_id: s, hook_event_name: 'PreToolUse', cwd: '/simulacao/carga', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${n}` };
      fetch(`${base}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }).then((r) => r.text()).then(() => hooks++, () => {});
    }, 60_000 / hooksPorMin));
  }
  for (let i = 0; i < abertos; i++) {
    // Cada painel começa num momento diferente, como sessões abertas em horas diferentes.
    timers.push(setTimeout(() => { void pedir(i); timers.push(setInterval(() => void pedir(i), INTERVALO_MS)); }, Math.random() * INTERVALO_MS));
  }
  await dormir(segundos * 1000);
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  const depois = amostra(nucleo.pid);
  const janela = (performance.now() - t0) / 1000;
  const depoisCarga = rota === 'painel' ? await (await fetch(`${base}/api/load`)).json() : null;

  lat.sort((a, b) => a - b);
  const q = (x) => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * x))]) : null);
  const resultado = {
    rota, sessoes, abertos, segundos: Math.round(janela),
    cpuPct: Number((((depois.cpu - antes.cpu) / janela) * 100).toFixed(2)),
    rssMb: depois.rssMb,
    pedidos: lat.length,
    pedidosPorMin: Math.round((lat.length / janela) * 60),
    erros,
    p50ms: q(0.5), p95ms: q(0.95), maxms: q(1),
    ...(rota === 'painel'
      ? {
          hooksPorMin, hooks, importacao,
          eventosLidosNaJanela: depoisCarga.eventosLidos - antesCarga.eventosLidos,
          arquivosDoSeguidor: depoisCarga.seguidor?.filesKnown ?? null,
          arquivosImportadosNaJanela: (depoisCarga.seguidor?.filesImported ?? 0) - (antesCarga.seguidor?.filesImported ?? 0),
          desktopLidosNaJanela: depoisCarga.desktopLidos - antesCarga.desktopLidos,
        }
      : {}),
  };
  console.log(`${rota}: ${sessoes} sessões, ${abertos} consultando · CPU ${resultado.cpuPct}% de um núcleo · ${resultado.rssMb} MB · ` +
    `${resultado.pedidosPorMin} pedidos/min · p50 ${resultado.p50ms} ms, p95 ${resultado.p95ms} ms · ${erros} erros`);
  console.log(JSON.stringify(resultado));
} finally {
  desligar();
}
