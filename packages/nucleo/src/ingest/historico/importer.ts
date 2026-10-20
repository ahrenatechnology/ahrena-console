// Importação do histórico de `~/.claude/projects` para o núcleo, pela porta de armazenamento.
//
// Idempotente e retomável:
// - cada linha vira um evento de id estável (`jsonl:<uuid>`); gravar de novo não duplica;
// - o uso de tokens é recalculado a partir dos eventos da sessão, deduplicado por mensagem;
// - o cursor de cada arquivo (deslocamento em bytes, tamanho e mtime) fica no `metadata.importacao`
//   da sessão (arquivo principal) ou do agente (arquivo do subagente) e é gravado por último.
//   Se a importação cair no meio, a próxima relê do cursor anterior e os ids absorvem a repetição.
//
// Seguir em tempo real é do `follower.ts` (item 1.3), que chama esta importação só com os arquivos
// que mudaram. Não decide estados (item 1.5): sessão nova nasce
// `completed`, e sessão que já existe (criada pelos hooks, por exemplo) mantém status e espera.

import type { Agent, Metadata, Session, SessionEvent, TokenCounts } from '../../model.ts';
import type { StoragePort } from '../../storage-port.ts';
import {
  defaultProjectsRoot,
  discoverTranscripts,
  fileStat,
  readLinesFrom,
  readSubagentMeta,
  readTail,
  type FileStat,
  type SubagentMeta,
  type TranscriptFile,
} from './files.ts';
import { parseLine, truncate, TASK_MAX, type EventData } from './transcript.ts';
import { aggregateUsage, bucketKey, type UsageSample } from './usage.ts';
import { applyFloor } from '../../cost/floor.ts';
import { updatePlan } from '../../plan/recording.ts';
import { updateContextMeters } from '../../context/recording.ts';

export interface ImportOptions {
  storage: StoragePort;
  /** Padrão: `~/.claude/projects`. */
  root?: string;
  /**
   * Só estes arquivos, em vez de varrer a raiz. É o que o seguidor (item 1.3) usa para importar
   * apenas o que mudou. Cada sessão afetada continua sendo gravada inteira pelo cursor.
   */
  files?: TranscriptFile[];
  /**
   * Chamado depois de gravar cada sessão que ganhou eventos, com o transcript principal e os
   * eventos novos. É onde a API pendura a captura das decisões pelo transcript (#99).
   */
  onSession?: (s: SessaoImportada) => Promise<void>;
}

export interface SessaoImportada {
  sessionId: string;
  /** O transcript principal; `null` quando só os subagentes mudaram. */
  transcriptPath: string | null;
  added: SessionEvent[];
}

export interface ImportReport {
  filesFound: number;
  /** Arquivos lidos (no todo ou a partir do cursor). */
  filesRead: number;
  /** Arquivos sem nada novo desde a última importação. */
  filesUnchanged: number;
  /** Subagentes do layout antigo cujo arquivo não diz a qual sessão pertence. */
  filesOrphaned: number;
  sessionsTouched: number;
  eventsAdded: number;
  /** Eventos que já estavam gravados (releitura). */
  eventsExisting: number;
  linesInvalid: number;
  /** Arquivos relidos do início porque encolheram ou foram reescritos desde o cursor. */
  filesRewound: number;
}

/** Cursor gravado em `metadata.importacao`. */
export interface ImportCursor {
  file: string;
  offset: number;
  size: number;
  mtimeMs: number;
  /** Bytes logo antes de `offset` (`readTail`). Ausente nos cursores gravados antes do item 1.3. */
  tail?: string;
}

export const mainAgentId = (sessionId: string): string => `${sessionId}:main`;
export const subagentId = (sessionId: string, transcriptAgentId: string): string => `${sessionId}:${transcriptAgentId}`;
export const eventId = (uuid: string): string => `jsonl:${uuid}`;

const SOURCE = 'import';
const TITLE_PRIORITY = ['customTitle', 'agentName', 'aiTitle', 'summary'] as const;

function readCursor(metadata: Metadata | undefined): ImportCursor | null {
  const c = metadata?.importacao as Partial<ImportCursor> | undefined;
  if (!c || typeof c.file !== 'string' || !Number.isInteger(c.offset) || !Number.isInteger(c.size) || typeof c.mtimeMs !== 'number') {
    return null;
  }
  return c as ImportCursor;
}

/** De onde ler: `null` quando o arquivo não mudou desde o cursor. */
export function resumeOffset(cursor: ImportCursor | null, relPath: string, st: FileStat): number | null {
  if (!cursor || cursor.file !== relPath) return 0;
  if (st.size === cursor.size && st.mtimeMs === cursor.mtimeMs) return null;
  // Menor que o já lido: o arquivo foi reescrito. Relê do início; os ids evitam duplicar.
  return st.size < cursor.offset ? 0 : cursor.offset;
}

const minIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);
const maxIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

interface AgentFacts {
  startedAt: string | null;
  lastAt: string | null;
  task: string | null;
  model: string | null;
}

const emptyFacts = (): AgentFacts => ({ startedAt: null, lastAt: null, task: null, model: null });

interface SessionWork {
  sessionId: string;
  main: TranscriptFile | null;
  subagents: TranscriptFile[];
}

class SessionImport {
  readonly sessionId: string;
  readonly storage: StoragePort;
  readonly report: ImportReport;
  cwd: string | null = null;
  titles = new Map<string, string>();
  /** Fatos por id de agente do núcleo, só das linhas lidas nesta rodada. */
  facts = new Map<string, AgentFacts>();
  /** `tool_use_id → agente` que chamou a ferramenta; dá o pai de cada subagente. */
  toolUseOwner = new Map<string, string>();
  /** Eventos novos desta rodada, para o plano da sessão (item 1.9). */
  added: SessionEvent[] = [];
  read = false;

  constructor(sessionId: string, storage: StoragePort, report: ImportReport) {
    this.sessionId = sessionId;
    this.storage = storage;
    this.report = report;
  }

  agentFacts(agentId: string): AgentFacts {
    let f = this.facts.get(agentId);
    if (!f) this.facts.set(agentId, (f = emptyFacts()));
    return f;
  }

  /** Lê o arquivo a partir do cursor. Devolve o novo cursor, ou `null` se não havia nada novo. */
  async readFile(file: TranscriptFile, cursor: ImportCursor | null, defaultAgentId: string): Promise<ImportCursor | null> {
    const st = await fileStat(file.path);
    if (!st) return null;
    let start = resumeOffset(cursor, file.relPath, st);
    if (start === null) {
      this.report.filesUnchanged++;
      return null;
    }
    const sameFile = cursor !== null && cursor.file === file.relPath && cursor.offset > 0;
    // Reescrito com tamanho igual ou maior: os bytes antes do cursor não são mais os mesmos.
    if (start > 0 && cursor?.tail !== undefined && (await readTail(file.path, start)) !== cursor.tail) start = 0;
    if (sameFile && start === 0) this.report.filesRewound++;
    this.report.filesRead++;
    this.read = true;
    const toolNames = new Map<string, string>();
    let offset = start;
    for await (const { line, end } of readLinesFrom(file.path, start)) {
      offset = end;
      const parsed = parseLine(line, toolNames);
      if (!parsed) {
        this.report.linesInvalid++;
        continue;
      }
      // Linha de outra sessão dentro do arquivo (não deveria acontecer): ignora.
      if (parsed.sessionId && parsed.sessionId !== this.sessionId) continue;
      const agentId = parsed.transcriptAgentId ? subagentId(this.sessionId, parsed.transcriptAgentId) : defaultAgentId;
      const facts = this.agentFacts(agentId);
      if (parsed.timestamp) {
        facts.startedAt = minIso(facts.startedAt, parsed.timestamp);
        facts.lastAt = maxIso(facts.lastAt, parsed.timestamp);
      }
      if (parsed.model) facts.model = parsed.model;
      if (facts.task === null && parsed.promptText) facts.task = truncate(parsed.promptText, TASK_MAX);
      if (this.cwd === null && parsed.cwd) this.cwd = parsed.cwd;
      if (parsed.title) this.titles.set(parsed.title.kind, parsed.title.value);

      for (const e of parsed.events) {
        if (e.type === 'ToolUse' && e.data.toolUseId) this.toolUseOwner.set(e.data.toolUseId, agentId);
        const event: SessionEvent = {
          id: eventId(e.uuid),
          sessionId: this.sessionId,
          agentId,
          type: e.type,
          toolName: e.toolName,
          summary: e.summary,
          data: e.data,
          createdAt: e.createdAt,
        };
        if (await this.storage.appendEvent(event)) {
          this.report.eventsAdded++;
          this.added.push(event);
        } else this.report.eventsExisting++;
      }
    }
    const tail = await readTail(file.path, offset);
    return { file: file.relPath, offset, size: st.size, mtimeMs: st.mtimeMs, ...(tail !== null ? { tail } : {}) };
  }

