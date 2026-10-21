// `TurnWatch` over the session's transcript (#61): the confirmation that a message arrived.
//
// Measured on Claude Code CLI 2.1.302 (test/messaging/contract-cli.test.ts): a message that comes
// through the inbox becomes a `user` line in `<configDir>/projects/<project>/<sessionId>.jsonl`
// with `origin: { kind: "peer", verifiedPeerPid: <the writer's pid> }` and `isMeta: true`, and then
// the session answers it. So "delivered" is that line, after the offset the probe took before the
// send, with `verifiedPeerPid` equal to the core's pid (a line without the field also counts: older
// or newer CLIs may not verify the peer).
//
// The transcript follower (src/ingest/history) cannot show it: it follows only one projects root
// and gives `isMeta` lines no event. This reads the same files with the same line reader
// (`readLinesFrom`) and `peerTurnOf`, only the bytes after the offset, and keeps nothing of the
// line but its time: the content has the text.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readLinesFrom } from '../../ingest/history/files.ts';
import { peerTurnOf } from '../../ingest/history/transcript.ts';
import type { LiveProcess } from '../model.ts';
import type { TurnProbe, TurnWatch } from '../ports.ts';

/** A line timestamped this much before the probe opened is not ours (a rewritten file read from 0). */
const CLOCK_SLACK_MS = 5_000;

export interface TranscriptTurnsOptions {
  /** The pid the inbox sees as the writer: the core's. */
  pid?: number;
  now?: () => number;
}

/** `<configDir>/projects/*\/<sessionId>.jsonl`, or `null` while the session has none. */
export async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  const root = join(configDir, 'projects');
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const path = join(root, p.name, `${sessionId}.jsonl`);
    const st = await stat(path).catch(() => null);
    if (st?.isFile()) return path;
  }
  return null;
}

export class TranscriptTurns implements TurnWatch {
  private readonly pid: number;
  private readonly now: () => number;

  constructor({ pid = process.pid, now = Date.now }: TranscriptTurnsOptions = {}) {
    this.pid = pid;
    this.now = now;
  }

  async open(live: LiveProcess, sessionId: string): Promise<TurnProbe> {
    const openedAt = this.now();
    let path = await findTranscript(live.configDir, sessionId);
    let offset = path ? ((await stat(path).catch(() => null))?.size ?? 0) : 0;
    let closed = false;
    const ours = this.pid;
    return {
      async poll(): Promise<number | null> {
        if (closed) return null;
        path ??= await findTranscript(live.configDir, sessionId);
        if (!path) return null;
        const size = (await stat(path).catch(() => null))?.size;
        if (size === undefined) return null;
        // Rewritten shorter: read it again from the start, the time filter keeps the old lines out.
        if (size < offset) offset = 0;
        for await (const { line, end } of readLinesFrom(path, offset)) {
          offset = end;
          const turn = peerTurnOf(line);
          if (!turn || turn.at < openedAt - CLOCK_SLACK_MS) continue;
          if (turn.verifiedPeerPid === null || turn.verifiedPeerPid === ours) return turn.at;
        }
        return null;
      },
      close() {
        closed = true;
      },
    };
  }
}
