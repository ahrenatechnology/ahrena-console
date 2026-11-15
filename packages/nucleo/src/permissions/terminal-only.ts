// The calls the Console never allows, only the person at the terminal (decision 0025, "Por tipo de chamada", #618/AC-6).
// The Console can still deny them, which is the safe side; pure: no disk, no socket, no clock (#618).
// The check is by text, a floor and not the defence (`$HOME/.ahr*` slips past it): the defence is the window credential (#619).
// The data folders of the other instances in the instance registry are added to the citing check by a later layer (#618).

import { MAX_CANONICAL_DEPTH } from './digest.ts';

// `sh -c "$(curl …)"` and a shell or `source` fed by process substitution `<(curl …)` (#618/AC-6).
const COMMAND_PATTERNS: RegExp[] = [/\bsudo\b/, /\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/, /\b(?:(?:ba|z|da|k)?sh|fish|source)\s+<\(\s*(?:curl|wget)\b/, /(?:^|[\s;&|])\.\s+<\(\s*(?:curl|wget)\b/];

/** Files whose change changes what runs or what is secret, case-insensitive as the macOS disk is (#618/AC-6). */
const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(?:^|[^A-Za-z0-9_.-])\.claude\/(?:settings[^/\s]*\.json|hooks(?:\/|$|[^A-Za-z0-9_-]))/i,
  /(?:^|[^A-Za-z0-9_.-])\.mcp\.json(?![A-Za-z0-9_-])/i,
  /\.env/i,
  /(?:^|[^A-Za-z0-9_.-])\.ssh(?:\/|$|[^A-Za-z0-9_-])/i,
];

/** What the agent could read the owner token from, or swap the hook through: cited anywhere in a command or a path (#618/AC-6). */
const CITED_PATTERNS: RegExp[] = [/\.ahrena-console/i, /dev\.ahrena\.console/i, /\.claude\/plugins\b/i];

/** `/a/./b` and `/a//b` read as `/a/b`, so a path cannot dodge a pattern by spelling (#618/AC-6). */
const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');

const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const bare = (token: string): string => token.replace(/^["'(]+|["')]+$/g, '');
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/** Words end at whitespace and at every wrapper a shell opens or closes around one: `$(git push)`, `` `git push` ``, `{ git push; }`, `git push>/dev/null` (#618/AC-9). */
const tokensOf = (text: string): string[] => text.split(/[\s()$`{}<>]+/).filter(Boolean).map(bare);

/** Quotes never hide a word: they read as spaces, so `"git" 'push'` is `git push` (#618/AC-9). */
const stripQuotes = (text: string): string => text.replace(/["'`]/g, ' ');
/** Quotes inside a word join it: `g'i't` is `git`, `"pu"sh` is `push`, `.claude/"hooks"` is `.claude/hooks` (#618/AC-9). */
const deleteQuotes = (text: string): string => text.replace(/["'`]/g, '');
/** A backslash before a newline joins the lines; any other backslash escapes one character and is dropped: `\git`, `p\ush` (#618/AC-9). */
const unescapeShell = (text: string): string => text.replace(/\\\r?\n/g, ' ').replace(/\\/g, '');

/** Every spelling a shell could read the text as: raw or unescaped, with quotes kept, read as spaces or deleted. The floor checks them all, and a hit on any is a hit (#618/AC-6, AC-9). */
function spellings(text: string): string[] {
  return [text, unescapeShell(text)].flatMap((t) => [t, stripQuotes(t), deleteQuotes(t)]).map(normalizePath);
}

const RISKY_GIT_SUBCOMMANDS = new Set(['push', 'reset', 'clean']);

/** A tokenised scan, one pass per command segment (linear in the command, 64 KiB bound in 0025): recursive `rm`, and any `push`, `reset` or `clean` after a `git` word, whatever the flags or global options (#618/AC-9). */
function hasRiskyVerb(segment: string): boolean {
  const tokens = tokensOf(segment);
  const rm = tokens.findIndex((t) => baseName(t) === 'rm');
  if (rm >= 0 && tokens.slice(rm + 1).some((t) => RECURSIVE_FLAG.test(t))) return true;
  const git = tokens.findIndex((t) => baseName(t) === 'git');
  return git >= 0 && tokens.slice(git + 1).some((t) => RISKY_GIT_SUBCOMMANDS.has(t));
}

const RUNNERS = new Set([...SHELLS, 'eval', 'source', 'python', 'python2', 'python3', 'node', 'perl', 'ruby', 'php', 'osascript']);

/** A download and a shell (or `eval`, or `source`) anywhere in the same command: `curl u | env -i sh`, `eval "$(curl u)"`, `curl -o f u && sh f`. It over-matches by design (#618/AC-6, decision 0025 amendment). */
function downloadsAndRuns(command: string): boolean {
  return /\b(?:curl|wget)\b/.test(command) && tokensOf(command).some((t) => RUNNERS.has(baseName(t)));
}

/** `xargs git` with a risky verb anywhere in the command, or a segment that starts with a `$`-variable and then names one: `echo push | xargs git`, `x=git; $x push` (#618/AC-9). */
function reachesGitIndirectly(form: string): boolean {
  const tokens = tokensOf(form);
  const xargs = tokens.findIndex((t) => baseName(t) === 'xargs');
  if (xargs >= 0 && tokens.slice(xargs + 1).some((t) => baseName(t) === 'git') && tokens.some((t) => RISKY_GIT_SUBCOMMANDS.has(t))) return true;
  return form.split(/[|;&\n]+/).some((segment) => /^[\s({]*\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s/.test(segment) && tokensOf(segment).some((t) => RISKY_GIT_SUBCOMMANDS.has(t)));
}

function commandIsTerminalOnly(rawCommand: string): boolean {
  const forms = spellings(rawCommand);
  if (forms.some((form) => COMMAND_PATTERNS.some((re) => re.test(form)))) return true;
  if (forms.some(downloadsAndRuns) || forms.some(reachesGitIndirectly)) return true;
  return forms.some((form) => form.split(/[|;&\n]+/).some(hasRiskyVerb));
}

/** Every string anywhere in the input, to the same depth the digest accepts; `false` when it nests deeper (#618/AC-6, INP-9). The input is level 2 of the digest envelope. */
function collectStrings(value: unknown, depth: number, out: string[]): boolean {
  if (typeof value === 'string') out.push(value);
  else if (value !== null && typeof value === 'object') {
    if (depth > MAX_CANONICAL_DEPTH) return false;
    for (const v of Object.values(value)) if (!collectStrings(v, depth + 1, out)) return false;
  }
  return true;
}

/** An input that cannot be read (not an object, no readable command on a Bash call, nested too deep) is terminal-only: the safe side (#618/AC-6). */
export function isTerminalOnly(toolName: string, toolInput: unknown): boolean {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return true;
  const command = (toolInput as Record<string, unknown>)['command'];
  if (toolName === 'Bash' && typeof command !== 'string') return true;

  const strings: string[] = [];
  if (!collectStrings(toolInput, 2, strings)) return true;
  const cites = (form: string) => CITED_PATTERNS.some((re) => re.test(form)) || PROTECTED_PATH_PATTERNS.some((re) => re.test(form));
  if (strings.some((text) => spellings(text).some(cites))) return true;
  return typeof command === 'string' && commandIsTerminalOnly(command);
}
