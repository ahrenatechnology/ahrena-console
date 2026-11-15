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
// One value class for every mask: it never crosses whitespace, a quote, `;`, `|`, `&`, `$`, a backtick, a parenthesis, `<` or `>`, so a mask never hides code that runs (decision 0025 amendment, #618/AC-9, AC-10).
const V = '[^\\s"\'`;|&$()<>]+';
// The quoted forms of a NAME=value hold no shell code, no newline and no quote of the other kind, and need their closing quote (#618/AC-9).
const VALUE = `"(?:[^"'\\\\$\`;|&\\n]|\\\\.)*"|'(?:[^'"\\\\$\`;|&\\n]|\\\\.)*'|${V}`;

type Replacement = string | ((substring: string, ...groups: string[]) => string);

// A PEM is masked as a complete block: its BEGIN line, base64 lines, its END line. With no END it is masked only when the raw text was cut at the ceiling (#618/AC-9).
const PEM_BEGIN = '-----BEGIN [A-Z ]*PRIVATE KEY-----';
const PEM_BLOCK = new RegExp(`${PEM_BEGIN}(?:\\s+[A-Za-z0-9+/]{1,64}={0,2})*\\s+-----END [A-Z ]*PRIVATE KEY-----`, 'g');
const PEM_CUT = new RegExp(`${PEM_BEGIN}[A-Za-z0-9+/=\\s]*`, 'g');

