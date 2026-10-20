// Decision capture through Claude Code hooks, from the already normalized event
// (src/ingest/hooks). It hangs on the receiver's `onEvent`:
//
//   const capture = new HookDecisionCapture({ decisions });
//   startHookReceiver({ storage, onEvent: (r) => capture.onEvent(r.event) });
//
// - question: `PostToolUse` of `AskUserQuestion`, with the questions in the input and the answers in the response;
// - plan: `PostToolUse` of `ExitPlanMode` (a rejected plan does not arrive here: the transcript handles it);
// - permission: `PreToolUse`, then the `permission_prompt` notification (or a `PermissionRequest`),
//   then `PostToolUse` of the same call (allowed) or nothing from it until the next `Stop` or prompt (denied).
// The source key is the `tool_use_id` one, the same as the transcript's, so the two paths do not duplicate.

import { mainAgentId, subagentId } from '../ingest/history/importer.ts';
import type { SessionEvent } from '../model.ts';
import type { Decision } from './model.ts';
import type { DecisionPort } from './port.ts';
import { registerDecision, type DecisionDraft } from './registry.ts';
import { DECISION_TOOLS, permissionDraft, planDraft, questionDrafts, type CaptureBase } from './capture-common.ts';
import { isRejection } from './text.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface PendingTool {
  toolUseId: string;
  toolName: string;
  input: unknown;
  agentId: string | null;
  /** A notificação de permissão apontou para esta chamada. */
  prompted: boolean;
}

/** Chamadas abertas por sessão. Acima disso, as mais antigas saem: nunca vão ter resposta. */
const MAX_PENDING = 64;

export interface HookCaptureOptions {
  decisions: DecisionPort;
  /** Branch da sessão, quando quem chama sabe (o hook não traz). O transcript completa depois. */
  branchOf?: (sessionId: string, cwd: string | null) => string | null | Promise<string | null>;
  now?: () => string;
}

export class HookDecisionCapture {
  private readonly pending = new Map<string, Map<string, PendingTool>>();
  private readonly now: () => string;
  private readonly opts: HookCaptureOptions;

  constructor(opts: HookCaptureOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Recebe um evento de hook e registra as decisões que ele fecha. Devolve as registradas agora. */
  async onEvent(event: SessionEvent): Promise<Decision[]> {
    const drafts = await this.drafts(event);
    const out: Decision[] = [];
    for (const d of drafts) {
      const r = await registerDecision(this.opts.decisions, d, this.now());
      if (r.created) out.push(r.decision);
    }
    return out;
  }

  private async base(event: SessionEvent, p: Json, toolUseId: string | null, agentId: string | null): Promise<CaptureBase> {
    const cwd = str(p.cwd);
    return {
      sessionId: event.sessionId,
      agentId,
      repo: cwd,
      branch: this.opts.branchOf ? await this.opts.branchOf(event.sessionId, cwd) : null,
      transcriptPath: str(p.transcript_path),
      uuid: null,
      toolUseId,
      at: event.createdAt,
    };
  }

  private open(sessionId: string): Map<string, PendingTool> {
    let m = this.pending.get(sessionId);
    if (!m) this.pending.set(sessionId, (m = new Map()));
    return m;
  }

  private async drafts(event: SessionEvent): Promise<DecisionDraft[]> {
    const p = isObj(event.data) ? event.data : {};
    const toolName = str(p.tool_name);
    const toolUseId = str(p.tool_use_id);
    const agentId = str(p.agent_id) ? subagentId(event.sessionId, str(p.agent_id)!) : mainAgentId(event.sessionId);
    const pend = this.open(event.sessionId);

    switch (event.type) {
      case 'PreToolUse': {
        if (!toolName || !toolUseId || DECISION_TOOLS.has(toolName)) return [];
        pend.set(toolUseId, { toolUseId, toolName, input: p.tool_input, agentId, prompted: false });
        while (pend.size > MAX_PENDING) pend.delete(pend.keys().next().value!);
        return [];
      }
      case 'Notification':
      case 'PermissionRequest': {
        const isPermission =
          event.type === 'PermissionRequest' ||
          p.notification_type === 'permission_prompt' ||
          /\bpermission\b/i.test(str(p.message) ?? '');
        if (!isPermission) return [];
        // "Claude needs your permission to use Bash": a última chamada aberta daquela ferramenta.
        const named = toolName ?? /permission to use (\S+)/i.exec(str(p.message) ?? '')?.[1] ?? null;
        const open = [...pend.values()].filter((t) => !t.prompted && (!named || t.toolName === named));
        const target = open.at(-1);
        if (target) target.prompted = true;
        return [];
      }
      case 'PostToolUse': {
        if (toolName === 'AskUserQuestion' && toolUseId) {
          const r = isObj(p.tool_response) ? p.tool_response : {};
          return questionDrafts(await this.base(event, p, toolUseId, agentId), p.tool_input, r.answers ?? (isObj(p.tool_input) ? p.tool_input.answers : null));
        }
        if (toolName === 'ExitPlanMode' && toolUseId) {
          return [planDraft(await this.base(event, p, toolUseId, agentId), p.tool_input, [])];
        }
        return this.resolve(event, p, toolUseId, true);
      }
      case 'PostToolUseFailure': {
        // Falha depois de permitir é falha da ferramenta, não recusa: só a recusa vira "negar".
        const error = str(p.error) ?? (isObj(p.tool_response) ? str(p.tool_response.error) : null);
        const denied = p.is_interrupt === true || isRejection(error) || /\b(denied|rejected)\b/i.test(error ?? '');
        return this.resolve(event, p, toolUseId, !denied);
      }
      case 'UserPromptSubmit':
      case 'Stop':
      case 'SessionEnd': {
        // O turno seguiu sem a chamada que pediu permissão: a pessoa negou.
        const out: DecisionDraft[] = [];
        for (const t of [...pend.values()]) {
          if (!t.prompted) continue;
          pend.delete(t.toolUseId);
          out.push(permissionDraft(await this.base(event, p, t.toolUseId, t.agentId), t.toolName, t.input, false));
        }
        if (event.type === 'SessionEnd') this.pending.delete(event.sessionId);
        return out;
      }
      default:
        return [];
    }
  }

  private async resolve(event: SessionEvent, p: Json, toolUseId: string | null, allowed: boolean): Promise<DecisionDraft[]> {
    if (!toolUseId) return [];
    const pend = this.open(event.sessionId);
    const t = pend.get(toolUseId);
    pend.delete(toolUseId);
    if (!t?.prompted) return [];
    return [permissionDraft(await this.base(event, p, toolUseId, t.agentId), t.toolName, t.input, allowed)];
  }
}
