// The routes of the Agent Config screen (#63, wireframes C16 and C17). Reading and writing live in
// src/agent-config/; only HTTP and the write's origin exception stay here.
//
// | Route                                        | What                                                      |
// | -------------------------------------------- | --------------------------------------------------------- |
// | `GET /api/agent-config?project=<abs>`        | Roots, summary and the lists (src/agent-config/model.ts), and `backups`: the backups folder |
// | `GET /api/agent-config/skill?root=&name=`    | A skill's `SKILL.md`, with its `version` (sha256)          |
// | `POST /api/agent-config/skill`               | `{ root, name, content, version?, project?, create? }`: creates or replaces, with backup; `create: true` only creates (409 if it exists) |
//
// `?project=` (and `project` in the POST body) is only valid if it is one of the known `projects`
// (the sessions' `cwd`, src/agent-config/projects.ts); any other value gives 400. Without it, the most recent.
//
// Origin (decision 0003): like the other writes, a POST without `Origin` is accepted from 127.0.0.1.
// The `/ui` screen sends `Origin`, so this POST, and only it, also accepts an `Origin` exactly equal
// to `http://<Host>`, with our Host (`agentConfigWriteFromSameOrigin`, called in `handle`). It
// requires `Content-Type: application/json` (415) and has its own body limit, larger than the
// decisions': past it, 413 right away, without reading the rest, and the connection closes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { ConfigFolder } from '../profiles/discovery.ts';
import { chooseProject, readAgentConfig, rootsFor } from '../agent-config/reading.ts';
import { AgentConfigError } from '../agent-config/model.ts';
import { writeSkill, readSkill, MAX_CONTENT, defaultBackupsDir, skillRoot } from '../agent-config/skills.ts';

export const AGENT_CONFIG_ROUTE = '/api/agent-config';
export const SKILL_ROUTE = '/api/agent-config/skill';
/** The POST body: the content in JSON, with room for the escapes. */
export const MAX_SKILL_BODY = 4 * MAX_CONTENT + 4096;

export interface AgentConfigOptions {
  /** The user configuration folders (profiles), re-read on every request. */
  folders: () => Promise<readonly Pick<ConfigFolder, 'dir' | 'claudeJson'>[]>;
  /** The known project directories, most recent first. */
  projects: () => Promise<readonly string[]>;
  /** Backups folder; default `~/.ahrena-console/backups`. */
  backups?: string;
  log?: (message: string) => void;
  now?: () => Date;
}

export type AgentConfigRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** The skill POST coming from `/ui` itself: `Origin` equal to `http://<Host>`, with our Host. */
export function agentConfigWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (req.method !== 'POST' || typeof origin !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (new URL(req.url ?? '/', 'http://x').pathname !== SKILL_ROUTE) return false;
  return origin === `http://${host}`;
}

/** How long the 413 waits for the rest of an oversized body before dropping the request. */
const BODY_CUTOFF_MS = 1000;

/** The body, or `null` as soon as it exceeds `max`: then it stops reading (the rest is not even consumed). */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return resolve(null);
    const parts: Buffer[] = [];
    let size = 0;
    const onData = (part: Buffer) => {
      size += part.length;
      if (size <= max) return void parts.push(part);
      req.off('data', onData);
      req.pause();
      resolve(null);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 413 without keeping the rest of the body. The connection does not drop right away: a client still
 * sending the body would get EPIPE before reading the 413. The rest is discarded for at most
 * `BODY_CUTOFF_MS` and, if it does not end by then (an endless body), the request is destroyed.
 */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  const cutoff = setTimeout(() => req.destroy(), BODY_CUTOFF_MS);
  cutoff.unref();
  req.once('end', () => clearTimeout(cutoff));
  req.once('close', () => clearTimeout(cutoff));
  req.resume();
  send(res, 413, { error: 'corpo grande demais' });
}

export function createAgentConfigRoute(opts: AgentConfigOptions): AgentConfigRoute {
  const backups = opts.backups ?? defaultBackupsDir();
  const log = opts.log ?? (() => {});

  async function context(requestedProject: unknown) {
    if (requestedProject !== undefined && requestedProject !== null && typeof requestedProject !== 'string') throw new AgentConfigError(400, 'project: um caminho de `projects`');
    const [folders, projects] = await Promise.all([opts.folders(), opts.projects()]);
    const project = chooseProject(requestedProject as string | null | undefined, projects);
    return { folders, projects, project, roots: await rootsFor(folders, project) };
  }

  async function write(req: IncomingMessage, res: ServerResponse) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'use application/json' });
    const text = await readBody(req, MAX_SKILL_BODY);
    if (text === null) return tooLarge(req, res);
    let body: Record<string, unknown>;
    try {
      const o: unknown = JSON.parse(text);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error();
      body = o as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: 'JSON inválido: { root, name, content, version? }' });
    }
    const { roots } = await context(body.project);
    const root = skillRoot(body.root, roots);
    // `create: true` (the screen's "Nova"): only creates; if the skill already exists, 409 instead
    // of replacing it with a backup. Checked in `writeSkill`, inside the file's queue.
    const r = await writeSkill({ root, name: body.name, content: body.content, version: body.version, create: body.create === true, backups, now: opts.now });
    log(`skill ${String(body.name)} gravada em ${root.id}${r.backup ? ' (com backup)' : ' (nova)'}`);
    send(res, 200, r);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (url.pathname === AGENT_CONFIG_ROUTE) {
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      const [folders, projects] = await Promise.all([opts.folders(), opts.projects()]);
      // `backups`: the folder where writing keeps what it replaces, for the screen's "Backups" button.
      return send(res, 200, { ...(await readAgentConfig({ folders, projects, project: url.searchParams.get('project') })), backups });
    }
    if (url.pathname === SKILL_ROUTE) {
      if (req.method === 'POST') return write(req, res);
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET ou POST' });
      const { roots } = await context(url.searchParams.get('project'));
      const skill = await readSkill(skillRoot(url.searchParams.get('root'), roots), url.searchParams.get('name'));
      return skill ? send(res, 200, skill) : send(res, 404, { error: 'skill não encontrada' });
    }
    send(res, 404, { error: 'não encontrado' });
  }

  return async (req, res, url) => {
    try {
      await route(req, res, url);
    } catch (err) {
      if (err instanceof AgentConfigError) return send(res, err.status, { error: err.message });
      throw err;
    }
  };
}
