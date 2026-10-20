// The options of the API command line (`npm run api -- --help`), parsed apart from cli.ts so a test
// can check them without starting a core.
//
// Old option names (`--porta`, `--banco`, `--projetos`, `--varredura`, `--sem-historico`, `--sem-desktop`,
// `--sem-github`, `--cenario`, `--pai`, `--substituir`, `--sem-trava`) are still accepted until phase 6
// of #173: src/owner/start.ts starts the API with `--porta` and `--pai`, and scripts/medir-*.mjs pass
// the old ones too. They are hidden from the help, and the new one wins if both are given.

import { parseArgs } from 'node:util';

export const HELP = `Usage: npm run api -- [options]

  --port <n>             Port on 127.0.0.1. Default AHRENA_CONSOLE_PORT or 4720
  --db <file>            The core's SQLite. Default AHRENA_CONSOLE_DB or ~/.ahrena-console/nucleo.sqlite
  --projects <folder>    Transcripts to follow. Default ~/.claude/projects
  --no-history           Neither imports nor follows transcripts (hooks only)
  --scan-interval <s>    The follower's fallback scan, in seconds. Default 30: fs.watch reports
                         each write at once; the scan only covers a missed report
  --no-desktop           Does not read the Claude Desktop session index
  --no-github            The work shows only the branch, without calling GitHub, the project
                         kanban (/api/project) answers 503 and the repositories (/api/repos)
                         answer "sem-github"
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
  --no-lock              Neither reads nor writes ~/.ahrena-console/nucleo.json (measurements on a
                         separate port). --demo is already lock-free. Both fail if the port has an owner
  --no-telemetry         Does not measure this machine: /api/machines and /api/telemetry answer 404.
                         Under --demo, the telemetry is synthetic (this machine and a "workstation")
  --machines <file>      The remote machines (default ~/.ahrena-console/machines.json, #176):
                         { "machines": [{ "id", "label", "port" }] }, port is the port of this Mac
                         that your tunnel forwards to 4720 over there. Without a file, only this
                         machine. Read at start; --demo does not read it
  --help

The old names (--porta, --banco, --projetos, --varredura, --sem-historico, --sem-desktop, --sem-github, --cenario, --pai, --substituir, --sem-trava) are accepted until phase 6.

Project kanban (GET /api/project, POST /api/project/move): the Project in
AHRENA_CONSOLE_PROJECT=owner/number, with the \`gh\` token (\`project\` scope) and the cache in the
core's database. Without the variable there is no Project: the screen explains how to pick one.

If a core is already up on this machine, this one does not start another: it adopts the running one
(prints the port and the version, warns if the code differs) and exits with 0. See src/owner/README.md.
`;

/** The API's options, with the old names already folded into the new ones. */
export interface ApiCliOptions {
  port: string | undefined;
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
      // Old names, accepted until phase 6.
      porta: { type: 'string' },
      banco: { type: 'string' },
      projetos: { type: 'string' },
      varredura: { type: 'string' },
      'sem-historico': { type: 'boolean', default: false },
      'sem-desktop': { type: 'boolean', default: false },
      'sem-github': { type: 'boolean', default: false },
      cenario: { type: 'string' },
      pai: { type: 'string' },
      substituir: { type: 'boolean', default: false },
      'sem-trava': { type: 'boolean', default: false },
    },
  });
  // The new name wins; the old one is the fallback.
  return {
    port: o.port ?? o.porta,
    db: o.db ?? o.banco,
    projects: o.projects ?? o.projetos,
    scanInterval: o['scan-interval'] ?? o.varredura ?? '30',
    noHistory: o['no-history'] || o['sem-historico'],
    noDesktop: o['no-desktop'] || o['sem-desktop'],
    noGithub: o['no-github'] || o['sem-github'],
    demo: o.demo,
    // The panel scenario ids (p1…p13) have no old form; only session ids do (src/simulator/legacy-ids.ts).
    scenario: o.scenario ?? o.cenario ?? 'p1',
    parent: o.parent ?? o.pai,
    replace: o.replace || o.substituir,
    noLock: o['no-lock'] || o['sem-trava'],
    noTelemetry: o['no-telemetry'],
    machines: o.machines,
    help: o.help,
  };
}
