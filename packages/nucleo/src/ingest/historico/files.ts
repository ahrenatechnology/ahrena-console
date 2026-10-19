// Descoberta dos transcripts em `~/.claude/projects` e leitura incremental por deslocamento em bytes.
//
// Layouts conhecidos, dentro de cada pasta de projeto:
// - `<sessionId>.jsonl`: o agente principal;
// - `<sessionId>/subagents/agent-<agentId>.jsonl` (+ `.meta.json`): subagentes, layout atual;
// - `agent-<agentId>.jsonl`: subagentes no layout antigo, com o `sessionId` da sessão-mãe dentro das linhas.
//
// `<sessionId>.superseded-<n>.jsonl` é uma versão antiga do arquivo principal, reescrito pelo
// Claude Code; tudo o que ela tem está no arquivo atual, então é ignorada (como qualquer nome com ponto).

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

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
