/*
 * #465 the live Console sessions linked to work board issues (`WorkSessions`), read from the fleet. A
 * session links to `<repo>#<n>`: n from a `<type>/<n>-…` branch (Desktop's, else git's), else the first
 * reference in its first prompt; the repo is the folder's git remote, lower case, as the Dev Console
 * reads it. Any live session counts, whatever agent runs it. #507 a session whose first prompt is the
 * planning run's (work-plan.ts) links to the issue it names and is marked `planning`, on any branch.
 */

import { repoKey } from '../dev-console/model.ts';
import { gitLocator, type LocateFolder } from '../dev-console/sessions.ts';
import { LIVE_STATES, type FleetReader, type FleetSession } from '../mcp/fleet.ts';
import type { SessionEvent } from '../model.ts';
import { issueOfPrompt, type WorkSessionLink, type WorkSessionState, type WorkSessions } from './work-board.ts';
import { planningKeyOfPrompt } from './work-plan.ts';
import { workKey } from './work.ts';

export interface FleetWorkSessionsOptions {
  fleet: FleetReader;
  /** #465 where a folder is; injected so the tests need no git. */
  locate?: LocateFolder;
}

/**
 * #465 a branch names its issue only in the `<type>/<n>` or `<type>/<n>-<slug>` shape (`feat/500-board`),
 * the slug starting with a letter: the looser `issueDoBranch` would read `claude/foo-bar-123456` as
 * #123456 and `release/2026-11` as #2026.
 */
const ISSUE_BRANCH = /^[a-z]+\/(\d{1,6})(?:-[a-z]|$)/i;
const issueOfBranch = (branch: string | null): number | null => {
  const m = branch ? ISSUE_BRANCH.exec(branch) : null;
  return m ? Number(m[1]) : null;
};

const PROMPT_TYPES = new Set(['UserPromptSubmit', 'UserPrompt']);
/** #465 how far the first prompt is looked for: a session starts with its prompt, so a few pages is plenty. */
const PROMPT_SCAN_PAGES = 3;
const PROMPT_SCAN_PAGE_SIZE = 200;

/** #465 the prompt's own text (`data.prompt` of the hook, `data.text` of the transcript), never the summary. */
function promptText(e: SessionEvent): string | null {
  const d = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : null;
  const text = typeof d?.prompt === 'string' ? d.prompt : typeof d?.text === 'string' ? d.text : null;
  return text?.trim() ? text : null;
}

export class FleetWorkSessions implements WorkSessions {
  private readonly fleet: FleetReader;
  private readonly locate: LocateFolder;
  /** #465 session id → its first prompt's text: it never changes once found. */
  private readonly firstPrompts = new Map<string, string>();

  constructor({ fleet, locate = gitLocator({ now: fleet.now }) }: FleetWorkSessionsOptions) {
    this.fleet = fleet;
    this.locate = locate;
  }

  async links(): Promise<WorkSessionLink[]> {
    const out: WorkSessionLink[] = [];
    const live = await this.fleet.live();
    // #465 an ended session never comes back to the live list: its prompt leaves the memo.
    const ids = new Set(live.map((s) => s.session.id));
    for (const id of this.firstPrompts.keys()) if (!ids.has(id)) this.firstPrompts.delete(id);
    for (const s of live) {
      // #507 a planning run names its issue in its first prompt, whatever branch the folder is on.
      const prompt = await this.firstPrompt(s.session.id);
      const planningKey = prompt ? planningKeyOfPrompt(prompt) : null;
      const key = planningKey ?? (await this.keyOf(s, prompt));
      if (!key) continue;
      const state = await this.stateOf(s);
      const since = state === 'needs-you' ? (s.session.awaitingInputSince ?? s.session.updatedAt) : s.session.startedAt;
      out.push({ sessionId: s.session.id, key, state, since, ...(planningKey ? { planning: true as const } : {}) });
    }
    return out;
  }

  private async keyOf(s: FleetSession, prompt: string | null): Promise<string | null> {
    const location = s.session.cwd ? await this.locate(s.session.cwd) : { repo: null, branch: null };
    const repo = location.repo ? repoKey(location.repo) : null;
    // #465 the Desktop branch first, then git's, each only in the issue shape; then the first prompt.
    const fromBranch = issueOfBranch(s.desktop?.branch ?? null) ?? issueOfBranch(location.branch);
    if (fromBranch !== null && repo) return workKey(repo, fromBranch);
    return prompt ? issueOfPrompt(prompt, repo) : null;
  }

  /** #465 the same rule as `needingYou` (#245 blocked level) and the Dev Console's `working`. */
  private async stateOf(s: FleetSession): Promise<WorkSessionState> {
    if (s.inbox.needsYou && (await this.fleet.attention(s)).group === 'blocking') return 'needs-you';
    const state = s.inbox.state;
    return LIVE_STATES.includes(state) && state !== 'waiting' && state !== 'error' ? 'working' : 'idle';
  }

  private async firstPrompt(sessionId: string): Promise<string | null> {
    const hit = this.firstPrompts.get(sessionId);
    if (hit !== undefined) return hit;
    let cursor: string | null = null;
    for (let page = 0; page < PROMPT_SCAN_PAGES; page++) {
      const events = await this.fleet.storage.listEvents(sessionId, { limit: PROMPT_SCAN_PAGE_SIZE, cursor });
      for (const e of events.items) {
        const text = PROMPT_TYPES.has(e.type) ? promptText(e) : null;
        if (text === null) continue;
        this.firstPrompts.set(sessionId, text);
        return text;
      }
      cursor = events.nextCursor;
      if (!cursor) break;
    }
    return null;
  }
}
