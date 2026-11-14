// The dev → Argos → Erodos → Argos loop, grouped by the PR (or the issue) each subagent touched (#332, C81/C82).
//
// Pure functions: the route reads the port, this file only derives. Nothing is invented: a subagent whose task
// names no PR and no issue goes to the "none" group, tied to the main agent, with no step order claimed.
//
// Where the PR of a subagent comes from, in this order (decision of the wireframe, PR #364):
// 1. `PR #N`, a bare `#N` that some subagent of the session also wrote as `PR #N`, or the PR URL
//    (`/pull/N`) in the subagent's name or task;
// 2. the branch (`metadata.branch` or `metadata.workflow.branch`): when another subagent of the session has the
//    same branch and a PR, this one joins that PR;
// 3. the issue the task cites with no PR (`Refs #N`, `issue #N`, a bare `#N`). A branch like `feat/333-x`
//    carries issue 333 to the PR group whose subagents are on it, so the issue group folds into the PR.
// An orchestrator (an `athena` type, or the parent of another subagent whose loop role is `other`) gets no PR from rule 1 (#586)
// and feeds no bare `#N` into a PR (#586): its `PR #N` is a reference, and its bare refs are issues. A dev, review or
// fix agent that delegates is not one: it keeps its own PR. (#586)
// A task that cites two PRs stays in the first and carries the other in `otherRefs`.
//
// An orchestrator is the parent of the loops, never a step of one (#588): it leaves the groups and goes to
// `orchestrators` (in start order), with the ids of the groups it leads, most recent first. (#588)
// A group is led by the orchestrator that is the parent of its first step (`LoopStep.parentAgentId`); the `none` (#588)
// group is never a layer. (#588)
// `totals.layers` counts the groups an orchestrator leads; the orchestrator still counts in `totals.subagents`, and in (#588)
// no round or change request. (#588)
// Without an orchestrator the output is the same, with `orchestrators: []` and `layers: 0`. (#588)
// The agency's build agents (`apollo`, `iris`, `clio`, `hephaestus`, `aglaia`, `daedalus`, `mnemosyne`) count as `dev`. (#588)
//
// A round is each Argos call (a `review` step) on the group. A change request is a round whose verdict, read from
// the last `Verdict: …` line of the reviewer's report (at ingest, from the full text; or `metadata.workflow.verdict`), is
// not `approve` (`request-changes` and `comment` both count);
// with no readable verdict the step counts as a round and never as a change request.

import { findingsOf, verdictOf, type ReviewVerdict } from '../ingest/history/verdict.ts';
import type { Agent, Session, SessionEvent } from '../model.ts';

export type LoopRole = 'dev' | 'review' | 'fix' | 'other';
export type LoopVerdict = ReviewVerdict;
export type LoopStepState = 'completed' | 'running' | 'error';
export const LOOP_GROUP_STATES = ['approved', 'in-review', 'waiting-fix', 'stopped', 'open'] as const;
export type LoopGroupState = (typeof LOOP_GROUP_STATES)[number];

export interface LoopStep {
  agentId: string;
  role: LoopRole;
  /** The subagent type, as the model gave it (`general-purpose`, `argos`, `erodos`). */
  agentType: string | null;
  task: string | null;
  state: LoopStepState;
  startedAt: string;
  endedAt: string | null;
  /** The agent that opened this step, as the session graph has it (#588). */
  parentAgentId: string | null;
  /** Only on `review` steps; `null` when the message has no readable verdict. */
  verdict: LoopVerdict | null;
  /** The findings a reviewer reported (`3 findings`, `3 achados`), when readable. */
  findings: number | null;
}

export interface LoopGroup {
  /** `pr:<n>`, `issue:<n>` or `none`. */
  id: string;
  kind: 'pr' | 'issue' | 'none';
  number: number | null;
  /** The issue the group's branch or task points to, when it is a PR group. */
  issue: number | null;
  /** PRs the tasks cite besides the group's. */
  otherRefs: number[];
  state: LoopGroupState;
  rounds: number;
  changeRequests: number;
  steps: LoopStep[];
  lastActivityAt: string;
}

