// The simulator's command line: `npm run simulate -- --chaos`. See the package README.
//
// Old option names (`--banco`, `--sessoes`, `--duracao`, `--caos`, `--intensidade`, `--tempo-real`,
// `--velocidade`, `--precos`) are still accepted until phase 6 of #173; the new one wins if both are
// given.

import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { simular } from './simulator.ts';

const HELP = `Usage: npm run simulate -- [options]

Generates synthetic sessions, agents, events and token usage and writes them through the storage port.

  --db <file>           target SQLite database (default: simulacao.sqlite)
  --seed <seed>         seed; the same seed generates the same data (default: random, printed)
  --sessions <n>        number of sessions (default: 12)
  --duration <min>      simulated window in minutes (default: 360)
  --chaos               injects stuck sessions, errors, abandonment, context overflow and swarms
  --intensity <0..1>    extra fraction of sessions with chaos (default: 0.4)
  --real-time           writes at the pace of the clock instead of all at once
  --speed <x>           simulated minutes per clock minute, in real time (default: 30)
  --prices              writes illustrative prices for the simulated models without a price
  -h, --help            this help

The old names (--banco, --sessoes, --duracao, --caos, --intensidade, --tempo-real, --velocidade, --precos) are accepted until phase 6.
`;

function number(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(value)}`);
  return n;
}

const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    seed: { type: 'string' },
    sessions: { type: 'string' },
    duration: { type: 'string' },
    chaos: { type: 'boolean', default: false },
    intensity: { type: 'string' },
    'real-time': { type: 'boolean', default: false },
    speed: { type: 'string' },
    prices: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    // Old names, accepted until phase 6.
    banco: { type: 'string' },
    sessoes: { type: 'string' },
    duracao: { type: 'string' },
    caos: { type: 'boolean', default: false },
    intensidade: { type: 'string' },
    'tempo-real': { type: 'boolean', default: false },
    velocidade: { type: 'string' },
    precos: { type: 'boolean', default: false },
  },
});

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// The new name wins; the old one is the fallback.
const db = args.db ?? args.banco ?? 'simulacao.sqlite';
const sessions = args.sessions !== undefined ? number('sessions', args.sessions) : number('sessoes', args.sessoes);
const duration = args.duration !== undefined ? number('duration', args.duration) : number('duracao', args.duracao);
const intensity = args.intensity !== undefined ? number('intensity', args.intensity) : number('intensidade', args.intensidade);
const speed = args.speed !== undefined ? number('speed', args.speed) : number('velocidade', args.velocidade);
const chaos = args.chaos || args.caos;
const prices = args.prices || args.precos;
const realTime = args['real-time'] || args['tempo-real'];

const seed = args.seed ?? String(Math.floor(Math.random() * 1_000_000));
const modo = realTime ? 'tempo-real' : 'lote';
const storage = openSqliteStorage({ path: db });
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());

console.log(`simulating into ${db} · seed ${seed} · ${realTime ? 'real time' : 'batch'}${chaos ? ' · chaos' : ''}`);
if (realTime) console.log('Ctrl+C to stop; what was already written stays.');

try {
  const resumo = await simular(storage, {
    semente: seed,
    sessoes: sessions,
    duracaoMin: duration,
    caos: chaos,
    intensidadeDoCaos: intensity,
    modo,
    velocidade: speed,
    precos: prices,
    signal: stop.signal,
    aoGravar: realTime
      ? (op) => {
          if (op.tipo === 'evento') console.log(`${op.registro.createdAt}  ${op.registro.sessionId}  ${op.registro.type}  ${op.registro.summary ?? ''}`);
        }
      : undefined,
  });
  const scripts = Object.entries(resumo.roteiros)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${r} ${n}`)
    .join(', ');
  const g = resumo.gravados;
  console.log(`${resumo.interrompido ? 'interrupted' : 'done'}: ${g.contas} accounts, ${g.sessoes} sessions, ${g.agentes} agents, ${g.eventos} new events, ${g.usos} usage writes, ${g.precos} prices`);
  console.log(`scripts: ${scripts}`);
  console.log(`to repeat: npm run simulate -- --seed ${seed}${chaos ? ' --chaos' : ''}`);
} finally {
  await storage.close();
}
