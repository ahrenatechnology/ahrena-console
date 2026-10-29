// issue 332: the pure parts of the loop by PR (C81, C82) and of the tree between sessions (C83).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: browser modules, in plain JavaScript
import { groupTitle, roundsText, stepName, stepResult, stepTone, stepsWithLinks, linkBetween, loopSummary } from '../../ui/screens/workflow-loop.js';
// @ts-expect-error: idem
import { treeKpis, nodeMeta, descendants, initialOpen, statusOf } from '../../ui/screens/workflow-tree.js';

const step = (role: string, over: Record<string, unknown> = {}) => ({ agentId: `a-${role}`, role, agentType: null, task: 't', state: 'completed', startedAt: '2026-10-29T10:00:00Z', endedAt: '2026-10-29T10:05:00Z', verdict: null, findings: null, ...over });

describe('the loop by PR on the screen', () => {
  test('titles and counters: PR, issue, no PR; singular and plural', () => {
    assert.equal(groupTitle({ kind: 'pr', number: 320 }), 'PR #320');
    assert.equal(groupTitle({ kind: 'issue', number: 333 }), 'Issue #333');
    assert.equal(groupTitle({ kind: 'none', number: null }), 'Sem PR');
    assert.equal(roundsText({ kind: 'pr', rounds: 2, changeRequests: 1 }), '2 rodadas · 1 pedido de mudança');
    assert.equal(roundsText({ kind: 'pr', rounds: 1, changeRequests: 0 }), '1 rodada · 0 pedidos de mudança');
    assert.equal(roundsText({ kind: 'none', rounds: 0, changeRequests: 0 }), 'ligados ao Principal');
  });

  test('step names and results: Argos, Erodos, dev, with the verdict and the findings', () => {
    assert.equal(stepName(step('review', { agentType: 'ahrena-engineering-quality:argos' })), 'Argos');
    assert.equal(stepName(step('fix', { agentType: 'erodos' })), 'Erodos');
    assert.equal(stepName(step('dev', { agentType: 'general-purpose' })), 'dev');
    assert.equal(stepName(step('other', { agentType: 'Explore' })), 'Explore');
    assert.equal(stepResult(step('review', { verdict: 'request-changes', findings: 3 })), 'Pediu mudanças · 3 achados');
    assert.equal(stepResult(step('review', { verdict: 'approve' })), 'Aprovou');
    assert.equal(stepResult(step('review', { state: 'running' })), 'Revisando');
    assert.equal(stepResult(step('dev')), 'Concluído');
    assert.deepEqual([stepTone(step('review', { verdict: 'comment' })), stepTone(step('review', { verdict: 'approve' })), stepTone(step('dev', { state: 'running' }))], ['changes', 'ok', 'run']);
  });

  test('the links: the dashed one leaves a change request, "rodada N" enters a later review', () => {
    const dev = step('dev');
    const first = step('review', { verdict: 'request-changes', findings: 3 });
    const fix = step('fix');
    const second = step('review', { verdict: 'approve' });
    const linked = stepsWithLinks([dev, first, fix, second]);
    assert.equal(linked[0].link, null);
    assert.deepEqual(linked[1].link, { kind: 'plain', label: 'PR aberto' });
    assert.deepEqual(linked[2].link, { kind: 'changes', label: '3 achados' });
    assert.deepEqual(linked[3].link, { kind: 'plain', label: 'rodada 2' });
    assert.deepEqual(linkBetween(first, step('dev'), 1), { kind: 'changes', label: '3 achados' });
  });

  test('the totals line', () => {
    assert.deepEqual(loopSummary({ totals: { prs: 4, rounds: 5, changeRequests: 2, subagents: 15, stopped: 0 } }, 15), [['PRs', 4], ['Rodadas de revisão', 5], ['Pedidos de mudança', 2], ['Subagentes', 15]]);
  });
});

describe('the tree between sessions on the screen', () => {
  const node = (id: string, children: unknown[] = [], over: Record<string, unknown> = {}) => ({ sessionId: id, name: id, status: 'completed', kind: 'root', children, loop: null, ...over });
  const totals = { prs: 4, rounds: 5, changeRequests: 2, subagents: 15, stopped: 1 };

  test('the KPIs: trees, PRs, rounds per PR, approved share, stopped loops, sessions', () => {
    const d = { sessions: 1286, trees: { total: 3 }, loopKpis: { prs: 28, rounds: 48, changeRequests: 10, approved: 23, stopped: 1, roundsPerPr: 1.7 } };
    assert.deepEqual(treeKpis(d).map((k: any) => [k.id, k.value]), [['trees', '3'], ['prs', '28'], ['rounds', '1,7'], ['approved', '82%'], ['stopped', '1'], ['sessions', '1.286']]);
    assert.equal(treeKpis({ ...d, loopKpis: { ...d.loopKpis, prs: 0, approved: 0, stopped: 0, roundsPerPr: null } })[3].value, '—');
  });

  test('the line of a node and the open levels', () => {
    assert.equal(nodeMeta(node('x', [], { loop: totals })), '15 subagentes · 4 PRs · 5 rodadas · 2 pedidos de mudança');
    assert.equal(nodeMeta(node('x')), null);
    const tree = node('pm', [node('tl', [node('cloud', [node('kid')])])]);
    assert.equal(descendants(tree), 3);
    assert.deepEqual([...initialOpen([{ root: tree }])].sort(), ['cloud', 'pm', 'tl']);
    assert.deepEqual(statusOf('active'), ['Ativa', 'active']);
  });
});
