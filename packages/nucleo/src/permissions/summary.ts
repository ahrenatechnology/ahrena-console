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
const SECRET_NAME = '[A-Za-z0-9_.-]{0,64}(?:token|secret|passw(?:or)?d|passwd|pwd|passphrase|credentials?|api[_-]?key|private[_-]?key|access[_-]?key|key|signature)[A-Za-z0-9_.-]{0,64}';
const VALUE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s&"',;]+`;

type Replacement = string | ((substring: string, ...groups: string[]) => string);

const MASKS: [RegExp, Replacement][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Authorization: Bearer x, Authorization: Basic x, Authorization: x, "Authorization":"x" (#618/AC-7)
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{3,}/gi, `$1 ${MASK}`],
  [/\b((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n"]+/gi, `$1${MASK}`],
  // scheme://user:pass@host and scheme://token@host (#618/AC-7)
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@'"]+@/gi, `$1${MASK}@`],
  // well-known token shapes, bare (#618/AC-7)
  [/\b(?:gh[pousr]_|github_pat_|npm_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK],
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
const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};
const redact = (text: string): string => redactSecrets(text.length > MAX_RAW_CHARS ? text.slice(0, MAX_RAW_CHARS) : text);
const lines = (prefix: string, text: string): string =>
  cut(redact(text), MAX_BODY_CHARS)
    .split('\n')
    .map((l) => `${prefix} ${l}`)
    .join('\n');

function describeCall(toolName: string, input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return toolName;
  const f = input as Record<string, unknown>;
  const generic = () => `${toolName} ${JSON.stringify(f)}`;
  switch (toolName) {
    case 'Bash':
      return str(f['command']) ?? generic();
    case 'Edit': {
      const path = str(f['file_path']);
      return path === null ? generic() : `${path}\n${lines('-', str(f['old_string']) ?? '')}\n${lines('+', str(f['new_string']) ?? '')}`;
    }
    case 'Write': {
      const path = str(f['file_path']);
      return path === null ? generic() : `${path}\n${lines('+', str(f['content']) ?? '')}`;
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

/** The text the person reads to decide: read up to a ceiling, masked, then cut, so a cut never leaves half a secret (#618/AC-7). */
export function summarize(toolName: string, toolInput: unknown): string {
  return cut(redact(describeCall(toolName, toolInput)), MAX_SUMMARY_CHARS);
}
