// Minimal YAML frontmatter, dependency-free: only top-level `key: value`, with single or double
// quotes, and multi-line values (folded `>`, literal `|`, or the indented continuation of a plain
// value). Enough for the `name` and `description` of skills and subagents; the rest of the YAML
// (lists, objects) is ignored without error.

const OPENING = /^﻿?---[ \t]*\r?\n/;
const KEY = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** The frontmatter text fields; `{}` without frontmatter. */
export function readFrontmatter(text: string): Record<string, string> {
  const opening = OPENING.exec(text);
  if (!opening) return {};
  const rest = text.slice(opening[0].length);
  const end = /^---[ \t]*$/m.exec(rest);
  if (!end) return {};
  const lines = rest.slice(0, end.index).split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = KEY.exec(lines[i]);
    if (!m) continue;
    const value = m[2].trim();
    const continuation: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^[ \t]/.test(lines[i + 1]))) continuation.push(lines[++i].trim());
    while (continuation.length && continuation[continuation.length - 1] === '') continuation.pop();
    if (/^[>|][+-]?$/.test(value)) {
      fields[m[1]] = value.startsWith('|') ? continuation.join('\n') : continuation.join(' ').replace(/ {2,}/g, ' ').trim();
    } else if (value !== '') {
      fields[m[1]] = unquote([value, ...continuation.filter(Boolean)].join(' '));
    } else if (continuation.length && !continuation[0].startsWith('-')) {
      fields[m[1]] = continuation.filter(Boolean).join(' ');
    }
  }
  return fields;
}
