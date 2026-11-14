// The calls the Console never allows, only the person at the terminal (decision 0025, "Por tipo de chamada", #618/AC-6).
// The Console can still deny them, which is the safe side; pure: no disk, no socket, no clock (#618).
// The check is by text, a floor and not the defence (`$HOME/.ahr*` slips past it): the defence is the window credential (#619).
// The data folders of the other instances in the instance registry are added to the citing check by a later layer (#618).

const COMMAND_PATTERNS: RegExp[] = [/\bgit\s+reset\s+--hard\b/, /\bsudo\b/, /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/];

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

/** A tokenised scan, one pass per command segment, so the cost is linear in the command (#618/AC-6, 64 KiB bound in 0025). */
function hasRiskyVerb(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean).map(bare);
  const rm = tokens.findIndex((t) => t === 'rm' || t.endsWith('/rm'));
  if (rm >= 0 && tokens.slice(rm + 1).some((t) => RECURSIVE_FLAG.test(t))) return true;
  const git = tokens.findIndex((t, i) => t === 'git' && (tokens[i + 1] === 'push' || tokens[i + 1] === 'clean'));
  if (git < 0) return false;
  const rest = tokens.slice(git + 2);
  return tokens[git + 1] === 'push' ? rest.some((t) => FORCE_PUSH.test(t)) : rest.some((t) => FORCE_CLEAN.test(t));
}

/** `curl x | sh`: a segment with a download followed by a segment that is a shell (#618/AC-6). */
function pipesDownloadIntoShell(line: string): boolean {
  const parts = line.split('|');
  return parts.some((part, i) => i + 1 < parts.length && /\b(?:curl|wget)\b/.test(part) && /^\s*(?:sudo\s+)?(?:ba|z)?sh\b/.test(parts[i + 1] ?? ''));
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
