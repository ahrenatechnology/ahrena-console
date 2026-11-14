// The components of the agent view (#538, layer 2 of 521), rendered from data in the shape of the
// agent-view contract (#529): no read, no core. One group per component and per drawn state.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

// @ts-expect-error: browser module, plain JavaScript
const format = await import('../../ui/screens/agent-view-format.js');
// @ts-expect-error: browser module, plain JavaScript
const view = await import('../../ui/screens/agent-view.js');

const SID = 'c3f09b52-4e10';
const IRIS = 'a1b2:iris'; // an agent id may carry a ":" (the route carries it encoded) (#529)
const NOW = Date.parse('2026-11-01T10:30:00.000Z');
const at = (min: number, sec = 0) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + min * 60_000 + sec * 1000).toISOString();

const step = (i: number, extra = {}) => ({ id: `toolu_${i}`, kind: 'tool', name: 'Read', summary: `file ${i}`, state: 'ok', start: at(0, i), end: at(0, i + 1), childAgentId: null, ...extra });
const childStep = (extra = {}) => ({ id: 'toolu_A', kind: 'agent', name: 'Agent', summary: 'Check the table', state: 'ok', start: at(1), end: at(7), childAgentId: IRIS, ...extra });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

const agent = (extra: Record<string, unknown> = {}) => ({
  agentId: 'a1b2', agentType: 'ahrena-engineering-development:athena', description: 'plans the issue', brief: 'Plan issue 521.', briefTruncated: false,
  spawnedByToolUseId: 'toolu_T1', steps: [step(1), childStep(), step(3)], result: 'Layers ordered.', resultTruncated: false,
  costUsd: 0.41, costNote: null, totalCostUsd: 0.9, state: 'completed', start: at(0), end: at(20), ...extra,
});
const draw = (data: unknown, opts: Record<string, unknown> = {}) => view.agentView(data, { sessionId: SID, now: NOW, ...opts }) as ElementoFalso;
const stepsOf = (root: ElementoFalso) => root.querySelectorAll('.av-step');
const fileOf = (s: ElementoFalso) => /file (\d+)/.exec(texto(s))?.[1];

