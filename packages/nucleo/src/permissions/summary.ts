// What the person approves, as a short text with the secrets masked (decision 0025, "Modelo de ameaça", #618/AC-7).
// The summary is redacted here, before anything is kept: the raw tool input is never stored or logged.
// Pure: no disk, no socket, no clock. The masking is its own, so no module that imports a mechanism comes in.

/** What replaces a secret. */
export const MASK = '••••';
/** The most characters a summary keeps; the cut ends in `…`. */
export const MAX_SUMMARY_CHARS = 2000;
/** The most characters of a diff or of content a summary shows per side. */
const MAX_BODY_CHARS = 400;

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|pwd|passphrase|credentials?|api[_-]?key|private[_-]?key|access[_-]?key|key|signature)[A-Za-z0-9_.-]*';
const VALUE = `"[^"]*"|'[^']*'|[^\\s&"',;]+`;

const MASKS: [RegExp, string | ((...m: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Authorization: Bearer x, Authorization: Basic x, Authorization: x
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, (_m, head, scheme) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{3,}/gi, `$1 ${MASK}`],
  [/\b((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n"]+/gi, `$1${MASK}`],
  // scheme://user:pass@host and scheme://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, `$1${MASK}@`],
  // well-known token shapes, bare
  [/\b(?:gh[pousr]_|github_pat_|npm_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK],
  // mysql -pSECRET
  [/(\s-p)(?=\S)\S+/g, `$1${MASK}`],
  // --token VALUE, -password VALUE: the value is the next word, unless that is another flag
  [new RegExp(`(^|\\s)(--?${SECRET_NAME})(\\s+)(?!-)[^\\s]+`, 'gi'), `$1$2$3${MASK}`],
  // NAME=value, NAME: value, "name": "value", ?name=value
  [new RegExp(`(\\b${SECRET_NAME}["']?\\s*[:=]\\s*)(?:${VALUE})`, 'gi'), `$1${MASK}`],
];

/** Masks what looks like a secret in `text`, whatever the tool. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of MASKS) out = out.replace(re, to as string);
  // A rule reading the output of another (`Authorization: Bearer ••••`) can leave two masks in a row.
  return out.replace(new RegExp(`${MASK}(?:\\s${MASK})+`, 'g'), MASK);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};
const lines = (prefix: string, text: string): string =>
  cut(redactSecrets(text), MAX_BODY_CHARS)
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

/** The text the person reads to decide: masked first, then cut, so a cut never leaves half a secret. */
export function summarize(toolName: string, toolInput: unknown): string {
  return cut(redactSecrets(describeCall(toolName, toolInput)), MAX_SUMMARY_CHARS);
}
