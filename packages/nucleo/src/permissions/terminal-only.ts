// The calls the Console never allows, only the person at the terminal (decision 0025, "Por tipo de chamada", #618/AC-6).
// The Console can still deny them, which is the safe side. Pure: no disk, no socket, no clock.
//
// The check is by text, so it is a floor and not the defence (`$HOME/.ahr*` slips past it): the defence is the window
// credential (#619). The data folders of the other instances in the instance registry are not known here; a later
// layer, which reads the registry, adds them to the citing check.

const COMMAND_PATTERNS: RegExp[] = [
  /\brm\b[^|;&\n]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/,
  /\bgit\s+push\b[^|;&\n]*(?:--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+(?:[^|;&\n]*\s)?(?:-[a-zA-Z]*f|--force\b)/,
  /\bsudo\b/,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
  /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/,
];

/** Files whose change changes what runs or what is secret. */
const PROTECTED_PATH_PATTERNS: RegExp[] = [/(?:^|\/)\.claude\/(?:settings[^/]*\.json|hooks\/)/, /(?:^|\/)\.mcp\.json$/, /(?:^|\/)\.env(?:\.|$)/, /(?:^|\/)\.ssh\//];

/** What the agent could read the owner token from, or swap the hook through: cited anywhere in a command or a path. */
const CITED_PATTERNS: RegExp[] = [/\.ahrena-console/i, /dev\.ahrena\.console/i, /\.claude\/plugins\b/i];

const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern'] as const;

/** `/a/./b` and `/a//b` read as `/a/b`, so a path cannot dodge a pattern by spelling. */
const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');

/** An input that cannot be read (not an object, no readable command on a Bash call) is terminal-only: the safe side. */
export function isTerminalOnly(toolName: string, toolInput: unknown): boolean {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return true;
  const fields = toolInput as Record<string, unknown>;
  const command = fields['command'];
  if (toolName === 'Bash' && typeof command !== 'string') return true;

  const paths = PATH_FIELDS.map((f) => fields[f]).filter((v): v is string => typeof v === 'string').map(normalizePath);
  const cited = [...paths, ...(typeof command === 'string' ? [normalizePath(command)] : [])];
  if (cited.some((text) => CITED_PATTERNS.some((re) => re.test(text)))) return true;
  if (typeof command === 'string' && COMMAND_PATTERNS.some((re) => re.test(command))) return true;
  return paths.some((p) => PROTECTED_PATH_PATTERNS.some((re) => re.test(p)));
}
