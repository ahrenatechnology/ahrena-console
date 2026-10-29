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
  --no-github            No GitHub at all: the work shows only the branch, the connection
                         (/api/connections) is unavailable "github-off", the project kanban
                         (/api/project) answers 503 and the repositories (/api/repos) and the
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
  --demo-github <state>  Under --demo, the GitHub connection's state, on the fake GitHub with an
                         in-memory vault and a fake gh (never the real GitHub, Keychain or gh):
                         connected (default), disconnected (Connect is approved after 3 s),
                         pending (a code never approved), denied, expired (the code expires
                         after 5 s), missing-scopes, blocked-orgs, no-client-id, no-vault, gh,
                         gh-not-authenticated
  --demo-project <p>     Under --demo, selected (default: the simulator's Project) or none (the
                         kanban asks to choose one)
  --parent <pid>         Exits when this process goes away (the app or the extension), unless
                         another client is registered. When adopting, registers the pid as a client
  --replace              Also replaces a running core of this version on an ancestor commit. A
                         running core of an older version is always stopped and replaced (#220).
                         Other code: only warns
  --no-lock              Neither reads nor writes <data-dir>/nucleo.json nor the instance registry
                         (measurements on a separate port). --demo is already lock-free. Both fail if
                         the port has an owner
  --no-telemetry         Does not measure this machine: /api/machines and /api/telemetry answer 404.
  --accept-remote-actions  Takes POST /api/ports/release without Origin, which is how a Mac's núcleo reaches this one
                         through the tunnel (decision 0016). Default off; AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1 does the same.
                         Under --demo, the telemetry is synthetic (this machine and a "workstation")
  --machines <file>      The remote machines (default ~/.ahrena-console/machines.json, #176):
                         { "machines": [{ "id", "label", "port", "reconnect"? }] }, port is the port
                         of this Mac that your tunnel forwards to 4720 over there. Without a file,
                         only this machine. Re-read every 30 s and before a reconnect (#244);
                         --demo does not read it
  --help

GitHub (decision 0011): the console connects by itself, with the OAuth device flow, and keeps the
credential in the Keychain (macOS) or the Secret Service (Linux), never in a file. The Ahrena OAuth App is
built in; AHRENA_CONSOLE_GITHUB_CLIENT_ID overrides it with another app's Client ID (development).
AHRENA_CONSOLE_GITHUB_SOURCE=gh uses \`gh auth token\` instead (opt-in, for development).
AHRENA_CONSOLE_VAULT=keychain|secret-service|memory|none overrides the vault this platform has
(memory keeps nothing across restarts; none makes the connection unavailable). Under node --test only
memory or none is honoured, never the real Keychain or Secret Service.

Project kanban (GET /api/project, POST /api/project/move): the Project chosen on the screen
(GET /api/project/options, POST /api/project/selection). AHRENA_CONSOLE_PROJECT=owner/number, when
set, wins over the choice. There is no default Project.

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
  /** --accept-remote-actions: take a port release that arrives without Origin (the tunnel, from a Mac's núcleo). Off by default (decision 0016). */
  acceptRemoteActions: boolean;
  machines: string | undefined;
  /** --demo-github: the connection state under --demo (src/simulator/demo-github-connection.ts). */
  demoGithub: string | undefined;
  /** --demo-project: `selected` or `none`. */
  demoProject: string | undefined;
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
      'accept-remote-actions': { type: 'boolean', default: false },
      machines: { type: 'string' },
      'demo-github': { type: 'string' },
      'demo-project': { type: 'string' },
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
    acceptRemoteActions: o['accept-remote-actions'] || process.env.AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS === '1',
    machines: o.machines,
    demoGithub: o['demo-github'],
    demoProject: o['demo-project'],
    help: o.help,
  };
}
