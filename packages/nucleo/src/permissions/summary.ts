// What the person approves, as a short text with the secrets masked (decision 0025, "Modelo de ameaça", #618/AC-7).
// Redacted here, before anything is kept: the raw tool input is never stored or logged (#617); pure, no import (#618).

/** What replaces a secret (#618/AC-7). */
export const MASK = '••••';
/** The most characters a summary keeps; the cut ends in `…` (#618/AC-7). */
export const MAX_SUMMARY_CHARS = 2000;
/** The most characters of a diff or of content a summary shows per side (#618/AC-7). */
const MAX_BODY_CHARS = 400;
/** The raw text a redaction reads: far above the summary, so the final cut never reaches a half-read secret (#618/AC-7). */
const MAX_RAW_CHARS = MAX_SUMMARY_CHARS * 8;

// The name quantifiers are bounded, so no input makes a match cost more than a constant per start (#618/AC-7, INP-9).
const SECRET_NAME = '[A-Za-z0-9_.-]{0,64}(?:token|secret|passw(?:or)?d|passwd|pwd|passphrase|pass(?![a-z])|credentials?|api[_-]?key|private[_-]?key|access[_-]?key|key|signature)[A-Za-z0-9_.-]{0,64}';
// A value that holds shell code (`$(…)`, a backtick, `;`, `|`, `&`, a newline) is never matched, so a mask never hides what runs (decision 0025 amendment, #618/AC-9).
const VALUE = `"(?:[^"\\\\$\`;|&\\n]|\\\\.)*"|'(?:[^'\\\\$\`;|&\\n]|\\\\.)*'|[^\\s&"',;$\`|]+`;

type Replacement = string | ((substring: string, ...groups: string[]) => string);

