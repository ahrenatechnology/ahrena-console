// The options of the API command line (`npm run api -- --help`), parsed apart from cli.ts so a test
// can check them without starting a core.
//
// The old Portuguese names (`--porta`, `--banco`, `--cenario`…) left in phase 6 of #173: an unknown
// option is an error.

import { parseArgs } from 'node:util';

export const HELP = `Usage: npm run api -- [options]

  --port <n>             Port on 127.0.0.1. Default AHRENA_CONSOLE_CORE_PORT, AHRENA_CONSOLE_PORT or 0:
                         the system picks a free one, and the core announces it in the log, in the
                         lock and in the instance registry (~/.ahrena-console/instances/)
  --installation <i>     app, dev or mcpb (default dev). Each installation has its own core and its
                         own data folder, and never adopts another one's core
  --data-dir <folder>    Database, log, clients and lock. Default AHRENA_CONSOLE_DATA_DIR or the
                         installation's folder: dev ~/.ahrena-console, app ~/Library/Application
                         Support/dev.ahrena.console, mcpb ~/.ahrena-console/installations/mcpb
  --db <file>            The core's SQLite. Default AHRENA_CONSOLE_DB or <data-dir>/nucleo.sqlite
  --projects <folder>    Transcripts to follow. Default ~/.claude/projects
  --no-history           Neither imports nor follows transcripts (hooks only)
  --scan-interval <s>    The follower's fallback scan, in seconds. Default 30: fs.watch reports
                         each write at once; the scan only covers a missed report
  --no-desktop           Does not read the Claude Desktop session index
  --no-github            The work shows only the branch, without calling GitHub, the project
                         kanban (/api/project) answers 503 and the repositories (/api/repos) and the
                         agent instructions (/api/agent-instructions) answer "sem-github"; the ADRs
                         and PDRs (/api/adrs, /api/pdrs) answer "no-github"
  --demo                 In-memory database with a simulator panel scenario, no history, no
                         Desktop and no GitHub: synthetic data only. The panel session, whichever
                         it is, shows the scenario, and the project kanban is wireframe C11's, on
                         a fake GitHub (moving works in memory). The Agent Config screen reads a
                         fictitious configuration folder and project in a temporary folder,
                         deleted on exit
  --scenario <p1..p13>   The demo scenario (default p1), as in the wireframes. The demo also
                         writes the /ui Detail: a session asking for permission
                         (/ui/sessions/sim-detail-orders) and the tools of the scenario's session
  --parent <pid>         Exits when this process goes away (the app or the extension), unless
                         another client is registered. When adopting, registers the pid as a client
  --replace              If the running core is older than this one (version, or a commit that is
                         an ancestor of this one), stops it and starts this one. Other code: only warns
  --no-lock              Neither reads nor writes <data-dir>/nucleo.json nor the instance registry
                         (measurements on a separate port). --demo is already lock-free. Both fail if
                         the port has an owner
  --no-telemetry         Does not measure this machine: /api/machines and /api/telemetry answer 404.
                         Under --demo, the telemetry is synthetic (this machine and a "workstation")
  --machines <file>      The remote machines (default ~/.ahrena-console/machines.json, #176):
                         { "machines": [{ "id", "label", "port", "reconnect"? }] }, port is the port
                         of this Mac that your tunnel forwards to 4720 over there. Without a file,
                         only this machine. Re-read every 30 s and before a reconnect (#244);
                         --demo does not read it
  --help

Project kanban (GET /api/project, POST /api/project/move): the Project in
AHRENA_CONSOLE_PROJECT=owner/number, with the \`gh\` token (\`project\` scope) and the cache in the
core's database. Without the variable there is no Project: the screen explains how to pick one.

If a core is already up for this installation, this one does not start another: it adopts the running one
(prints the port and the version, warns if the code differs) and exits with 0. See src/owner/README.md.
`;

/** The API's options. */
export interface ApiCliOptions {
  port: string | undefined;
  installation: string | undefined;
  dataDir: string | undefined;
  db: string | undefined;
  projects: string | undefined;
  /** Seconds, as given; the default is 30. */
  scanInterval: string;
  noHistory: boolean;
  noDesktop: boolean;
  noGithub: boolean;
  demo: boolean;
  scenario: string;
  parent: string | undefined;
  replace: boolean;
  noLock: boolean;
  noTelemetry: boolean;
  machines: string | undefined;
  help: boolean;
}

export function parseApiOptions(args: string[]): ApiCliOptions {
  const { values: o } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      installation: { type: 'string' },
      'data-dir': { type: 'string' },
      db: { type: 'string' },
      projects: { type: 'string' },
      'scan-interval': { type: 'string' },
      'no-history': { type: 'boolean', default: false },
      'no-desktop': { type: 'boolean', default: false },
      'no-github': { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      scenario: { type: 'string' },
      parent: { type: 'string' },
      replace: { type: 'boolean', default: false },
      'no-lock': { type: 'boolean', default: false },
      'no-telemetry': { type: 'boolean', default: false },
      machines: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  return {
    port: o.port,
    installation: o.installation,
    dataDir: o['data-dir'],
    db: o.db,
    projects: o.projects,
    scanInterval: o['scan-interval'] ?? '30',
    noHistory: o['no-history'],
    noDesktop: o['no-desktop'],
    noGithub: o['no-github'],
    demo: o.demo,
    scenario: o.scenario ?? 'p1',
    parent: o.parent,
    replace: o.replace,
    noLock: o['no-lock'],
    noTelemetry: o['no-telemetry'],
    machines: o.machines,
    help: o.help,
  };
}
