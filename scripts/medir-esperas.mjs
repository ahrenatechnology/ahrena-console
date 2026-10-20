#!/usr/bin/env node
// Mede quanto o núcleo gasta com esperas de long polling abertas (item 2.4), parado e com hooks.
//
// Sobe a API local de produção (packages/nucleo/src/api/cli.ts) num banco temporário, sem histórico,
// sem Desktop e sem GitHub: os hooks sintéticos entram pelo receptor de verdade (POST /api/hooks),
// passam pela ingestão, pela máquina de estados e pelo cursor de mudanças. Mede o tempo de CPU do
// processo (`ps`) em quatro janelas:
//
//   1. parado, sem esperas (a linha de base);
//   2. parado, com `--esperas` pedidos GET /api/changes que ninguém acorda;
//   3. com `--hooks-por-min` hooks das `--sessoes`, sem esperas;
//   4. com os hooks e as esperas.
//
// Cada espera que responde é reaberta na hora com o cursor novo, como faria a bandeja. Os hooks de
// cada sessão seguem um turno: UserPromptSubmit, quatro pares PreToolUse/PostToolUse e Stop. Nenhum
// dado real: sessões e comandos são inventados.
//
// Uso: node scripts/medir-esperas.mjs [--esperas 50] [--segundos 60] [--espera 25]
//                                     [--hooks-por-min 600] [--sessoes 20] [--porta 4798]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pares, a, i, l) => (a.startsWith('--') ? [...pares, [a.slice(2), l[i + 1]]] : pares), []),
);
const esperas = Number(args.esperas ?? 50);
const segundos = Number(args.segundos ?? 60);
const espera = Number(args.espera ?? 25);
const hooksPorMin = Number(args['hooks-por-min'] ?? 600);
const sessoes = Number(args.sessoes ?? 20);
const porta = Number(args.porta ?? 4798);
if (porta === 4720) throw new Error('a 4720 é a porta do núcleo de uso; meça em outra');
const base = `http://127.0.0.1:${porta}`;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const segundosDe = (t) => t.trim().replace(/^(\d+)-/, (_, d) => `${d * 24}:`).split(':').reduce((s, p) => s * 60 + Number(p), 0);
function amostra(pid) {
  const [time, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
  return { cpu: segundosDe(time), rssMb: Math.round(Number(rss) / 1024) };
}

const TURNO = ['UserPromptSubmit', ...Array(4).fill(['PreToolUse', 'PostToolUse']).flat(), 'Stop'];
function hookDe(n) {
  const s = n % sessoes;
  const passo = Math.floor(n / sessoes) % TURNO.length;
  const evento = TURNO[passo];
  const corpo = { session_id: `00000000-0000-4000-8000-${String(s).padStart(12, '0')}`, hook_event_name: evento, cwd: '/simulacao/carga', transcript_path: '/simulacao/carga.jsonl' };
  if (evento === 'UserPromptSubmit') corpo.prompt = 'rode os testes';
  if (evento.endsWith('ToolUse')) Object.assign(corpo, { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `toolu_${Math.floor(n / 2)}` });
  if (evento === 'PostToolUse') corpo.tool_response = { stdout: 'ok' };
  return corpo;
}

const pasta = mkdtempSync(join(tmpdir(), 'medir-esperas-'));
const filho = spawn(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    resolve(raiz, 'packages/nucleo/src/api/cli.ts'),
    '--porta', String(porta), '--banco', join(pasta, 'nucleo.sqlite'),
    '--sem-historico', '--sem-desktop', '--sem-github', '--sem-trava',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
try {
  for (let i = 0; ; i++) {
    if (filho.exitCode !== null) throw new Error(`o núcleo saiu com código ${filho.exitCode}`);
    try { if ((await fetch(`${base}/api/overview`)).ok) break; } catch {}
    if (i > 100) throw new Error('o núcleo não subiu');
    await dormir(200);
  }

  let n = 0;
  let hooks = 0;
  const enviar = () =>
    fetch(`${base}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hookDe(n++)) })
      .then((r) => r.text())
      .then(() => hooks++, () => {});
  // Aquece: cada sessão passa por um turno inteiro antes de medir.
  for (let i = 0; i < sessoes * TURNO.length; i++) await enviar();
  await dormir(2000);

  async function janela(nome, comEsperas, comHooks) {
    let ligado = true;
    let respostas = 0;
    let comMudanca = 0;
    const { cursor } = await (await fetch(`${base}/api/changes`)).json();
    async function laco() {
      let c = cursor;
      while (ligado) {
        const r = await (await fetch(`${base}/api/changes?since=${c}&wait=${espera}`)).json();
        if (!ligado) break;
        respostas++;
        if (r.changes.length) comMudanca++;
        c = r.cursor;
      }
    }
    const lacos = comEsperas ? Array.from({ length: esperas }, laco) : [];
    const h0 = hooks;
    const timer = comHooks ? setInterval(enviar, 60_000 / hooksPorMin) : null;
    await dormir(1000);
    const abertas = (await (await fetch(`${base}/api/load`)).json()).openWaits;
    const r0 = respostas;
    const m0 = comMudanca;
    const a = amostra(filho.pid);
    await dormir(segundos * 1000);
    const b = amostra(filho.pid);
    const resp = respostas - r0;
    clearInterval(timer);
    ligado = false;
    void lacos;
    return { nome, abertas, hooks: hooks - h0, respostas: resp, comMudanca: comMudanca - m0, cpuPct: ((b.cpu - a.cpu) / segundos) * 100, rssMb: b.rssMb };
  }

  const linhas = [
    await janela('parado, sem esperas', false, false),
    await janela(`parado, ${esperas} esperas`, true, false),
    await janela(`${hooksPorMin} hooks/min, sem esperas`, false, true),
    await janela(`${hooksPorMin} hooks/min, ${esperas} esperas`, true, true),
  ];
  console.log(`API de produção, banco temporário, ${sessoes} sessões sintéticas, janelas de ${segundos} s, esperas de ${espera} s`);
  console.log('| Janela | CPU | RSS | Esperas abertas | Hooks | Respostas |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const l of linhas) {
    console.log(`| ${l.nome} | ${l.cpuPct.toFixed(2)} % | ${l.rssMb} MB | ${l.abertas} | ${l.hooks} | ${l.respostas} (${l.comMudanca} com mudança) |`);
  }
} finally {
  filho.kill('SIGTERM');
  rmSync(pasta, { recursive: true, force: true });
}
process.exit(0);