describe('the format, with no DOM', () => {
  test('the agent view address carries the agent id encoded, and drops the session prefix of a listed id', () => {
    assert.equal(format.agentViewHref(SID, IRIS), `/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
    assert.equal(format.agentRouteId(SID, `${SID}:a1b2`), 'a1b2');
    assert.equal(format.agentRouteId(SID, 'a1b2'), 'a1b2');
    assert.equal(format.agentRouteId(SID, `${SID}:main`), 'main');
  });

  test('the indent of a row is its distance from the main agent along `parent`', () => {
    const rows = [{ id: 'main', type: 'main', parent: null }, { id: 'a', type: 'subagent', parent: 'main' }, { id: 'b', type: 'subagent', parent: 'a' }, { id: 'c', type: 'subagent', parent: 'zzz' }];
    assert.deepEqual(format.agentDepths(rows), { main: 0, a: 1, b: 2, c: 1 });
  });

  test('a parent loop does not hang the depth', () => {
    const rows = [{ id: 'x', type: 'subagent', parent: 'y' }, { id: 'y', type: 'subagent', parent: 'x' }];
    const depths = format.agentDepths(rows);
    assert.ok(Number.isInteger(depths.x) && Number.isInteger(depths.y));
  });

  test('cost: a number is "~US$ n", and absent is "—" with the reason, never zero', () => {
    assert.equal(format.costText(0.41, null), '~US$ 0,41');
    assert.equal(format.costText(0, null), '~US$ 0,00');
    assert.equal(format.costText(null, 'no_usage'), '—');
    assert.equal(format.costNoteText('no_usage'), 'sem custo medido');
    assert.equal(format.costNoteText('unpriced'), 'uso sem preço na tabela');
    assert.equal(format.costNoteText(null), null);
  });

  test('a fold keeps 6 lines and says how many characters the rest has', () => {
    assert.equal(format.foldText(lines(6), 6).folded, false);
    const f = format.foldText(lines(10), 6);
    assert.equal(f.folded, true);
    assert.equal(f.shown, lines(6));
    assert.equal(f.total, lines(10).length);
  });

  test('elision: up to 12 steps show all; above, the first 5 and the last 3, and a call to a child never hides', () => {
    const tools = Array.from({ length: 14 }, (_, i) => step(i + 1));
    assert.deepEqual(format.elide(tools.slice(0, 12)).map((p: { hidden?: unknown[] }) => p.hidden?.length ?? 0), Array(12).fill(0));
    const parts = format.elide(tools);
    assert.equal(parts.filter((p: { hidden?: unknown[] }) => p.hidden).length, 1);
    assert.equal(parts.find((p: { hidden?: unknown[] }) => p.hidden).hidden.length, 6);
    const withChild = tools.map((s, i) => (i === 7 ? childStep() : s));
    const kept = format.elide(withChild).filter((p: { step?: unknown }) => p.step).map((p: { step: { id: string } }) => p.step.id);
    assert.ok(kept.includes('toolu_A'), 'the child call stays visible');
    assert.equal(format.elide(withChild).filter((p: { hidden?: unknown[] }) => p.hidden).length, 2, 'two gaps around the child');
  });

  test('the state words, and the duration of a running agent says "até agora"', () => {
    assert.deepEqual(['working', 'waiting', 'completed', 'error'].map(format.stateLabel), ['Ativa', 'Esperando', 'Concluída', 'Com erro']);
    assert.deepEqual(format.durationText({ start: at(0), end: at(20), state: 'completed' }, NOW), { text: '20 min', partial: false });
    assert.deepEqual(format.durationText({ start: at(0), end: null, state: 'working' }, NOW), { text: '30 min', partial: true });
  });
});

describe('the header (AC-2)', () => {
  test('shows the short type with the full type apart, the description, the state, the duration and the own cost', () => {
    const root = draw(agent());
    assert.equal(texto(root.querySelector('.av-kind')), 'Athena');
    assert.equal(texto(root.querySelector('.av-kind-full')), 'ahrena-engineering-development:athena');
    assert.equal(texto(root.querySelector('.av-description')), 'plans the issue');
    assert.match(texto(root.querySelector('.av-state')), /Concluída/);
    assert.match(texto(root.querySelector('.av-duration')), /20 min/);
    assert.match(texto(root.querySelector('.av-cost')), /^Custo ~US\$ 0,41/);
  });

  test('the cost with the children comes after the own cost, only when it differs', () => {
    assert.match(texto(draw(agent()).querySelector('.av-cost')), /~US\$ 0,41.*com os filhos ~US\$ 0,90/);
    assert.doesNotMatch(texto(draw(agent({ totalCostUsd: 0.41 })).querySelector('.av-cost')), /com os filhos/);
  });

  test('no measured cost shows "—" and the reason, never US$ 0,00', () => {
    for (const [note, reason] of [['no_usage', 'sem custo medido'], ['unpriced', 'uso sem preço na tabela']]) {
      const cost = texto(draw(agent({ costUsd: null, costNote: note, totalCostUsd: null })).querySelector('.av-cost'));
      assert.match(cost, /^Custo —/);
      assert.ok(cost.includes(reason), reason);
      assert.doesNotMatch(cost, /US\$/);
    }
  });

  test('counts the tools and the subagents of the sequence', () => {
    const root = draw(agent());
    assert.match(texto(root.querySelector('.av-tools')), /2/);
    assert.match(texto(root.querySelector('.av-subagents')), /1/);
  });

  test('a main agent has no type and no description: the header does not invent them', () => {
    const root = draw(agent({ agentType: null, description: null }));
    assert.equal(root.querySelector('.av-kind-full'), null);
    assert.equal(root.querySelector('.av-description'), null);
    assert.ok(texto(root.querySelector('.av-kind')).length > 0, 'the agent still has a name');
  });

  test('offers the Conversa of this agent', () => {
    const open = draw(agent()).querySelector('a.av-conversation')!;
    assert.equal(open.getAttribute('href'), `/ui/sessions/${SID}?agent=${encodeURIComponent(`${SID}:a1b2`)}#conversation`);
  });

  test('the Conversa of the main agent asks for its full id, <sessionId>:main', () => {
    const open = draw(agent({ agentId: 'main', agentType: null })).querySelector('a.av-conversation')!;
    assert.equal(open.getAttribute('href'), `/ui/sessions/${SID}?agent=${encodeURIComponent(`${SID}:main`)}#conversation`);
  });
});

describe('the breadcrumb', () => {
  test('leads back to the session and its Agents tab, names the agents above, and the last part is not a link', () => {
    const root = draw(agent(), { sessionTitle: 'Separar pagamentos', trail: [{ label: 'athena', href: '/ui/sessions/x/agents/athena' }] });
    const crumb = root.querySelector('.av-crumb')!;
    const links = crumb.querySelectorAll('a');
    assert.deepEqual(links.map((a) => a.getAttribute('href')), [`/ui/sessions/${SID}`, `/ui/sessions/${SID}#agents`, '/ui/sessions/x/agents/athena']);
    assert.match(texto(crumb), /Separar pagamentos.*Agentes.*athena.*Athena/);
    assert.equal(crumb.querySelector('.av-crumb-current')!.tagName, 'SPAN');
    assert.equal(crumb.querySelector('.av-crumb-current')!.getAttribute('aria-current'), 'page');
  });
});

describe('the brief and the result (AC-2, AC-3)', () => {
  test('show their text with the line breaks kept', () => {
    const root = draw(agent({ brief: 'one\ntwo' }));
    assert.equal(root.querySelector('.av-brief .av-text')!.textContent, 'one\ntwo');
    assert.match(texto(root.querySelector('.av-result')), /Layers ordered\./);
  });

  test('fold at 6 lines and open on request, saying how long the whole text is', () => {
    const root = draw(agent({ brief: lines(10), result: lines(10) }));
    for (const sel of ['.av-brief', '.av-result']) {
      const box = root.querySelector(sel)!;
      assert.equal(box.getAttribute('data-folded'), 'true', `${sel} folded`);
      assert.ok(!texto(box).includes('line 7'), `${sel} shows 6 lines`);
      const more = box.querySelector('button.av-fold')!;
      assert.equal(more.getAttribute('aria-expanded'), 'false');
      assert.match(texto(more), new RegExp(`${lines(10).length} caracteres`));
      more.click();
      assert.ok(texto(root.querySelector(sel)).includes('line 10'), `${sel} opened`);
      assert.equal(root.querySelector(sel)!.getAttribute('data-folded'), 'false');
    }
  });

  test('6 lines or fewer have no fold', () => {
    const root = draw(agent({ brief: lines(6), result: lines(6) }));
    assert.equal(root.querySelector('.av-brief .av-fold'), null);
    assert.equal(root.querySelector('.av-result .av-fold'), null);
  });

  test('a text the core cut says so', () => {
    const root = draw(agent({ briefTruncated: true, resultTruncated: true }));
    assert.match(texto(root.querySelector('.av-brief')), /32\.000 primeiros caracteres/);
    assert.match(texto(root.querySelector('.av-result')), /32\.000 primeiros caracteres/);
  });

  test('text from the core goes in as text, never as markup', () => {
    const root = draw(agent({ brief: '<img src=x onerror=alert(1)>' }));
    assert.equal(root.querySelector('.av-brief .av-text')!.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(root.querySelector('img'), null);
  });
});

describe('the sequence of steps (AC-2)', () => {
  test('lists the steps in order, each with its name, target, offset and state', () => {
    const root = draw(agent({ steps: [step(1), step(2, { state: 'error' }), step(3, { state: 'unknown', end: null })] }));
    const rows = stepsOf(root);
    assert.deepEqual(rows.map(fileOf), ['1', '2', '3']);
    assert.match(texto(rows[0]!), /Read.*file 1.*OK/);
    assert.match(texto(rows[1]!), /Erro/);
    assert.equal(rows[1]!.getAttribute('data-state'), 'error');
    assert.equal(rows[2]!.getAttribute('data-state'), 'unknown');
  });

  test('the child agent sits in the call that spawned it, with its state and "Abrir a vista" as a link', () => {
    const rows = stepsOf(draw(agent()));
    assert.equal(rows.length, 3);
    const child = rows[1]!;
    assert.equal(child.getAttribute('data-kind'), 'agent');
    assert.match(texto(child), /Check the table/);
    assert.match(texto(child), /Concluída/);
    const open = child.querySelector('a.av-open-view')!;
    assert.match(texto(open), /Abrir a vista/);
    assert.equal(open.getAttribute('href'), `/ui/sessions/${SID}/agents/${encodeURIComponent(IRIS)}`);
    assert.match(open.getAttribute('aria-label') ?? '', /Abrir a vista de/);
  });

  test('a call to an agent that was not read has no link to follow', () => {
    const child = stepsOf(draw(agent({ steps: [childStep({ childAgentId: null })] })))[0]!;
    assert.equal(child.querySelector('a.av-open-view'), null);
  });

  test('a tool step opens its detail in line and closes it again, with no navigation', () => {
    const root = draw(agent({ steps: [step(1, { summary: 'a/very/long/path/to/file.ts' })] }));
    const first = stepsOf(root)[0]!;
    assert.equal(first.querySelector('.av-detail'), null);
    const toggle = first.querySelector('button.av-toggle')!;
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    const open = stepsOf(root)[0]!;
    assert.ok(open.querySelector('.av-detail'), 'the detail is inside the step');
    assert.match(texto(open.querySelector('.av-detail')), /a\/very\/long\/path\/to\/file\.ts/);
    assert.equal(open.querySelector('button.av-toggle')!.getAttribute('aria-expanded'), 'true');
    open.querySelector('button.av-toggle')!.click();
    assert.equal(stepsOf(root)[0]!.querySelector('.av-detail'), null);
  });

  test('above 12 steps the first 5 and the last 3 stay, the middle is elided and opens on request', () => {
    const root = draw(agent({ steps: Array.from({ length: 14 }, (_, i) => step(i + 1)) }));
    assert.deepEqual(stepsOf(root).map(fileOf), ['1', '2', '3', '4', '5', '12', '13', '14']);
    const gap = root.querySelector('.av-elided')!;
    assert.match(texto(gap), /6 passos escondidos/);
    gap.querySelector('button')!.click();
    assert.equal(stepsOf(root).length, 14);
    assert.equal(root.querySelector('.av-elided'), null);
  });

  test('12 steps are all shown', () => {
    const root = draw(agent({ steps: Array.from({ length: 12 }, (_, i) => step(i + 1)) }));
    assert.equal(stepsOf(root).length, 12);
    assert.equal(root.querySelector('.av-elided'), null);
  });

  test('a call to a child in the middle of a long sequence is never elided', () => {
    const steps = Array.from({ length: 14 }, (_, i) => (i === 7 ? childStep() : step(i + 1)));
    const root = draw(agent({ steps }));
    assert.ok(stepsOf(root).some((s) => s.getAttribute('data-kind') === 'agent'));
    assert.equal(root.querySelectorAll('.av-elided').length, 2);
  });

  test('the child opens in line, nested one level deeper, once its data is given', () => {
    const root = draw(agent());
    const child = stepsOf(root)[1]!;
    const toggle = child.querySelector('button.av-toggle')!;
    const asked: string[] = [];
    const withAsk = draw(agent(), { onOpenChild: (id: string) => asked.push(id) });
    withAsk.querySelectorAll('.av-step')[1]!.querySelector('button.av-toggle')!.click();
    assert.deepEqual(asked, [IRIS], 'asks for the child agent, the read is not here');
    assert.ok(withAsk.querySelector('.av-child-loading'), 'while the child has no data it says it is reading');

    toggle.click();
    root.setChild(IRIS, agent({ agentId: IRIS, steps: [step(1)] }));
    assert.deepEqual(stepsOf(root).map((s) => s.getAttribute('data-depth')), ['0', '0', '1', '0']);
    stepsOf(root)[1]!.querySelector('button.av-toggle')!.click();
    assert.deepEqual(stepsOf(root).map((s) => s.getAttribute('data-depth')), ['0', '0', '0']);
  });

  test('a nested sequence keeps the depth of its own children', () => {
    const root = draw(agent());
    stepsOf(root)[1]!.querySelector('button.av-toggle')!.click();
    root.setChild(IRIS, agent({ agentId: IRIS, steps: [childStep({ id: 'toolu_B', childAgentId: 'z9' })] }));
    stepsOf(root)[2]!.querySelector('button.av-toggle')!.click();
    root.setChild('z9', agent({ agentId: 'z9', steps: [step(9)] }));
    assert.deepEqual(stepsOf(root).map((s) => s.getAttribute('data-depth')), ['0', '0', '1', '2', '0']);
  });
});

describe('a child whose read failed, in its own slot (#539 AC-5)', () => {
  const openChild = (opts: Record<string, unknown> = {}) => {
    const root = draw(agent({ steps: [step(0), childStep({ id: 'toolu_A' }), childStep({ id: 'toolu_B', childAgentId: 'z9' })] }), opts);
    root.querySelectorAll('.av-step')[1]!.querySelector('button.av-toggle')!.click();
    root.querySelectorAll('.av-step')[2]!.querySelector('button.av-toggle')!.click();
    return root;
  };
  const slot = (root: ElementoFalso, i: number) => root.querySelectorAll('.av-step')[i]!;

  test('the slot says the agent could not be read and offers "Tentar de novo", the rest stays', () => {
    const root = openChild();
    root.setChildError(IRIS, () => {});
    const failed = slot(root, 1);
    assert.ok(failed.querySelector('[role="alert"]'), 'the line is an alert');
    assert.match(texto(failed.querySelector('[role="alert"]')!), /Não deu para ler o agente/);
    assert.match(texto(failed.querySelector('.av-child-retry')!), /Tentar de novo/);
    assert.equal(failed.querySelector('.av-child-loading'), null);
    assert.ok(slot(root, 2).querySelector('.av-child-loading'), 'the other open child is untouched');
    assert.equal(stepsOf(root).length, 3, 'the sequence around it is kept');
  });

  test('"Tentar de novo" calls only that child\'s retry and puts the slot back to reading', () => {
    const root = openChild();
    const calls: string[] = [];
    root.setChildError(IRIS, () => calls.push('iris'));
    root.setChildError('z9', () => calls.push('z9'));
    slot(root, 1).querySelector('.av-child-retry')!.click();
    assert.deepEqual(calls, ['iris']);
    assert.equal(slot(root, 1).querySelector('[role="alert"]'), null);
    assert.match(texto(slot(root, 1).querySelector('.av-child-loading')!), /Lendo o agente/);
    assert.ok(slot(root, 2).querySelector('[role="alert"]'), 'the other failed child keeps its error');
  });

  test('a later setChild replaces the error with the sequence', () => {
    const root = openChild();
    root.setChildError(IRIS, () => {});
    root.setChild(IRIS, agent({ agentId: IRIS, steps: [step(1)] }));
    assert.equal(slot(root, 1).querySelector('[role="alert"]'), null);
    assert.equal(slot(root, 1).querySelectorAll('.av-step').length, 1);
  });
});

describe('the states of the view (AC-4)', () => {
  test('loading: the shape of the view as skeleton, busy, with no invented brief', () => {
    const root = view.agentViewLoading({ sessionId: SID, sessionTitle: 'Separar pagamentos' }) as ElementoFalso;
    assert.equal(root.getAttribute('aria-busy'), 'true');
    assert.ok(root.querySelector('.av-crumb'), 'the crumb comes from the address');
    assert.equal(root.querySelectorAll('.av-skeleton-fact').length, 4);
    assert.equal(root.querySelectorAll('.av-skeleton-section').length, 3);
    assert.equal(root.querySelector('.av-brief'), null);
    assert.match(texto(root), /Lendo o agente/);
  });

  test('error: says so with the reason and "Tentar de novo" that calls only the retry', () => {
    let retried = 0;
    const root = view.agentViewError({ sessionId: SID, text: 'O núcleo não respondeu a tempo (503).', retry: () => void retried++ }) as ElementoFalso;
    assert.ok(root.querySelector('[role="alert"]'));
    assert.match(texto(root), /Não deu para ler este agente/);
    assert.match(texto(root), /O núcleo não respondeu a tempo/);
    assert.ok(root.querySelector('.av-crumb'), 'the crumb stays to leave the screen');
    const retry = root.querySelectorAll('button').find((b) => texto(b) === 'Tentar de novo')!;
    retry.click();
    assert.equal(retried, 1);
  });

  test('not found: the agent is not in this session, with the way back to the Agents tab', () => {
    const root = view.agentViewMissing({ sessionId: SID }) as ElementoFalso;
    assert.match(texto(root), /Este agente não existe nesta sessão/);
    assert.equal(root.querySelector('a.av-back')!.getAttribute('href'), `/ui/sessions/${SID}#agents`);
  });

  test('failed agent: the red band with the last error, the sequence it reached and no result', () => {
    const failing = agent({ state: 'error', result: null, steps: [step(1), step(2, { name: 'Bash', summary: 'gh pr diff 524', state: 'error' })] });
    const root = draw(failing);
    const band = root.querySelector('.av-failed')!;
    assert.equal(band.getAttribute('role'), 'alert');
    assert.match(texto(band), /O agente falhou/);
    assert.match(texto(band), /Bash/);
    assert.match(texto(band), /gh pr diff 524/);
    assert.match(texto(root.querySelector('.av-state')), /Com erro/);
    assert.equal(stepsOf(root).length, 2);
    assert.equal(stepsOf(root)[1]!.getAttribute('data-state'), 'error');
    assert.match(texto(root.querySelector('.av-result')), /Falhou antes de devolver um resultado/);
  });

  test('failed agent with no failed step still says it failed, without inventing a reason', () => {
    const root = draw(agent({ state: 'error', result: null, steps: [step(1)] }));
    assert.match(texto(root.querySelector('.av-failed')), /O agente falhou/);
    assert.doesNotMatch(texto(root.querySelector('.av-failed')), /última ferramenta/);
  });

  test('no brief: one line says so, in place of the block', () => {
    const root = draw(agent({ brief: null }));
    assert.match(texto(root.querySelector('.av-brief')), /Sem brief registrado/);
    assert.equal(root.querySelector('.av-brief .av-text'), null);
  });

  test('no data at all: the empty state, not blank fields', () => {
    const root = draw(agent({ brief: null, steps: [], result: null, costUsd: null, costNote: 'no_usage', totalCostUsd: null, agentType: null, description: null }));
    assert.ok(root.querySelector('.state'), 'empty state');
    assert.match(texto(root), /Sem dados deste agente/);
    assert.equal(stepsOf(root).length, 0);
    assert.match(texto(root.querySelector('.av-cost')), /^Custo —/);
  });

  test('a running agent: "Ativa", the duration "até agora", and "Ainda sem resultado" in place of the result', () => {
    const root = draw(agent({ state: 'working', end: null, result: null }));
    assert.match(texto(root.querySelector('.av-state')), /Ativa/);
    assert.match(texto(root.querySelector('.av-duration')), /30 min.*até agora/);
    assert.match(texto(root.querySelector('.av-cost')), /até agora/);
    assert.match(texto(root.querySelector('.av-result')), /Ainda sem resultado/);
  });

  test('new steps of a running agent raise "N passos novos", leave the list as it is and never scroll', () => {
    const root = draw(agent({ state: 'working', end: null, result: null, steps: [step(1), step(2)] }));
    let scrolled = 0;
    (root as unknown as { scrollIntoView: () => void }).scrollIntoView = () => void scrolled++;
    for (const s of stepsOf(root)) (s as unknown as { scrollIntoView: () => void }).scrollIntoView = () => void scrolled++;
    assert.equal(root.querySelector('.av-new-steps')!.hasAttribute('hidden'), true, 'nothing new yet');

    root.update(agent({ state: 'working', end: null, result: null, steps: [step(1), step(2), step(3), step(4)] }));
    const pill = root.querySelector('.av-new-steps')!;
    assert.equal(pill.hasAttribute('hidden'), false);
    assert.match(texto(pill), /2 passos novos/);
    assert.equal(stepsOf(root).length, 2, 'the list stays as the person left it');
    assert.equal(scrolled, 0, 'no auto-scroll');

    pill.click();
    assert.equal(stepsOf(root).length, 4);
    assert.equal(root.querySelector('.av-new-steps')!.hasAttribute('hidden'), true);
    assert.equal(scrolled, 0, 'not even on the click');
  });

  test('one new step is "1 passo novo"; what is open stays open through an update', () => {
    const root = draw(agent({ state: 'working', end: null, result: null, steps: [step(1)] }));
    stepsOf(root)[0]!.querySelector('button.av-toggle')!.click();
    root.update(agent({ state: 'working', end: null, result: null, steps: [step(1), step(2)] }));
    assert.match(texto(root.querySelector('.av-new-steps')), /1 passo novo/);
    assert.ok(stepsOf(root)[0]!.querySelector('.av-detail'), 'the open detail survived');
  });

  test('the header and the result follow an update at once, only the steps wait', () => {
    const root = draw(agent({ state: 'working', end: null, result: null, steps: [step(1)] }));
    root.update(agent({ state: 'completed', result: 'Done now.', steps: [step(1), step(2)] }));
    assert.match(texto(root.querySelector('.av-state')), /Concluída/);
    assert.match(texto(root.querySelector('.av-result')), /Done now\./);
    assert.equal(stepsOf(root).length, 1);
  });
});