const MASKS: [RegExp, Replacement][] = [
  // A PEM ends at its END line or, with none, at the end of its base64 run: never at the end of the text, so the code after it stays visible (#618/AC-9).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s]*)/g, MASK],
  // Authorization: Bearer x, Authorization: Basic x, Authorization: x, "Authorization":"x" (#618/AC-7)
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{3,}/gi, `$1 ${MASK}`],
  // A cookie value ends at a separator or a quote, so the command after `;` or `&&` stays visible (#618/AC-9).
  [/\b((?:set-)?cookie["']?\s*[:=]\s*)[^;&|\r\n"']+/gi, `$1${MASK}`],
  // scheme://user:pass@host and scheme://token@host (#618/AC-7)
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@'"]+@/gi, `$1${MASK}@`],
  // well-known token shapes, bare (#618/AC-7)
  [/\b(?:gh[pousr]_|github_pat_|npm_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK],
  // curl -u "user:pass word", --user 'user:pass word': a quoted credential may hold spaces; the closing quote is optional so a cut one is masked too (#618/AC-9)
  [/(\s(?:-u|--user)(?:\s+|=)?)(?:"((?:[^"\\]|\\.){0,64}:(?:[^"\\]|\\.){1,256})"?|'([^']{0,64}:[^']{1,256})'?)/g, (_m, head, double) => `${head}${double === undefined ? "'" : '"'}${MASK}${double === undefined ? "'" : '"'}`],
  // curl -u user:password, --user user:password, --user=user:password: the password is masked (#618/AC-7)
  [/(\s(?:-u|--user)(?:\s+|=)?)(["']?)[^\s:"']{0,64}:[^\s"']{1,256}\2(?=\s|$)/g, (_m, head, quote) => `${head}${quote}${MASK}${quote}`],
  // aws configure set aws_secret_access_key VALUE: a name that holds a secret, then the value after a space (#618/AC-7)
  [/(\bset\s+[A-Za-z0-9_.-]{0,64}(?:secret|key|token|password|pass)[A-Za-z0-9_.-]{0,64}\s+)\S+/gi, `$1${MASK}`],
  // mysql -pSECRET (#618/AC-7)
  [/(\s-p)(?=\S)\S+/g, `$1${MASK}`],
  // --token VALUE, -password VALUE: the value is the next word, unless that is another flag (#618/AC-7)
  [new RegExp(`(^|\\s)(--?${SECRET_NAME})(\\s+)(?!-)[^\\s]+`, 'gi'), `$1$2$3${MASK}`],
  // NAME=value, NAME: value, "name": "value", ?name=value (#618/AC-7)
  [new RegExp(`(\\b${SECRET_NAME}["']?\\s*[:=]\\s*)(?:${VALUE})`, 'gi'), `$1${MASK}`],
];

/** Masks what looks like a secret in `text`, whatever the tool. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of MASKS) out = typeof to === 'string' ? out.replace(re, to) : out.replace(re, to);
  // One rule reading the output of another (`Authorization: Bearer ••••`) can leave two masks in a row (#618/AC-7).
  return out.replace(new RegExp(`${MASK}(?:\\s${MASK})+`, 'g'), MASK);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** Whether any step cut what the person reads: the raw ceiling, a side of a diff, or the summary itself (#618/AC-7). */
interface Cuts {
  truncated: boolean;
}
const cut = (text: string, max: number, cuts: Cuts): string => {
  const chars = [...text];
  if (chars.length <= max) return text;
  cuts.truncated = true;
  return `${chars.slice(0, max - 1).join('')}…`;
};

const FORMAT_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g;
/** Bidi and invisible format characters can make a command read as another one; they show as `\u202e` instead (#618/AC-9). */
const escapeFormatChars = (text: string): string => text.replace(FORMAT_CHARS, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
/** Runs of blanks read as one space and runs of line breaks as one, so padding cannot push the command past the cut (linear, #618/AC-9). */
const collapseWhitespace = (text: string): string => text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n(?:\n| )*/g, '\n');

const redact = (text: string, cuts: Cuts): string => {
  const readable = collapseWhitespace(escapeFormatChars(text));
  if (readable.length <= MAX_RAW_CHARS) return redactSecrets(readable);
  cuts.truncated = true;
  return redactSecrets(readable.slice(0, MAX_RAW_CHARS));
};
const lines = (prefix: string, text: string, cuts: Cuts): string =>
  cut(redact(text, cuts), MAX_BODY_CHARS, cuts)
    .split('\n')
    .map((l) => `${prefix} ${l}`)
    .join('\n');

function describeCall(toolName: string, input: unknown, cuts: Cuts): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return toolName;
  const f = input as Record<string, unknown>;
  const generic = () => `${toolName} ${JSON.stringify(f)}`;
  switch (toolName) {
    case 'Bash':
      return str(f['command']) ?? generic();
    case 'Edit': {
      const path = str(f['file_path']);
      return path === null ? generic() : `${path}\n${lines('-', str(f['old_string']) ?? '', cuts)}\n${lines('+', str(f['new_string']) ?? '', cuts)}`;
    }
    case 'Write': {
      const path = str(f['file_path']);
      return path === null ? generic() : `${path}\n${lines('+', str(f['content']) ?? '', cuts)}`;
    }
    case 'NotebookEdit':
      return str(f['notebook_path']) ?? generic();
    case 'Read':
      return str(f['file_path']) ?? generic();
    case 'Grep': {
      const pattern = str(f['pattern']);
      const path = str(f['path']);
      return pattern === null ? generic() : path === null ? pattern : `${pattern} in ${path}`;
    }
    case 'Glob':
      return str(f['pattern']) ?? generic();
    case 'WebFetch':
      return str(f['url']) ?? generic();
    default:
      return generic();
  }
}

/** The text the person reads to decide: read up to a ceiling, masked, then cut, so a cut never leaves half a secret; `truncated` tells the screen to mark a cut one (#618/AC-7). */
export function summarizeCall(toolName: string, toolInput: unknown): { summary: string; truncated: boolean } {
  const cuts: Cuts = { truncated: false };
  const summary = cut(redact(describeCall(toolName, toolInput, cuts), cuts), MAX_SUMMARY_CHARS, cuts);
  return { summary, truncated: cuts.truncated };
}

/** The summary alone, for a caller that does not mark a cut one. */
export function summarize(toolName: string, toolInput: unknown): string {
  return summarizeCall(toolName, toolInput).summary;
}
