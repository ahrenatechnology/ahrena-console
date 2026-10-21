// The simulator's command line: `npm run simulate -- --chaos`. See the package README.

import { parseArgs } from 'node:util';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import { simulate } from './simulator.ts';

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
  },
});

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const db = args.db ?? 'simulacao.sqlite';
const sessions = number('sessions', args.sessions);
const duration = number('duration', args.duration);
const intensity = number('intensity', args.intensity);
const speed = number('speed', args.speed);
const chaos = args.chaos;
const prices = args.prices;
const realTime = args['real-time'];

const seed = args.seed ?? String(Math.floor(Math.random() * 1_000_000));
const storage = openSqliteStorage({ path: db });
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());

console.log(`simulating into ${db} · seed ${seed} · ${realTime ? 'real time' : 'batch'}${chaos ? ' · chaos' : ''}`);
if (realTime) console.log('Ctrl+C to stop; what was already written stays.');

try {
  const summary = await simulate(storage, {
    seed,
    sessions,
    durationMin: duration,
    chaos,
    chaosIntensity: intensity,
    mode: realTime ? 'real-time' : 'batch',
    speed,
    prices,
    signal: stop.signal,
    onWrite: realTime
      ? (op) => {
          if (op.kind === 'event') console.log(`${op.record.createdAt}  ${op.record.sessionId}  ${op.record.type}  ${op.record.summary ?? ''}`);
        }
      : undefined,
  });
  const scripts = Object.entries(summary.scripts)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${r} ${n}`)
    .join(', ');
  const w = summary.written;
  console.log(`${summary.interrupted ? 'interrupted' : 'done'}: ${w.accounts} accounts, ${w.sessions} sessions, ${w.agents} agents, ${w.events} new events, ${w.usages} usage writes, ${w.prices} prices`);
  console.log(`scripts: ${scripts}`);
  console.log(`to repeat: npm run simulate -- --seed ${seed}${chaos ? ' --chaos' : ''}`);
} finally {
  await storage.close();
}
