// #332: the dev → Argos → Erodos → Argos loop grouped by PR, as pure functions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPrLoop, refsOf, verdictOf } from '../../src/api/workflow-loop.ts';
import { papelDe, workflowDaSessao } from '../../src/api/workflows.ts';
import type { Agent, SessionEvent } from '../../src/model.ts';
import { agent, at, event, session } from '../fixtures.ts';

const main = agent({ id: 's1:main', sessionId: 's1', type: 'main', name: null });
function sub(id: string, type: string, start: number, end: number | null, task: string, over: Partial<Agent> = {}): Agent {
  return agent({
    id: `s1:${id}`, sessionId: 's1', type: 'subagent', subagentType: type, name: task, task, parentAgentId: 's1:main',
    status: end === null ? 'working' : 'completed', startedAt: at(start), endedAt: end === null ? null : at(end), ...over,
  });
}
const said = (a: Agent, summary: string, minute: number): SessionEvent =>
  event({ id: `m-${a.id}-${minute}`, agentId: a.id, type: 'AssistantMessage', toolName: null, summary, createdAt: at(minute) });

describe('what a task points to', () => {
  test('reads PR #N, the PR URL, issue keywords and a bare #N apart', () => {
    assert.deepEqual(refsOf('Review PR #320 please'), { prs: [320], issues: [], bare: [] });
    assert.deepEqual(refsOf('see https://github.com/a/b/pull/12'), { prs: [12], issues: [], bare: [] });
    assert.deepEqual(refsOf('Build #277 and Refs #278'), { prs: [], issues: [278], bare: [277] });
    assert.deepEqual(refsOf('no reference here'), { prs: [], issues: [], bare: [] });
  });

  test('the verdict is the last Verdict line, and no line means no verdict', () => {
    assert.equal(verdictOf('Verdict: request-changes\nfixed\nVerdict: approve'), 'approve');
    assert.equal(verdictOf('**Verdict: request changes**'), 'request-changes');
    assert.equal(verdictOf('looks fine to me'), null);
  });
});

describe('the loop of a session, grouped by PR', () => {
  // The issue's scenario: dev, Argos (changes), Erodos, Argos (approve) on #320; one dev and one Argos approve
  // on #310; an Explore that cites nothing.
  const dev320 = sub('d320', 'general-purpose', 0, 10, 'Build #320');
  const argos1 = sub('a320a', 'ahrena-engineering-quality:argos', 10, 14, 'Review PR #320');
  const erodos = sub('e320', 'ahrena-engineering-quality:erodos', 14, 20, 'Fix the findings of PR #320');
  const argos2 = sub('a320b', 'ahrena-engineering-quality:argos', 20, 23, 'Review PR #320');
  const dev310 = sub('d310', 'general-purpose', 1, 8, 'Build PR #310');
  const argos310 = sub('a310', 'argos', 9, 12, 'Review PR #310');
  const explore = sub('ex', 'Explore', 2, 3, 'where does the tunnel drop');
  const agents = [main, dev320, argos1, erodos, argos2, dev310, argos310, explore];
  const events = [said(argos1, '3 findings\nVerdict: request-changes', 14), said(argos2, 'Verdict: approve', 23), said(argos310, 'Verdict: approve', 12)];
  const loop = buildPrLoop(session({ id: 's1', status: 'completed' }), agents, events, papelDe);

  test('groups by PR with the steps in start order and the rounds counted', () => {
    const g = loop.groups.find((x) => x.id === 'pr:320')!;
    assert.deepEqual(g.steps.map((s) => s.role), ['dev', 'review', 'fix', 'review']);
    assert.equal(g.rounds, 2);
    assert.equal(g.changeRequests, 1);
    assert.equal(g.steps[1].findings, 3);
    assert.equal(g.state, 'approved');
  });

  test('a PR approved at once has one round and no change request', () => {
    const g = loop.groups.find((x) => x.id === 'pr:310')!;
    assert.deepEqual([g.rounds, g.changeRequests, g.state], [1, 0, 'approved']);
  });

  test('a subagent with no PR and no issue goes to "none", last, with no state of its own', () => {
    assert.equal(loop.groups.at(-1)!.id, 'none');
    assert.deepEqual(loop.groups.at(-1)!.steps.map((s) => s.agentId), ['s1:ex']);
    assert.deepEqual(loop.totals, { prs: 2, rounds: 3, changeRequests: 1, subagents: 7, stopped: 0 });
  });

  test('the session graph now knows Argos and Erodos by role', () => {
    assert.equal(papelDe(argos1), 'review');
    assert.equal(papelDe(erodos), 'fix');
    const graph = workflowDaSessao(session({ id: 's1', status: 'completed' }), agents, events, { agora: Date.parse(at(30)) });
    assert.equal(graph.loop.groups.length, 3);
  });
});

describe('the state of a group', () => {
  const dev = sub('d', 'general-purpose', 0, 5, 'Build PR #1');
  const asked = (end: number | null) => sub('a', 'argos', 5, end, 'Review PR #1');
  const state = (agents: Agent[], events: SessionEvent[], status: 'active' | 'completed') =>
    buildPrLoop(session({ id: 's1', status }), [main, ...agents], events, papelDe).groups[0].state;

  test('a change request nobody answered waits while the session is live and stops when it ended', () => {
    const argos = asked(8);
    const ev = [said(argos, 'Verdict: request-changes', 8)];
    assert.equal(state([dev, argos], ev, 'active'), 'waiting-fix');
    assert.equal(state([dev, argos], ev, 'completed'), 'stopped');
  });

  test('a running review is in review; a dev alone is open; a reply without a verdict is a round, not a request', () => {
    assert.equal(state([dev, asked(null)], [], 'active'), 'in-review');
    assert.equal(state([dev], [], 'active'), 'open');
    const argos = asked(8);
    const g = buildPrLoop(session({ id: 's1', status: 'completed' }), [main, dev, argos], [said(argos, 'looks good', 8)], papelDe).groups[0];
    assert.deepEqual([g.rounds, g.changeRequests], [1, 0]);
  });
});

