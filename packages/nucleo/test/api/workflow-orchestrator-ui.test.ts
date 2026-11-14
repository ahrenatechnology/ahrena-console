// End-to-end skeleton of the orchestrator as parent of the per-PR loops (#587, parent #509); wireframe 587-1 to 587-5
// in docs/wireframes/index.html, approved by the design owner on 2026-11-14. It drives `buildPrLoop` (the data, #588) and
// `loopPanel` (the screen, #589) through the fake DOM and asserts what the person reads. Every scenario is a `todo`
// until #589 turns it green; the assertions are the finished behaviour, not the placeholders of the wireframe.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPrLoop } from '../../src/api/workflow-loop.ts';
import { papelDe } from '../../src/api/workflows.ts';
import type { Agent, SessionEvent } from '../../src/model.ts';
import { agent, at, event, session } from '../fixtures.ts';
import { instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// @ts-expect-error: browser module, plain JavaScript
const { loopPanel } = await import('../../ui/screens/workflow-loop.js');

const TODO = { todo: 'issue 589: the Workflow tab draws the orchestrator as parent of the per-PR loops' };

const main = agent({ id: 's1:main', sessionId: 's1', type: 'main', name: null });
function sub(id: string, type: string, start: number, end: number | null, task: string, parent: string, over: Partial<Agent> = {}): Agent {
  return agent({
    id: `s1:${id}`, sessionId: 's1', type: 'subagent', subagentType: type, name: task, task, parentAgentId: parent,
    status: end === null ? 'working' : 'completed', startedAt: at(start), endedAt: end === null ? null : at(end), ...over,
  });
}
const said = (a: Agent, summary: string, minute: number): SessionEvent =>
  event({ id: `m-${a.id}-${minute}`, agentId: a.id, type: 'AssistantMessage', toolName: null, summary, createdAt: at(minute) });

const ATHENA_TYPE = 'ahrena-engineering-development:athena';
// The orchestrator's own brief names no PR and no issue, so today it lands in the "no PR" group (#509).
const athena = sub('athena', ATHENA_TYPE, 1, null, 'Run the layers of the story', main.id);
// Layer 1: an issue, no PR yet. Layer 2: PR 710, second round (the most recent one) (#587).
const apollo702 = sub('apollo702', 'ahrena-engineering-backend:apollo', 2, null, 'Build layer 1 for issue #702', athena.id);
const dev710 = sub('dev710', 'ahrena-engineering-frontend:iris', 5, 9, 'Build layer 2 for PR #710', athena.id);
const argos1 = sub('argos1', 'ahrena-engineering-code-review:argos', 10, 14, 'Review PR #710', athena.id);
const erodos = sub('erodos', 'ahrena-engineering-quality:erodos', 15, 19, 'Fix PR #710', athena.id);
const argos2 = sub('argos2', 'ahrena-engineering-code-review:argos', 20, null, 'Review PR #710', athena.id);
const tree = [main, athena, apollo702, dev710, argos1, erodos, argos2];
const treeEvents = [said(argos1, '3 findings\nVerdict: request-changes', 14)];

const loopOf = (agents: Agent[], events: SessionEvent[] = []) => buildPrLoop(session({ id: 's1', status: 'active' }), agents, events, papelDe);
const panelText = (loop: unknown) => texto(loopPanel({ sessionId: 's1', loop: JSON.parse(JSON.stringify(loop)) }, null));
const at1 = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `"${needle}" is not on the screen: ${text}`);
  return i;
};

describe('the orchestrator as parent of the per-PR loops (issue 509)', () => {
  test('the Athena row comes before her groups', TODO, () => {
    const text = panelText(loopOf(tree, treeEvents));
    assert.match(text, /abriu 2 camadas · 1 PR/);
    assert.ok(at1(text, 'Athena') < at1(text, 'PR #710'));
    assert.ok(at1(text, 'Athena') < at1(text, 'Issue #702'));
    assert.doesNotMatch(text, /Sem PR(?! ainda)/, 'the orchestrator takes no "no PR" group of its own');
  });

  test('the layers are listed most recent first', TODO, () => {
    const text = panelText(loopOf(tree, treeEvents));
    assert.ok(at1(text, 'Athena') < at1(text, 'PR #710'), 'the layers sit under the orchestrator');
    assert.ok(at1(text, 'PR #710') < at1(text, 'Issue #702'));
  });

  test('no layer carries a "Camada N" label', TODO, () => {
    const text = panelText(loopOf(tree, treeEvents));
    assert.match(text, /abriu 2 camadas/, 'the screen draws the orchestrator, so this is not vacuous');
    assert.doesNotMatch(text, /Camada \d/);
  });

  test('the counts: Subagentes 6, Rodadas 2, Pedidos de mudança 1, PRs 1; the orchestrator is not a round', TODO, () => {
    const loop = loopOf(tree, treeEvents) as unknown as { totals: Record<string, number>; orchestrators: Array<{ agentId: string }> };
    assert.deepEqual(loop.orchestrators.map((o) => o.agentId), [athena.id]);
    assert.equal(loop.totals.layers, 2);
    const text = panelText(loop);
    assert.match(text, /PRs 1/);
    assert.match(text, /Rodadas de revisão 2/);
    assert.match(text, /Pedidos de mudança 1/);
    assert.match(text, /Subagentes 6/);
  });

  test('the Athena still planning takes no group from the PR her brief cites', TODO, () => {
    const planning = sub('athena', ATHENA_TYPE, 1, null, 'Plan the story; see PR #690 for reference', main.id);
    const loop = loopOf([main, planning]) as unknown as { groups: unknown[]; orchestrators: Array<{ agentId: string }> };
    assert.deepEqual(loop.orchestrators.map((o) => o.agentId), [planning.id]);
    assert.equal(loop.groups.length, 0);
    const text = panelText(loop);
    assert.match(text, /ainda não abriu nenhuma camada/);
    assert.doesNotMatch(text, /PR #690/);
    assert.match(text, /Subagentes 1/);
  });

  test('a delegating dev stays in its PR group and is not an orchestrator', TODO, () => {
    const dev = sub('dev', 'ahrena-engineering-backend:apollo', 2, 9, 'Build layer for PR #710', main.id);
    const helper = sub('helper', 'Explore', 3, 4, 'Read the files of PR #710', dev.id);
    const loop = loopOf([main, dev, helper]) as unknown as { groups: Array<{ id: string; steps: Array<{ agentId: string }> }>; orchestrators: unknown[] };
    assert.deepEqual(loop.orchestrators, []);
    assert.deepEqual(loop.groups.find((g) => g.id === 'pr:710')?.steps.map((s) => s.agentId), [dev.id, helper.id]);
    assert.doesNotMatch(panelText(loop), /abriu \d+ camadas?/);
  });

  test('a workflow with no orchestrator renders as before', TODO, () => {
    const dev = sub('dev', 'ahrena-engineering-backend:apollo', 2, 9, 'Build layer for PR #710', main.id);
    const argos = sub('argos', 'ahrena-engineering-code-review:argos', 10, 14, 'Review PR #710', main.id);
    const loop = loopOf([main, dev, argos], [said(argos, 'Verdict: approve', 14)]) as unknown as { orchestrators: unknown[] };
    assert.deepEqual(loop.orchestrators, [], 'the field exists and is empty');
    const text = panelText(loop);
    assert.match(text, /PR #710/);
    assert.match(text, /Aprovado/);
    assert.doesNotMatch(text, /abriu \d+ camadas?|ainda não abriu/);
  });
});