const MASKS: [RegExp, Replacement][] = [
  // Authorization: Bearer x, Authorization: Basic x, Authorization: x, "Authorization":"x" (#618/AC-7)
  [new RegExp(`\\b((?:proxy-)?authorization["']?\\s*[:=]\\s*["']?)(?:(bearer|basic|token|digest)\\s+)?${V}`, 'gi'), (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{3,}/gi, `$1 ${MASK}`],
  // A cookie value is one word of the shared class, so the command after `;` or `&&` stays visible (#618/AC-9).
  [new RegExp(`\\b((?:set-)?cookie["']?\\s*[:=]\\s*)${V}`, 'gi'), `$1${MASK}`],
  // scheme://user:pass@host and scheme://token@host (#618/AC-7)
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@'"]+@/gi, `$1${MASK}@`],
  // well-known token shapes, bare (#618/AC-7)
  [/\b(?:gh[pousr]_|github_pat_|npm_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK],
  // curl -u "user:pass word", --user 'user:pass word': a quoted credential may hold spaces but no shell code, and needs its closing quote (#618/AC-9)
  [/(\s(?:-u|--user)(?:\s+|=)?)(?:"((?:[^"\\$`\n]|\\.){0,64}:(?:[^"\\$`\n]|\\.){1,256})"|'([^'\n]{0,64}:[^'\n]{1,256})')/g, (_m, head, double) => `${head}${double === undefined ? "'" : '"'}${MASK}${double === undefined ? "'" : '"'}`],
  // curl -u user:password, --user user:password, --user=user:password: the password is masked (#618/AC-7)
  [new RegExp(`(\\s(?:-u|--user)(?:\\s+|=)?)(["']?)[^\\s:"']{0,64}:${V}\\2(?=\\s|$)`, 'g'), (_m, head, quote) => `${head}${quote}${MASK}${quote}`],
  // aws configure set aws_secret_access_key VALUE: a name that holds a secret, then the value after a space (#618/AC-7)
  [new RegExp(`(\\bset\\s+[A-Za-z0-9_.-]{0,64}(?:secret|key|token|password|pass)[A-Za-z0-9_.-]{0,64}\\s+)${V}`, 'gi'), `$1${MASK}`],
  // mysql -pSECRET (#618/AC-7)
  [new RegExp(`(\\s-p)(?=[^\\s"'\`;|&$()<>])${V}`, 'g'), `$1${MASK}`],
  // --token VALUE, -password VALUE: the value is the next word, unless that is another flag (#618/AC-7)
  [new RegExp(`(^|\\s)(--?${SECRET_NAME})(\\s+)(?!-)${V}`, 'gi'), `$1$2$3${MASK}`],
  // NAME=value, NAME: value, "name": "value", ?name=value (#618/AC-7)
  [new RegExp(`(\\b${SECRET_NAME}["']?\\s*[:=]\\s*)(?:${VALUE})`, 'gi'), `$1${MASK}`],
];

// What a mask declined and left standing, though it is still a credential in a place that hides code: a `-u` credential or a `NAME="…'…"` value that holds shell code or the other quote. Read as a mask that acted (#618/AC-10).
const DECLINED: RegExp[] = [
  /\s(?:-u|--user)(?:\s+|=)?["'][^\s"']{0,64}:/,
  new RegExp(`\\b${SECRET_NAME}["']?\\s*[:=]\\s*(?:"[^"\\n]*'|'[^'\\n]*")`, 'i'),
  new RegExp(PEM_BEGIN),
];

/** Masks what looks like a secret in `text`, whatever the tool, and says whether any mask acted (#618/AC-10). `atCut`: the text was cut at the raw ceiling. */
export function redactWithReport(text: string, atCut = false): { text: string; masked: boolean } {
  let masked = false;
  const apply = (re: RegExp, to: Replacement, input: string): string => {
    const next = typeof to === 'string' ? input.replace(re, to) : input.replace(re, to);
    if (next !== input) masked = true;
    return next;
  };
  let out = apply(atCut ? PEM_CUT : PEM_BLOCK, MASK, text);
  for (const [re, to] of MASKS) out = apply(re, to, out);
  if (DECLINED.some((re) => re.test(out))) masked = true;
  // One rule reading the output of another (`Authorization: Bearer ••••`) can leave two masks in a row (#618/AC-7).
  return { text: out.replace(new RegExp(`${MASK}(?:\\s${MASK})+`, 'g'), MASK), masked };
}

/** Masks what looks like a secret in `text`, whatever the tool. */
export function redactSecrets(text: string): string {
  return redactWithReport(text).text;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** Whether any step cut what the person reads: the raw ceiling, a side of a diff, or the summary itself (#618/AC-7). */
interface Cuts {
  truncated: boolean;
  /** Some mask replaced text, or left a credential standing in a place that hides code (#618/AC-10). */
  masked: boolean;
}
const cut = (text: string, max: number, cuts: Cuts): string => {
  const chars = [...text];
  if (chars.length <= max) return text;
  cuts.truncated = true;
  return `${chars.slice(0, max - 1).join('')}…`;
};

const FORMAT_CHARS = /[\p{Cf}\u2028\u2029]/gu;
/** Bidi, invisible and tag characters (any format character, and the line and paragraph separators) can make a command read as another one; they show as `\u202e`, or `\u{e0041}` above U+FFFF (#618/AC-9). */
const escapeFormatChars = (text: string): string =>
  text.replace(FORMAT_CHARS, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
/** Runs of blanks read as one space and runs of line breaks as one, so padding cannot push the command past the cut (linear, #618/AC-9). */
const collapseWhitespace = (text: string): string => text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n(?:\n| )*/g, '\n');

const redact = (text: string, cuts: Cuts): string => {
  const readable = collapseWhitespace(escapeFormatChars(text));
  const atCut = readable.length > MAX_RAW_CHARS;
  if (atCut) cuts.truncated = true;
  const r = redactWithReport(atCut ? readable.slice(0, MAX_RAW_CHARS) : readable, atCut);
  if (r.masked) cuts.masked = true;
  return r.text;
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
export function summarizeCall(toolName: string, toolInput: unknown): { summary: string; truncated: boolean; masked: boolean } {
  const cuts: Cuts = { truncated: false, masked: false };
  const summary = cut(redact(describeCall(toolName, toolInput, cuts), cuts), MAX_SUMMARY_CHARS, cuts);
  return { summary, truncated: cuts.truncated, masked: cuts.masked };
}

/** The summary alone, for a caller that does not mark a cut one. */
export function summarize(toolName: string, toolInput: unknown): string {
  return summarizeCall(toolName, toolInput).summary;
}
