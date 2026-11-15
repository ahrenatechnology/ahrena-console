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
  /\.env/i,
  /(?:^|[^A-Za-z0-9_.-])\.ssh\//i,
];

/** What the agent could read the owner token from, or swap the hook through: cited anywhere in a command or a path (#618/AC-6). */
const CITED_PATTERNS: RegExp[] = [/\.ahrena-console/i, /dev\.ahrena\.console/i, /\.claude\/plugins\b/i];

const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern'] as const;

/** `/a/./b` and `/a//b` read as `/a/b`, so a path cannot dodge a pattern by spelling (#618/AC-6). */
const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');

const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const bare = (token: string): string => token.replace(/^["'(]+|["')]+$/g, '');
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/** Quotes never hide a word: they read as spaces, so `"git" 'push'` is `git push` (#618/AC-9). */
const stripQuotes = (text: string): string => text.replace(/["'`]/g, ' ');

const RISKY_GIT_SUBCOMMANDS = new Set(['push', 'reset', 'clean']);

/** A tokenised scan, one pass per command segment (linear in the command, 64 KiB bound in 0025): recursive `rm`, and any `push`, `reset` or `clean` after a `git` word, whatever the flags or global options (#618/AC-9). */
function hasRiskyVerb(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean).map(bare);
  const rm = tokens.findIndex((t) => baseName(t) === 'rm');
  if (rm >= 0 && tokens.slice(rm + 1).some((t) => RECURSIVE_FLAG.test(t))) return true;
  const git = tokens.findIndex((t) => baseName(t) === 'git');
  return git >= 0 && tokens.slice(git + 1).some((t) => RISKY_GIT_SUBCOMMANDS.has(t));
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

function commandIsTerminalOnly(rawCommand: string): boolean {
  const command = stripQuotes(rawCommand);
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
  const unquoted = cited.map(stripQuotes);
  return [...cited, ...unquoted].some((text) => PROTECTED_PATH_PATTERNS.some((re) => re.test(text)));
}
