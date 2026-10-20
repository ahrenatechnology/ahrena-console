// Decision capture from the Claude Code JSONL transcript. The transcript is untrusted content:
// each line is only decoded with JSON.parse and read field by field; nothing in it is executed, followed
// or taken as an instruction, and all text goes through `cleanText` (one line, no control chars, truncated).
//
// What comes out of here:
// - question: the `tool_use` of `AskUserQuestion` and its `tool_result`, with `toolUseResult.answers`;
// - plan: the `tool_result` of an approved `ExitPlanMode`; the ones rejected before become the alternatives;
// - correction (deterministic): rejecting a plan with what the person wrote;
// - permission denied: rejecting any other tool (only the hooks see "allow",
//   because the transcript does not say when there was a permission request);
// - correction (inferred, to confirm): a short reply from the person that starts by contradicting the
//   question the agent just asked. It joins the topic's chain only when the turn had a single decision.

import { readFile } from 'node:fs/promises';
import { mainAgentId, subagentId } from '../ingest/history/importer.ts';
import { isoTimestamp } from '../ingest/history/transcript.ts';
import type { Decision } from './model.ts';
import type { DecisionPort } from './port.ts';
import { registerDecision, type DecisionDraft } from './registry.ts';
import { correctionDraft, permissionDraft, planDraft, questionDrafts, type CaptureBase } from './capture-common.ts';
import { cleanText, isRejection, looksLikeCorrection, planTitle, rejectionFeedback } from './text.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface ToolCall {
  name: string;
  input: unknown;
}

interface AgentTurn {
  /** Última fala do agente desde o último prompt: a proposta que uma correção contraria. */
  proposal: string | null;
  /** A última fala terminou numa pergunta: só um "não, …" a ela é correção. */
  asks: boolean;
  /** Assuntos das decisões do turno. Com um só, a correção entra na cadeia dele; com vários, fica sem. */
  topics: (string | null)[];
}

/** Texto de um `tool_result`, que vem como string ou como lista de blocos de texto. */
function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as Json).text as string);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/** Texto do prompt da pessoa; `null` para linhas que não são prompt (meta, comandos, avisos do sistema). */
function promptText(line: Json, content: unknown): string | null {
  if (line.isMeta === true) return null;
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => isObj(b) && b.type === 'tool_result')) return null;
    text = content
      .filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b as Json).text as string)
      .join('\n');
  }
  const t = text?.trim() ?? '';
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:')) return null;
  return t;
}

/** "Your questions have been answered: "P"="R", ..." quando a linha não traz `toolUseResult`. */
function answersFromText(text: string | null): Json | null {
  if (!text) return null;
  const out: Json = {};
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return Object.keys(out).length ? out : null;
}

export interface TranscriptExtractOptions {
  /** Caminho do transcript, para o "ver na conversa". */
  transcriptPath?: string | null;
}

/** Função pura: linhas do transcript (texto ou já decodificadas) → decisões a registrar, em ordem. */
export function extractTranscriptDecisions(lines: Iterable<unknown>, opts: TranscriptExtractOptions = {}): DecisionDraft[] {
  const tools = new Map<string, ToolCall>();
  const rejectedPlans = new Map<string, string[]>();
  const turns = new Map<string, AgentTurn>();
  const out: DecisionDraft[] = [];

  for (const raw of lines) {
    let line: unknown = raw;
    if (typeof raw === 'string') {
      if (!raw.trim()) continue;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (!isObj(line)) continue;
    const sessionId = str(line.sessionId);
    const at = isoTimestamp(line.timestamp);
    const message = isObj(line.message) ? line.message : null;
    if (!sessionId || !at || !message) continue;
    const transcriptAgent = str(line.agentId);
    const agentId = transcriptAgent ? subagentId(sessionId, transcriptAgent) : mainAgentId(sessionId);
    const turnKey = agentId;
    const turn = turns.get(turnKey) ?? { proposal: null, asks: false, topics: [] };
    turns.set(turnKey, turn);
    const base = (toolUseId: string | null): CaptureBase => ({
      sessionId,
      agentId,
      repo: str(line.cwd),
      branch: str(line.gitBranch),
      transcriptPath: opts.transcriptPath ?? null,
      uuid: str(line.uuid),
      toolUseId,
      at,
    });
    const emit = (drafts: DecisionDraft[]): void => {
      out.push(...drafts);
      turn.topics.push(...drafts.map((d) => d.topic));
    };
    const content = message.content;

    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_use' && str(b.id) && str(b.name)) tools.set(b.id as string, { name: b.name as string, input: b.input });
        if (b.type === 'text' && cleanText(b.text)) {
          turn.proposal = cleanText(b.text);
          turn.asks = typeof b.text === 'string' && /\?\s*$/.test(b.text);
        }
      }
      continue;
    }
    if (line.type !== 'user') continue;

    if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result')) {
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_result') continue;
        const toolUseId = str(b.tool_use_id);
        const call = toolUseId ? tools.get(toolUseId) : undefined;
        if (!toolUseId || !call) continue;
        const text = resultText(b.content);
        const rejected = isRejection(text, line.toolUseResult);

        if (call.name === 'AskUserQuestion') {
          if (rejected) continue;
          const tur = isObj(line.toolUseResult) ? line.toolUseResult : null;
          emit(questionDrafts(base(toolUseId), call.input, tur?.answers ?? answersFromText(text)));
        } else if (call.name === 'ExitPlanMode') {
          const list = rejectedPlans.get(sessionId) ?? [];
          rejectedPlans.set(sessionId, list);
          const title = planTitle(isObj(call.input) ? call.input.plan : null);
          if (rejected) {
            if (title) list.push(title);
            const feedback = rejectionFeedback(text);
            if (feedback) {
              emit([correctionDraft(base(toolUseId), { sourceKey: `tool:${toolUseId}`, text: feedback, proposal: title, topic: 'plan', inferred: false })]);
            }
          } else if (b.is_error !== true) {
            emit([planDraft(base(toolUseId), call.input, list)]);
            list.length = 0;
          }
        } else if (rejected) {
          emit([permissionDraft(base(toolUseId), call.name, call.input, false)]);
        }
      }
      continue;
    }

    const prompt = promptText(line, content);
    if (!prompt) continue;
    const uuid = str(line.uuid);
    // Conservador: só a resposta "não, …" a uma pergunta que o agente acabou de fazer.
    if (uuid && turn.proposal && turn.asks && looksLikeCorrection(prompt)) {
      const text = cleanText(prompt);
      if (text) {
        out.push(correctionDraft(base(null), { sourceKey: `prompt:${uuid}`, text, proposal: turn.proposal, topic: turn.topics.length === 1 ? turn.topics[0] : null, inferred: true }));
      }
    }
    // Prompt novo: começa outro turno do agente.
    turn.proposal = null;
    turn.asks = false;
    turn.topics = [];
  }
  return out;
}

export interface TranscriptCaptureReport {
  found: number;
  created: Decision[];
}

/** Lê o transcript do disco (só lê) e registra as decisões dele. Pode rodar de novo: não duplica. */
export async function captureTranscriptFile(port: DecisionPort, path: string, now: string): Promise<TranscriptCaptureReport> {
  const text = await readFile(path, 'utf8');
  const drafts = extractTranscriptDecisions(text.split('\n'), { transcriptPath: path });
  const created: Decision[] = [];
  for (const d of drafts) {
    const r = await registerDecision(port, d, now);
    if (r.created) created.push(r.decision);
  }
  return { found: drafts.length, created };
}
