// The contract of the Agent Config screen (#63, wireframes C16 and C17): what the core reads from
// the Claude Code configuration folders and from the project's `.claude`. Only names, paths and
// counts: no settings value, no hook command, no MCP `env`/`command`/`url`, no memory content.
// Content only leaves for a skill, through the skill route (skills.ts).

export type AgentConfigScope = 'user' | 'project';

/**
 * A root card. `home` is the configuration folder; `claude-json`, its `.claude.json`;
 * `project-claude`, `<project>/.claude`; `project`, the project root. Only `home` and
 * `project-claude` take skills (their `id` is the `root` of the skill routes).
 */
export interface AgentConfigRoot {
  /** Opaque and stable while the folders do not change: `u0`, `u1`… (home), `c0`… (`.claude.json`), `p`, `r`. */
  id: string;
  scope: AgentConfigScope;
  kind: 'home' | 'project-claude' | 'project' | 'claude-json';
  label: string;
  path: string;
}

export interface Count {
  total: number;
  user: number;
  project: number;
}

export interface ListedSkill {
  /** The skill folder name: the key for reading and writing. */
  name: string;
  /** The frontmatter `name`, when it differs from the folder (Claude Code shows this one). */
  declaredName: string | null;
  description: string | null;
  scope: AgentConfigScope;
  root: string;
  path: string;
  editedAt: number;
  /** `false` when the folder name does not match the write pattern: read-only. */
  editable: boolean;
}

export interface ListedSubagent {
  name: string;
  description: string | null;
  scope: AgentConfigScope;
  root: string;
  path: string;
}

export interface ListedCommand {
  /** Path relative to `commands/` without `.md`, with `:` instead of `/` (as Claude Code calls it). */
  name: string;
  scope: AgentConfigScope;
  root: string;
  path: string;
}

export interface ListedMemory {
  name: string;
  scope: AgentConfigScope;
  path: string;
  /** `instructions`: a `CLAUDE.md`/`CLAUDE.local.md`; `auto`: the project's automatic memory. */
  kind: 'instructions' | 'auto';
}

export interface ListedMcp {
  name: string;
  scope: AgentConfigScope;
  source: '.claude.json' | '.mcp.json';
}

export interface ListedPlugin {
  /** `name@marketplace`, as in `enabledPlugins`. */
  name: string;
  scope: AgentConfigScope;
}

export interface ListedHook {
  event: string;
  /** How many hooks the event has in this scope, summed across files. */
  count: number;
  scope: AgentConfigScope;
}

export interface ListedSettings {
  file: 'settings.json' | 'settings.local.json' | '.claude.json';
  scope: AgentConfigScope;
  path: string;
}

export type SummaryKey = 'skills' | 'subagents' | 'commands' | 'mcp' | 'plugins' | 'hooks' | 'memory' | 'settings';

export interface AgentConfig {
  project: string | null;
  projects: string[];
  roots: AgentConfigRoot[];
  summary: Record<SummaryKey, Count>;
  skills: ListedSkill[];
  subagents: ListedSubagent[];
  commands: ListedCommand[];
  memory: ListedMemory[];
  mcp: ListedMcp[];
  plugins: ListedPlugin[];
  hooks: ListedHook[];
  settings: ListedSettings[];
  editing: true;
}

/** Error carrying the HTTP status the route returns. */
export class AgentConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
