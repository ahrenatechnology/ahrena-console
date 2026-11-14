// The calls the Console never allows, only the person at the terminal (decision 0025, "Por tipo de chamada", #618/AC-6).
// The Console can still deny them, which is the safe side; pure: no disk, no socket, no clock (#618).
// The check is by text, a floor and not the defence (`$HOME/.ahr*` slips past it): the defence is the window credential (#619).
// The data folders of the other instances in the instance registry are added to the citing check by a later layer (#618).

// `sh -c "$(curl …)"` and a shell or `source` fed by process substitution `<(curl …)` (#618/AC-6).
const COMMAND_PATTERNS: RegExp[] = [/\bsudo\b/, /\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/, /\b(?:(?:ba|z|da|k)?sh|fish|source)\s+<\(\s*(?:curl|wget)\b/, /(?:^|[\s;&|])\.\s+<\(\s*(?:curl|wget)\b/];

/** Files whose change changes what runs or what is secret, case-insensitive as the macOS disk is (#618/AC-6). */
const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(?:^|[^A-Za-z0-9_.-])\.claude\/(?:settings[^/\s]*\.json|hooks\/)/i,
  /(?:^|[^A-Za-z0-9_.-])\.mcp\.json(?![A-Za-z0-9_-])/i,
  /(?:^|[^A-Za-z0-9_.-])\.env(?![A-Za-z0-9_-])/i,
  /(?:^|[^A-Za-z0-9_.-])\.ssh\//i,
];

/** What the agent could read the owner token from, or swap the hook through: cited anywhere in a command or a path (#618/AC-6). */
const CITED_PATTERNS: RegExp[] = [/\.ahrena-console/i, /dev\.ahrena\.console/i, /\.claude\/plugins\b/i];

const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern'] as const;

/** `/a/./b` and `/a//b` read as `/a/b`, so a path cannot dodge a pattern by spelling (#618/AC-6). */
const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');

const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const FORCE_PUSH = /^(?:--force(?:-with-lease)?(?:=.*)?|-f|\+\S.*)$/;
const FORCE_CLEAN = /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force)$/;
const bare = (token: string): string => token.replace(/^["'(]+|["')]+$/g, '');
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/** Git options that take the next word as their argument; any other leading `-…` is skipped alone, the safe side (#618/AC-6). */
const GIT_OPTIONS_WITH_ARGUMENT = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

/** The git subcommand and where its words start, after the global options (`-C x`, `-c k=v`, `--git-dir …`) (#618/AC-6). */
function gitCall(tokens: string[], at: number): { sub: string; from: number } | null {
  let i = at + 1;
  while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) i += GIT_OPTIONS_WITH_ARGUMENT.has(tokens[i] ?? '') ? 2 : 1;
  const sub = tokens[i];
  return sub === undefined ? null : { sub, from: i + 1 };
}

/** A tokenised scan, one pass per command segment, so the cost is linear in the command: each git call reads up to the next one (#618/AC-6, 64 KiB bound in 0025). */
function hasRiskyVerb(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean).map(bare);
  const rm = tokens.findIndex((t) => baseName(t) === 'rm');
  if (rm >= 0 && tokens.slice(rm + 1).some((t) => RECURSIVE_FLAG.test(t))) return true;
  const gits = tokens.flatMap((t, i) => (baseName(t) === 'git' ? [i] : []));
  for (const [n, at] of gits.entries()) {
    const call = gitCall(tokens, at);
    if (call === null) continue;
    const rest = tokens.slice(call.from, gits[n + 1] ?? tokens.length);
    if (call.sub === 'push' && rest.some((t) => FORCE_PUSH.test(t))) return true;
    if (call.sub === 'clean' && rest.some((t) => FORCE_CLEAN.test(t))) return true;
    if (call.sub === 'reset' && rest.includes('--hard')) return true;
  }
  return false;
}

/** `curl x | sh`: a segment with a download followed, in any later segment of the line, by a shell (#618/AC-6). */
function pipesDownloadIntoShell(line: string): boolean {
  const parts = line.split('|');
  let download = -1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (download >= 0 && isShellSegment(part)) return true;
    if (download < 0 && /\b(?:curl|wget)\b/.test(part)) download = i;
  }
  return false;
}

/** A pipe segment that runs a shell, possibly behind `sudo` or `env` or a path (#618/AC-6). */
function isShellSegment(part: string): boolean {
  const tokens = part.split(/\s+/).filter(Boolean).map(bare);
  const first = tokens.findIndex((t) => t !== 'sudo' && t !== 'env' && !t.includes('='));
  return first >= 0 && SHELLS.has(baseName(tokens[first] ?? ''));
}

function commandIsTerminalOnly(command: string): boolean {
  if (COMMAND_PATTERNS.some((re) => re.test(command))) return true;
  if (command.split('\n').some(pipesDownloadIntoShell)) return true;
  return command.split(/[|;&\n]+/).some(hasRiskyVerb);
}

/** An input that cannot be read (not an object, no readable command on a Bash call) is terminal-only: the safe side (#618/AC-6). */
export function isTerminalOnly(toolName: string, toolInput: unknown): boolean {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return true;
  const fields = toolInput as Record<string, unknown>;
  const command = fields['command'];
  if (toolName === 'Bash' && typeof command !== 'string') return true;

  const paths = PATH_FIELDS.map((f) => fields[f]).filter((v): v is string => typeof v === 'string').map(normalizePath);
  const commandText = typeof command === 'string' ? normalizePath(command) : null;
  const cited = commandText === null ? paths : [...paths, commandText];
  if (cited.some((text) => CITED_PATTERNS.some((re) => re.test(text)))) return true;
  if (typeof command === 'string' && commandIsTerminalOnly(command)) return true;
  return cited.some((text) => PROTECTED_PATH_PATTERNS.some((re) => re.test(text)));
}