  /** Recalcula o uso de tokens de todos os eventos importados da sessão e grava os buckets. */
  async writeUsage(updatedAt: string): Promise<Map<string, TokenCounts>> {
    const samples: UsageSample[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.storage.listEvents(this.sessionId, { limit: 500, cursor });
      for (const e of page.items) {
        const data = e.data as EventData | null;
        if (e.id.startsWith('jsonl:') && data?.usage) {
          samples.push({ eventId: e.id, agentId: e.agentId ?? mainAgentId(this.sessionId), usage: data.usage });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);

    const { buckets, byAgent } = aggregateUsage(this.sessionId, samples);
    const existing = new Map((await this.storage.listTokenUsage(this.sessionId)).map((u) => [bucketKey(u), u]));
    for (const b of buckets) {
      const prev = existing.get(bucketKey(b));
      // Piso da compactação (item 1.6): se a contagem viva caiu, o que sumiu vai para o piso.
      await this.storage.putTokenUsage({ ...b, baseline: applyFloor(prev, b.tokens), updatedAt });
    }
    return byAgent;
  }

  title(existing: string | null): string | null {
    for (const k of TITLE_PRIORITY) {
      const t = this.titles.get(k);
      if (t) return t;
    }
    return existing;
  }
}

function mergeAgent(
  prev: Agent | null,
  base: Omit<Agent, 'status' | 'endedAt' | 'updatedAt' | 'metadata' | 'startedAt'>,
  facts: AgentFacts,
  fallbackAt: string,
  metadata: Metadata,
): Agent {
  const startedAt = minIso(prev?.startedAt ?? null, facts.startedAt) ?? fallbackAt;
  const lastAt = maxIso(prev?.updatedAt ?? null, facts.lastAt) ?? startedAt;
  return {
    ...base,
    name: base.name ?? prev?.name ?? null,
    subagentType: base.subagentType ?? prev?.subagentType ?? null,
    task: prev?.task ?? base.task,
    parentAgentId: prev?.parentAgentId ?? base.parentAgentId,
    currentTool: prev?.currentTool ?? null,
    status: prev?.status ?? 'completed',
    startedAt,
    endedAt: prev ? prev.endedAt : lastAt,
    updatedAt: lastAt,
    metadata: { ...(prev?.metadata ?? {}), ...metadata },
  };
}

async function importSession(work: SessionWork, storage: StoragePort, report: ImportReport, onSession?: ImportOptions['onSession']): Promise<void> {
  const { sessionId } = work;
  const run = new SessionImport(sessionId, storage, report);
  const prevSession = await storage.getSession(sessionId);
  const prevAgents = new Map((await storage.listAgents(sessionId)).map((a) => [a.id, a]));
  const mainId = mainAgentId(sessionId);

  const mainCursor = work.main ? await run.readFile(work.main, readCursor(prevSession?.metadata), mainId) : null;
  const subCursors = new Map<string, { cursor: ImportCursor | null; meta: SubagentMeta | null }>();
  for (const file of work.subagents) {
    const id = subagentId(sessionId, file.agentId!);
    const cursor = await run.readFile(file, readCursor(prevAgents.get(id)?.metadata), id);
    run.agentFacts(id);
    subCursors.set(id, { cursor, meta: await readSubagentMeta(file.metaPath) });
  }
  if (!run.read) return;
  report.sessionsTouched++;

  let startedAt = prevSession?.startedAt ?? null;
  let lastAt = prevSession?.updatedAt ?? null;
  let model = prevSession?.model ?? null;
  for (const f of run.facts.values()) {
    startedAt = minIso(startedAt, f.startedAt);
    lastAt = maxIso(lastAt, f.lastAt);
  }
  const mainFacts = run.agentFacts(mainId);
  model = mainFacts.model ?? model;
  if (startedAt === null) {
    // Arquivo sem nenhuma linha datada: usa o mtime para ter uma data.
    const st = work.main ? await fileStat(work.main.path) : null;
    startedAt = new Date(st?.mtimeMs ?? 0).toISOString();
  }
  const updatedAt = lastAt ?? startedAt;

  const tokensByAgent = await run.writeUsage(updatedAt);
  // Só os eventos novos: o que já estava gravado já passou pelo plano (relidos não reaplicam).
  await updatePlan(storage, sessionId, run.added);
  // Medidor de contexto (item 1.7): uso da última mensagem e marcas de compactação.
  await updateContextMeters(storage, sessionId, run.added);
  if (onSession && run.added.length > 0) await onSession({ sessionId, transcriptPath: work.main?.path ?? null, added: run.added });
  const tokens = (id: string) => tokensByAgent.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

  // Agente principal.
  await storage.putAgent(
    mergeAgent(
      prevAgents.get(mainId) ?? null,
      { id: mainId, sessionId, name: null, type: 'main', subagentType: null, task: mainFacts.task, currentTool: null, parentAgentId: null },
      mainFacts,
      startedAt,
      { tokens: tokens(mainId) },
    ),
  );

  // Subagentes: os de arquivo próprio e os que só apareceram em linhas `isSidechain` do principal.
  for (const id of run.facts.keys()) {
    if (id === mainId) continue;
    const prev = prevAgents.get(id) ?? null;
    const sub = subCursors.get(id);
    const meta = sub?.meta ?? null;
    const facts = run.agentFacts(id);
    const parent = (meta?.toolUseId && run.toolUseOwner.get(meta.toolUseId)) || mainId;
    const metadata: Metadata = { tokens: tokens(id) };
    if (sub?.cursor) metadata.importacao = sub.cursor;
    if (meta?.toolUseId) metadata.toolUseId = meta.toolUseId;
    if (meta?.spawnDepth !== null && meta?.spawnDepth !== undefined) metadata.spawnDepth = meta.spawnDepth;
    await storage.putAgent(
      mergeAgent(
        prev,
        {
          id,
          sessionId,
          name: meta?.description ?? truncate(facts.task, 80),
          type: 'subagent',
          subagentType: meta?.agentType ?? null,
          task: facts.task,
          currentTool: null,
          parentAgentId: parent,
        },
        facts,
        startedAt,
        metadata,
      ),
    );
  }

  // A sessão por último: o cursor do arquivo principal só avança depois que tudo foi gravado.
  const metadata: Metadata = { ...(prevSession?.metadata ?? {}) };
  if (mainCursor) metadata.importacao = mainCursor;
  const session: Session = prevSession
    ? {
        ...prevSession,
        name: run.title(prevSession.name),
        cwd: prevSession.cwd ?? run.cwd,
        model,
        startedAt: minIso(prevSession.startedAt, startedAt)!,
        updatedAt: maxIso(prevSession.updatedAt, updatedAt)!,
        metadata,
      }
    : {
        id: sessionId,
        name: run.title(null),
        status: 'completed',
        cwd: run.cwd,
        model,
        source: SOURCE,
        startedAt,
        endedAt: updatedAt,
        awaitingInputSince: null,
        awaitingReason: null,
        updatedAt,
        // A conta pelo transcript e pelos perfis é da #111; até lá, "Sem conta".
        accountId: null,
        accountSource: null,
        metadata,
      };
  await storage.putSession(session);
}

/** No layout antigo, o subagente só diz a sessão-mãe dentro das linhas. */
async function sessionIdFromLines(path: string): Promise<string | null> {
  for await (const { line } of readLinesFrom(path, 0)) {
    const parsed = parseLine(line, new Map());
    if (parsed?.sessionId) return parsed.sessionId;
  }
  return null;
}

/**
 * Relê um transcript inteiro e devolve os eventos que passam no filtro, com os mesmos ids da
 * importação. Para reprocessar o que a importação antiga gravou sem os campos de hoje (o
 * `tool_input` das ferramentas do plano, guardado desde o item 1.9).
 */
export async function eventosDoTranscript(path: string, sessionId: string, filtro: (e: SessionEvent) => boolean): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  const toolNames = new Map<string, string>();
  for await (const { line } of readLinesFrom(path, 0)) {
    const parsed = parseLine(line, toolNames);
    if (!parsed || (parsed.sessionId && parsed.sessionId !== sessionId)) continue;
    const agentId = parsed.transcriptAgentId ? subagentId(sessionId, parsed.transcriptAgentId) : mainAgentId(sessionId);
    for (const e of parsed.events) {
      const event: SessionEvent = { id: eventId(e.uuid), sessionId, agentId, type: e.type, toolName: e.toolName, summary: e.summary, data: e.data, createdAt: e.createdAt };
      if (filtro(event)) out.push(event);
    }
  }
  return out;
}

/** Importa (ou continua importando) todo o histórico sob `root`. */
export async function importHistory(options: ImportOptions): Promise<ImportReport> {
  const root = options.root ?? defaultProjectsRoot();
  const files = options.files ?? (await discoverTranscripts(root));
  const report: ImportReport = {
    filesFound: files.length,
    filesRead: 0,
    filesUnchanged: 0,
    filesOrphaned: 0,
    sessionsTouched: 0,
    eventsAdded: 0,
    eventsExisting: 0,
    linesInvalid: 0,
    filesRewound: 0,
  };

  const work = new Map<string, SessionWork>();
  const group = (id: string) => {
    let w = work.get(id);
    if (!w) work.set(id, (w = { sessionId: id, main: null, subagents: [] }));
    return w;
  };
  for (const file of files) {
    if (file.kind === 'main') {
      group(file.sessionId!).main = file;
      continue;
    }
    const sessionId = file.sessionId ?? (await sessionIdFromLines(file.path));
    if (!sessionId) {
      report.filesOrphaned++;
      continue;
    }
    group(sessionId).subagents.push({ ...file, sessionId });
  }

  for (const w of work.values()) await importSession(w, options.storage, report, options.onSession);
  return report;
}
