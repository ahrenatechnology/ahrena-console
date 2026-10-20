// Discovery of the transcripts in `~/.claude/projects` and incremental reading by byte offset.
//
// Known layouts, inside each project folder:
// - `<sessionId>.jsonl`: the main agent;
// - `<sessionId>/subagents/agent-<agentId>.jsonl` (+ `.meta.json`): subagents, current layout;
// - `agent-<agentId>.jsonl`: subagents in the old layout, with the parent session's `sessionId` inside the lines.
//
// `<sessionId>.superseded-<n>.jsonl` is an old version of the main file, rewritten by Claude Code;
// everything in it is in the current file, so it is ignored (like any name with a dot).

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

export interface TranscriptFile {
  /** Caminho absoluto. */
  path: string;
  /** Caminho relativo à raiz, que é o que fica gravado no cursor. */
  relPath: string;
  kind: 'main' | 'subagent';
  /** Conhecido pelo nome do arquivo (principal e layout atual); no layout antigo, lido das linhas. */
  sessionId: string | null;
  /** Só para subagentes. */
  agentId: string | null;
  /** `agent-<id>.meta.json`, quando existe. */
  metaPath: string | null;
}

export interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
}

export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

const SESSION_FILE = /^([^.]+)\.jsonl$/;
const AGENT_FILE = /^agent-(.+)\.jsonl$/;

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Lista os transcripts sob a raiz, em ordem estável (principal antes dos subagentes). */
export async function discoverTranscripts(root: string): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  const file = (path: string, kind: TranscriptFile['kind'], sessionId: string | null, agentId: string | null, metaPath: string | null) =>
    found.push({ path, relPath: relative(root, path), kind, sessionId, agentId, metaPath });

  const projects = (await entries(root)).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const project of projects) {
    const dir = join(root, project);
    const items = await entries(dir);
    const names = new Set(items.map((e) => e.name));
    for (const e of items.filter((i) => i.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      const agent = AGENT_FILE.exec(e.name);
      if (agent) {
        file(join(dir, e.name), 'subagent', null, agent[1], null);
        continue;
      }
      const session = SESSION_FILE.exec(e.name);
      if (!session) continue;
      const sessionId = session[1];
      file(join(dir, e.name), 'main', sessionId, null, null);
      if (!names.has(sessionId)) continue;
      const subDir = join(dir, sessionId, 'subagents');
      const subNames = new Set((await entries(subDir)).map((s) => s.name));
      for (const name of [...subNames].sort()) {
        const m = AGENT_FILE.exec(name);
        if (!m) continue;
        const meta = `agent-${m[1]}.meta.json`;
        file(join(subDir, name), 'subagent', sessionId, m[1], subNames.has(meta) ? join(subDir, meta) : null);
      }
    }
  }
  return found;
}

export async function readSubagentMeta(path: string | null): Promise<SubagentMeta | null> {
  if (!path) return null;
  try {
    const o = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
    return {
      agentType: s(o.agentType),
      description: s(o.description),
      toolUseId: s(o.toolUseId),
      spawnDepth: Number.isInteger(o.spawnDepth) ? (o.spawnDepth as number) : null,
    };
  } catch {
    return null;
  }
}

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export async function fileStat(path: string): Promise<FileStat | null> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
  } catch {
    return null;
  }
}

const TAIL = 64;

/**
 * Impressão digital dos bytes logo antes de `offset` (até 64), em base64. Fica no cursor: se o
 * arquivo for reescrito com tamanho igual ou maior, os bytes antes do cursor mudam e a leitura
 * recomeça do início. `null` se o arquivo sumiu ou é menor que `offset`.
 */
export async function readTail(path: string, offset: number): Promise<string | null> {
  const length = Math.min(TAIL, offset);
  try {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset - length);
      return bytesRead === length ? buf.toString('base64') : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Classifica um caminho sob a raiz como transcript, pelos mesmos layouts de `discoverTranscripts`.
 * `null` para o que não é transcript (diretório, `.meta.json`, `superseded`, outro arquivo).
 * Não toca o disco, exceto para saber se o `.meta.json` do subagente existe.
 */
export function classifyTranscript(root: string, relPath: string, exists: (path: string) => boolean): TranscriptFile | null {
  const parts = relPath.split(sep).filter((p) => p.length > 0);
  const path = join(root, ...parts);
  const rel = parts.join(sep);
  if (parts.length === 2) {
    const agent = AGENT_FILE.exec(parts[1]);
    if (agent) return { path, relPath: rel, kind: 'subagent', sessionId: null, agentId: agent[1], metaPath: null };
    const session = SESSION_FILE.exec(parts[1]);
    if (session) return { path, relPath: rel, kind: 'main', sessionId: session[1], agentId: null, metaPath: null };
    return null;
  }
  if (parts.length === 4 && parts[2] === 'subagents') {
    const m = AGENT_FILE.exec(parts[3]);
    if (!m) return null;
    const meta = join(root, parts[0], parts[1], 'subagents', `agent-${m[1]}.meta.json`);
    return { path, relPath: rel, kind: 'subagent', sessionId: parts[1], agentId: m[1], metaPath: exists(meta) ? meta : null };
  }
  return null;
}

const CHUNK = 1 << 20;
const NEWLINE = 0x0a;

/**
 * Lê as linhas completas a partir de `offset`, uma a uma, com o deslocamento logo depois de cada
 * linha. Uma linha sem `\n` no fim (o Claude Code ainda está escrevendo) fica para a próxima leitura.
 */
export async function* readLinesFrom(path: string, offset: number): AsyncGenerator<{ line: string; end: number }> {
  const handle = await open(path, 'r');
  try {
    let position = offset;
    let pending = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const buf = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const bufStart = position - pending.length;
      position += bytesRead;
      let start = 0;
      for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
        const line = buf.toString('utf8', start, i).trim();
        start = i + 1;
        if (line.length > 0) yield { line, end: bufStart + start };
      }
      pending = Buffer.from(buf.subarray(start));
    }
  } finally {
    await handle.close();
  }
}