/** The subagent that opens the layers of a story and leads their loops (#588). */
export interface LoopOrchestrator {
  agentId: string;
  agentType: string | null;
  task: string | null;
  state: LoopStepState;
  startedAt: string;
  endedAt: string | null;
  /** The agent that opened it: the main agent, or another orchestrator (#588). */
  parentAgentId: string | null;
  /** The ids of the groups it leads (`pr:<n>`, `issue:<n>`), most recent first (#588). */
  groups: string[];
}

export interface PrLoop {
  groups: LoopGroup[];
  orchestrators: LoopOrchestrator[];
  totals: { prs: number; rounds: number; changeRequests: number; subagents: number; stopped: number; layers: number };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

const PR_REF = /\bPRs?\s*#(\d{1,7})\b/gi;
const PR_URL = /\/pull\/(\d{1,7})\b/g;
const ISSUE_REF = /\b(?:issues?|refs?|closes?|fixes?)\s*#(\d{1,7})\b/gi;
const BARE_REF = /(?<![\w/&])#(\d{1,7})\b/g;
const ORCHESTRATOR_TYPE = /(^|:)athena$/;
// The agency's builders and writers: no `workflow.role` is written for them at ingest, so the type says `dev` (#588).
const BUILD_TYPE = /(^|:)(apollo|iris|clio|hephaestus|aglaia|daedalus|mnemosyne)$/;
const BRANCH_ISSUE = /(?:^|\/)(\d{1,7})-/;

const nums = (text: string, re: RegExp): number[] => [...text.matchAll(re)].map((m) => Number(m[1]));
const unique = (xs: number[]) => [...new Set(xs)];

/** The text a subagent's link is read from: its name and its task. */
const textOf = (a: Agent) => [a.name, a.task].filter(Boolean).join('\n');
const branchOf = (a: Agent): string | null => str(obj(a.metadata?.workflow)?.branch) ?? str(a.metadata?.branch);

export interface TextRefs {
  /** PRs written as `PR #N` or as a PR URL, in the order they appear. */
  prs: number[];
  /** Issues written as `issue #N`, `Refs #N`, `Closes #N`. */
  issues: number[];
  /** A bare `#N`: a PR or an issue, decided with what the rest of the session says. */
  bare: number[];
}

export function refsOf(text: string): TextRefs {
  const hits = [...text.matchAll(PR_REF), ...text.matchAll(PR_URL)].sort((a, b) => a.index! - b.index!).map((m) => Number(m[1]));
  const issues = nums(text, ISSUE_REF);
  const bare = nums(text, BARE_REF).filter((n) => !hits.includes(n) && !issues.includes(n));
  return { prs: unique(hits), issues: unique(issues), bare: unique(bare) };
}

export { verdictOf };

const stateOf = (a: Agent): LoopStepState => (a.status === 'error' ? 'error' : a.status === 'completed' ? 'completed' : 'running');

const byStart = (a: Agent, b: Agent) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);

/** A subagent's role in the loop; `roleOf` is the session graph's `papelDe`, so both views agree. */
export function loopRoleOf(role: string): LoopRole {
  if (role === 'dev' || role === 'review' || role === 'fix') return role;
  return 'other';
}

/** The loop role of a subagent: the session graph's role, and `dev` for an agency build agent that has none (#588). */
function roleInLoop(a: Agent, roleOf: (a: Agent) => string): LoopRole {
  const role = loopRoleOf(roleOf(a));
  return role === 'other' && BUILD_TYPE.test(a.subagentType ?? '') ? 'dev' : role;
}

interface Linked {
  agent: Agent;
  role: LoopRole;
  pr: number | null;
  issue: number | null;
  otherRefs: number[];
  branch: string | null;
}

