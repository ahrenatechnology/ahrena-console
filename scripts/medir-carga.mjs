#!/usr/bin/env node
// Mede quanto o núcleo de teste pesa sob a carga dos painéis (issue #81, decisão 0004).
//
// Sobe o núcleo numa porta separada, simula as sessões consultando, e mede CPU e
// memória do processo do núcleo (`ps`) e a latência de cada pedido. No fim desliga o
// núcleo. Não chama o GitHub: só as rotas que leem ~/.claude/projects.
//
// Uso:
//   node scripts/medir-carga.mjs [--rota sessao|frota] [--sessoes 20] [--abertos 1]
//                                [--segundos 60] [--porta 4799] [--servidor caminho]
//
//   --rota sessao  comportamento novo: só os `--abertos` painéis consultam, cada um
//                  /api/sessao/<id> a cada 5 s; as outras sessões não pedem nada.
//   --rota frota   comportamento antigo: todas as `--sessoes` consultam /api/fleet a
//                  cada 5 s, com o painel aberto ou não (`--abertos` não conta).
//   --servidor     o server.mjs a medir (padrão: spikes/nucleo-teste/server.mjs).
//
// CPU é o tempo de CPU do processo do núcleo durante a janela de carga dividido pela
// duração da janela: 100% é um núcleo de CPU inteiro.
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pares, a, i, l) => (a.startsWith('--') ? [...pares, [a.slice(2), l[i + 1]]] : pares), []),
);
const rota = args.rota ?? 'sessao';
const sessoes = Number(args.sessoes ?? 20);
const abertos = rota === 'frota' ? sessoes : Math.min(sessoes, Number(args.abertos ?? 1));
const segundos = Number(args.segundos ?? 60);
const porta = Number(args.porta ?? 4799);
const servidor = resolve(raiz, args.servidor ?? 'spikes/nucleo-teste/server.mjs');
const base = `http://127.0.0.1:${porta}`;
const INTERVALO_MS = 5000;

if (!['sessao', 'frota'].includes(rota)) throw new Error(`--rota sessao ou frota, não ${rota}`);
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

const nucleo = spawn(process.execPath, [servidor], {
  env: { ...process.env, AHRENA_CONSOLE_PORT: String(porta) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const desligar = () => { if (nucleo.exitCode === null) nucleo.kill('SIGTERM'); };
process.on('exit', desligar);
process.on('SIGINT', () => process.exit(130));

try {
  await esperarNucleo(nucleo);
  // Aquecimento: a primeira leitura monta o índice; o que se mede é o regime.
  await fetch(rota === 'frota' ? `${base}/api/fleet` : `${base}/api/sessao/aquecimento`).then((r) => r.text());
  await dormir(2000);

  const lat = [];
  let erros = 0;
  const caminho = (i) => (rota === 'frota' ? '/api/fleet?cols=121' : `/api/sessao/carga-${i}`);
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
  const t0 = performance.now();
  const timers = [];
  for (let i = 0; i < abertos; i++) {
    // Cada painel começa num momento diferente, como sessões abertas em horas diferentes.
    timers.push(setTimeout(() => { void pedir(i); timers.push(setInterval(() => void pedir(i), INTERVALO_MS)); }, Math.random() * INTERVALO_MS));
  }
  await dormir(segundos * 1000);
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  const depois = amostra(nucleo.pid);
  const janela = (performance.now() - t0) / 1000;

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
  };
  console.log(`${rota}: ${sessoes} sessões, ${abertos} consultando · CPU ${resultado.cpuPct}% de um núcleo · ${resultado.rssMb} MB · ` +
    `${resultado.pedidosPorMin} pedidos/min · p50 ${resultado.p50ms} ms, p95 ${resultado.p95ms} ms · ${erros} erros`);
  console.log(JSON.stringify(resultado));
} finally {
  desligar();
}
