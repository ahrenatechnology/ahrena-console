/*
 * The one edit the core makes to ai-memory's config.toml (#740): `embedding_provider = "none"` as a top-level key. A pure text
 * transform; the file read and the atomic write are tools/memory-config-file.ts's (#740).
 */

const KEY = 'embedding_provider';
const OFF = `${KEY} = "none"`;
// Config.embedding_provider is a top-level field (upstream config.rs:612, "none" at config.rs:3501) (#740).
const KEY_LINE = new RegExp(`^(\\s*)${KEY}(\\s*=\\s*)("[^"]*"|'[^']*'|[^#\\s]*)(.*)$`);
const TABLE_HEADER = /^\s*\[\[?[A-Za-z0-9_."' -]+\]\]?\s*(?:#.*)?$/;

/** The lines that start inside a multi-line string, which no key or table header may be read from (#740). */
function insideStrings(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let open = false;
  for (const line of lines) {
    inside.push(open);
    const delimiters = (line.match(/"""|'''/g) ?? []).length;
    if (delimiters % 2 === 1) open = !open;
  }
  return inside;
}

/** The text with `embedding_provider = "none"` set; every other key and comment untouched (#740/AC-2). */
export function withEmbeddingsOff(text: string): string {
  const lines = text.split('\n');
  const inside = insideStrings(lines);
  const table = lines.findIndex((line, i) => !inside[i] && TABLE_HEADER.test(line));
  const topLevel = table < 0 ? lines.length : table;
  for (let i = 0; i < topLevel; i += 1) {
    const match = inside[i] ? null : KEY_LINE.exec(lines[i]!);
    if (match) {
      lines[i] = `${match[1]}${KEY}${match[2]}"none"${match[4]}`;
      return lines.join('\n');
    }
  }
  if (table < 0) return `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${OFF}\n`;
  // The key goes before the first table, and before the comment lines that sit right above it (they describe the table) (#740).
  let at = table;
  while (at > 0 && lines[at - 1]!.trim().startsWith('#')) at -= 1;
  lines.splice(at, 0, OFF, '');
  return lines.join('\n');
}