export function buildPrLoop(session: Session, agents: readonly Agent[], events: readonly SessionEvent[], roleOf: (a: Agent) => string): PrLoop {
  const subs = agents.filter((a) => a.type === 'subagent').sort(byStart);
  const refs = new Map(subs.map((a) => [a.id, refsOf(textOf(a))]));
  // A bare `#N` is a PR when some subagent of the session wrote it as a PR.
  // An orchestrator (#586) cites PRs as references, not as its own work: they feed no PR for anyone.
  const parents = new Set(subs.map((a) => a.parentAgentId));
  // Only an `athena` type, or a parent whose loop role is `other`: a dev, review or fix agent that delegates keeps its PR. (#586)
  const isOrchestrator = (a: Agent) =>
    ORCHESTRATOR_TYPE.test(a.subagentType ?? '') || (parents.has(a.id) && roleInLoop(a, roleOf) === 'other');
  const explicitPrs = new Set(subs.filter((a) => !isOrchestrator(a)).flatMap((a) => refs.get(a.id)!.prs));

  const linked: Linked[] = subs.map((agent) => {
    const r = refs.get(agent.id)!;
    // An orchestrator has no PR of its own text: its bare refs are issues, its `PR #N` refs are dropped. (#586)
    const orchestrator = isOrchestrator(agent);
    const bareIsPr = orchestrator ? [] : r.bare.filter((n) => explicitPrs.has(n));
    const prs = orchestrator ? [] : unique([...r.prs, ...bareIsPr]);
    const issues = unique([...r.issues, ...r.bare.filter((n) => orchestrator || !explicitPrs.has(n))]);
    const branch = branchOf(agent);
    return { agent, role: roleInLoop(agent, roleOf), pr: prs[0] ?? null, issue: issues[0] ?? null, otherRefs: prs.slice(1), branch };
  });

  // Rule 2: the same branch as a subagent that has a PR.
  const prByBranch = new Map<string, number>();
  for (const l of linked) if (l.pr !== null && l.branch) prByBranch.set(l.branch, l.pr);
  for (const l of linked) if (l.pr === null && l.branch && prByBranch.has(l.branch)) l.pr = prByBranch.get(l.branch)!;

  // Rule 3: the issue a PR's branch points to folds the issue-only subagents into that PR.
  const prByIssue = new Map<number, number>();
  for (const l of linked) {
    const fromBranch = l.branch ? Number(BRANCH_ISSUE.exec(l.branch)?.[1]) : NaN;
    if (l.pr !== null && Number.isFinite(fromBranch)) prByIssue.set(fromBranch, l.pr);
    if (l.pr !== null && l.issue !== null) prByIssue.set(l.issue, l.pr);
  }
  for (const l of linked) if (l.pr === null && l.issue !== null && prByIssue.has(l.issue)) l.pr = prByIssue.get(l.issue)!;

  // What a reviewer's last message says: the verdict and the findings the ingest read from the full text, or, for
  // an event stored before that, from the (cut) summary.
  const said = new Map<string, { verdict: LoopVerdict | null; findings: number | null }>();
  for (const e of events) {
    if (e.type !== 'AssistantMessage' || !e.agentId) continue;
    const d = obj(e.data);
    const text = e.summary ?? '';
    const verdict = (str(d?.verdict) as LoopVerdict | null) ?? verdictOf(text);
    const findings = typeof d?.findings === 'number' ? d.findings : findingsOf(text);
    const prev = said.get(e.agentId);
    said.set(e.agentId, { verdict: verdict ?? prev?.verdict ?? null, findings: findings ?? prev?.findings ?? null });
  }

  const toStep = (l: Linked): LoopStep => {
    const a = l.agent;
    const heard = said.get(a.id);
    const metaVerdict = str(obj(a.metadata?.workflow)?.verdict);
    const verdict = l.role === 'review' ? (metaVerdict ? verdictOf(`Verdict: ${metaVerdict}`) : (heard?.verdict ?? null)) : null;
    return {
      agentId: a.id,
      role: l.role,
      agentType: a.subagentType,
      task: a.name ?? a.task,
      state: stateOf(a),
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      parentAgentId: a.parentAgentId,
      verdict,
      findings: l.role === 'review' ? (heard?.findings ?? null) : null,
    };
  };

  const buckets = new Map<string, { kind: LoopGroup['kind']; number: number | null; items: Linked[] }>();
  // An orchestrator is the parent of the loops, not a step in one (#588).
  for (const l of linked.filter((x) => !isOrchestrator(x.agent))) {
    const [id, kind, number] = l.pr !== null ? [`pr:${l.pr}`, 'pr' as const, l.pr] : l.issue !== null ? [`issue:${l.issue}`, 'issue' as const, l.issue] : ['none', 'none' as const, null];
    const b = buckets.get(id) ?? { kind, number, items: [] };
    b.items.push(l);
    buckets.set(id, b);
  }

  const sessionLive = session.status === 'active';
  const groups: LoopGroup[] = [...buckets].map(([id, b]) => {
    const steps = b.items.map(toStep);
    const reviews = steps.filter((s) => s.role === 'review');
    const lastReview = reviews.at(-1) ?? null;
    // The steps are in start order, so what came after the last review is what follows it in the list.
    const after = lastReview ? steps.slice(steps.indexOf(lastReview) + 1) : [];
    let state: LoopGroupState = 'open';
    if (lastReview) {
      if (lastReview.state === 'running' || after.some((s) => s.state === 'running')) state = 'in-review';
      else if (lastReview.verdict === 'approve') state = 'approved';
      else if (lastReview.verdict !== null && after.length === 0) state = sessionLive ? 'waiting-fix' : 'stopped';
      else state = sessionLive ? 'in-review' : 'open';
    }
    const issues = b.items.map((i) => i.issue).filter((n): n is number => n !== null);
    const branchIssues = b.items.map((i) => (i.branch ? Number(BRANCH_ISSUE.exec(i.branch)?.[1]) : NaN)).filter(Number.isFinite);
    const lastActivity = steps.reduce((m, s) => ((s.endedAt ?? s.startedAt) > m ? (s.endedAt ?? s.startedAt) : m), '');
    return {
      id,
      kind: b.kind,
      number: b.number,
      issue: b.kind === 'pr' ? (issues[0] ?? branchIssues[0] ?? null) : null,
      otherRefs: unique(b.items.flatMap((i) => i.otherRefs)),
      state: b.kind === 'none' ? 'open' : state,
      rounds: b.kind === 'none' ? 0 : reviews.length,
      changeRequests: b.kind === 'none' ? 0 : reviews.filter((s) => s.verdict !== null && s.verdict !== 'approve').length,
      steps,
      lastActivityAt: lastActivity,
    };
  });

  // The most recent first, "none" always last.
  groups.sort((a, b) => (a.kind === 'none' ? 1 : b.kind === 'none' ? -1 : b.lastActivityAt.localeCompare(a.lastActivityAt)));
  const orchestrators: LoopOrchestrator[] = subs.filter(isOrchestrator).map((a) => ({
    agentId: a.id,
    agentType: a.subagentType,
    task: a.name ?? a.task,
    state: stateOf(a),
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    parentAgentId: a.parentAgentId,
    groups: groups.filter((g) => g.kind !== 'none' && g.steps[0]?.parentAgentId === a.id).map((g) => g.id),
  }));
  const withPr = groups.filter((g) => g.kind !== 'none');
  return {
    groups,
    orchestrators,
    totals: {
      prs: groups.filter((g) => g.kind === 'pr').length,
      rounds: withPr.reduce((t, g) => t + g.rounds, 0),
      changeRequests: withPr.reduce((t, g) => t + g.changeRequests, 0),
      subagents: subs.length,
      stopped: groups.filter((g) => g.state === 'stopped').length,
      layers: orchestrators.reduce((t, o) => t + o.groups.length, 0),
    },
  };
}