describe('where the PR link comes from besides the task', () => {
  test('a bare #N becomes the PR when another subagent wrote it as PR #N', () => {
    const a = sub('a', 'general-purpose', 0, 5, 'Build #7');
    const b = sub('b', 'argos', 5, 8, 'Review PR #7');
    const loop = buildPrLoop(session({ id: 's1', status: 'completed' }), [main, a, b], [], papelDe);
    assert.deepEqual(loop.groups.map((g) => g.id), ['pr:7']);
  });

  test('a bare #N nobody wrote as a PR is an issue group, tied to no PR', () => {
    const a = sub('a', 'general-purpose', 0, 5, 'Build #333');
    const loop = buildPrLoop(session({ id: 's1', status: 'completed' }), [main, a], [], papelDe);
    assert.deepEqual(loop.groups.map((g) => [g.id, g.kind, g.state]), [['issue:333', 'issue', 'open']]);
  });

  test('the same branch joins a subagent that cites nothing to the PR of its branch, and the branch carries the issue', () => {
    const a = sub('a', 'general-purpose', 0, 5, 'Build the page', { metadata: { branch: 'feat/333-workflows' } });
    const b = sub('b', 'argos', 5, 8, 'Review PR #345', { metadata: { branch: 'feat/333-workflows' } });
    const c = sub('c', 'general-purpose', 9, 10, 'Refs #333 follow up');
    const loop = buildPrLoop(session({ id: 's1', status: 'completed' }), [main, a, b, c], [], papelDe);
    assert.deepEqual(loop.groups.map((g) => [g.id, g.steps.length, g.issue]), [['pr:345', 3, 333]]);
  });

  test('a task that cites two PRs stays in the first and keeps the other as a chip', () => {
    const a = sub('a', 'argos', 0, 4, 'Review PR #5 against PR #6');
    const loop = buildPrLoop(session({ id: 's1', status: 'completed' }), [main, a], [], papelDe);
    assert.deepEqual([loop.groups[0].id, loop.groups[0].otherRefs], ['pr:5', [6]]);
  });
});

describe('review verdicts as the ingest keeps them (#332, review round 1)', () => {
  const dev = sub('d', 'general-purpose', 0, 5, 'Build PR #1');
  const reviewed = (events: SessionEvent[], over: Partial<Agent> = {}, status: 'active' | 'completed' = 'completed') => {
    const argos = sub('a', 'argos', 5, 8, 'Review PR #1', over);
    return buildPrLoop(session({ id: 's1', status }), [main, dev, argos], events(argos), papelDe).groups[0];
  };

  test('a verdict past the 200 characters of the summary is read from the event data', () => {
    const long = 'x'.repeat(300);
    const g = reviewed((a) => [event({ id: 'l', agentId: a.id, type: 'AssistantMessage', toolName: null, summary: `${long.slice(0, 200)}…`, data: { verdict: 'request-changes', findings: 4 }, createdAt: at(8) })]);
    assert.deepEqual([g.changeRequests, g.state, g.steps[1].findings], [1, 'stopped', 4]);
  });

  test('the ingest reads the verdict and the findings from the full text of a long report', async () => {
    const { parseLine } = await import('../../src/ingest/history/transcript.ts');
    const text = `${'detail '.repeat(80)}\n4 findings\nVerdict: request-changes`;
    const line = JSON.stringify({ type: 'assistant', uuid: 'u1', sessionId: 's1', timestamp: '2026-11-02T12:00:00.000Z', message: { id: 'm1', content: [{ type: 'text', text }] } });
    const ev = parseLine(line, new Map())!.events[0];
    assert.deepEqual([ev.summary!.length <= 201, (ev.data as any).verdict, (ev.data as any).findings], [true, 'request-changes', 4]);
  });

  test('a readable "comment" verdict counts as a change request; the metadata verdict wins over the text', () => {
    const comment = reviewed((a) => [said(a, 'Verdict: comment', 8)]);
    assert.deepEqual([comment.changeRequests, comment.state], [1, 'stopped']);
    const meta = reviewed((a) => [said(a, 'Verdict: request-changes', 8)], { metadata: { workflow: { verdict: 'approve' } } });
    assert.deepEqual([meta.changeRequests, meta.state], [0, 'approved']);
  });

  test('a review that errored is a round with no verdict; approval holds when something starts after it; the issue comes from the branch', () => {
    const errored = reviewed(() => [], { status: 'error' });
    assert.deepEqual([errored.rounds, errored.changeRequests, errored.steps[1].state], [1, 0, 'error']);
    const argos = sub('a', 'argos', 5, 8, 'Review PR #1', { metadata: { branch: 'feat/333-x' } });
    const later = sub('l', 'Explore', 9, 10, 'Refs nothing');
    const loop = buildPrLoop(session({ id: 's1', status: 'completed' }), [main, dev, argos, later], [said(argos, 'Verdict: approve', 8)], papelDe);
    assert.deepEqual([loop.groups.find((g) => g.id === 'pr:1')!.state, loop.groups.find((g) => g.id === 'pr:1')!.issue], ['approved', 333]);
  });
});
