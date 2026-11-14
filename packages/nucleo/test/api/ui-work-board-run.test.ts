/* issue 532 the components of "Executar plano" (layer 2), pure render functions in the fake DOM. One test per wireframe state:
465-2 (the card's actions: Executar plano, "subindo…", Abrir sessão), 465-6 (the confirmation, the limit full, the missing folder,
the notice after confirming) and 467-1 (the same actions in the issue panel). There is no workbench, visual or axe tool in this
project (component map: node:test with the fake DOM), so the accessibility checks are assertions on roles and names. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import {
  cardRunParts,
  runConfirm,
  runNotice,
  runState,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-run.js';
import {
  missingFolder,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-plan.js';
import {
  issuePanel,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-issue-panel.js';
// @ts-expect-error: browser module, plain JavaScript
import { workCard } from '../../ui/screens/work-board-parts.js';

instalarDomFalso();

const FILES = ['screens/work-board-run.js', 'work-board-issue-panel.css'];
const REPO = 'ahrenatechnology/ahrena-console';
const NOW = new Date(2026, 10, 14, 10, 0, 0).getTime();
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

type Obj = Record<string, unknown>;
function card(n: number, over: Obj = {}): Obj {
  return {
    key: `${REPO}#${n}`,
    repo: REPO,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    level: 'item',
    type: 'story',
    typeName: 'User Story',
    state: 'open',
    column: 'planning',
    columnSince: ago(3 * HOUR),
    parent: { key: `${REPO}#6`, number: 6 },
    chain: [],
    projectStatus: { id: 'todo', name: 'Todo' },
    labels: [],
    milestone: null,
    plan: null,
    planning: null,
    execution: null,
    sessions: { count: 0, state: null, ids: [] },
    pullRequest: null,
    blocked: null,
    queuePosition: null,
    doneAt: null,
    doneBy: null,
    children: null,
    ...over,
  };
}
const planned = (n = 506, over: Obj = {}) => card(n, { plan: { steps: 5 }, ...over });
const all = (root: ElementoFalso, selector: string) => root.querySelectorAll(selector);
const one = (root: ElementoFalso, selector: string) => {
  const found = root.querySelector(selector);
  assert.ok(found, `no ${selector}`);
  return found;
};
const click = (node: ElementoFalso) => node.dispatchEvent({ type: 'click' });
const key = (node: ElementoFalso, k: string) => node.dispatchEvent({ type: 'keydown', key: k });
const labelOf = (node: ElementoFalso) => node.getAttribute('aria-label') ?? texto(node);

describe('Executar plano on the card (465-2)', () => {
  test('AC-1 a story, task, bug or spike in Planejamento with a plan has Executar plano as the one primary action, and Replanejar stays a link', () => {
    for (const type of ['story', 'task', 'bug', 'spike']) {
      const subject = planned(506, { type });
      const parts = cardRunParts(subject, {});
      assert.equal(runState(subject), 'planned', type);
      const run = one(parts.actions, '[data-action="run"]');
      assert.equal(texto(run), 'Executar plano');
      assert.equal(run.getAttribute('aria-label'), 'Executar o plano da #506');
      assert.ok(run.classList.contains('filled'), 'the primary action is a filled button');
      assert.equal(all(parts.actions, '[data-action="plan"]').length, 0, 'no Planejar once there is a plan');
      const replan = one(parts.actions, '[data-action="replan"]');
      assert.equal(texto(replan), 'Replanejar');
      assert.ok(!replan.classList.contains('filled'));
      assert.equal(replan.closest('div')?.classList.contains('wb-plan-links'), true);
      assert.equal(all(parts.actions, 'button').length, 2, 'only the two actions of the state: Pôr na fila is the queue, issue 477');
    }
  });

  test('AC-1 without a plan the action is Planejar as today, and an epic, an initiative or a plan step gets no action', () => {
    const bare = cardRunParts(card(509), {});
    assert.equal(runState(card(509)), 'unplanned');
    assert.equal(all(bare.actions, '[data-action="run"]').length, 0);
    assert.equal(texto(one(bare.actions, '[data-action="plan"]')), 'Planejar');
    for (const type of ['epic', 'initiative', 'plan']) {
      const subject = card(6, { type, plan: { steps: 3 } });
      assert.equal(runState(subject), 'hidden', type);
      const parts = cardRunParts(subject, {});
      assert.deepEqual(parts, { badge: null, note: null, actions: null }, type);
    }
  });

  test('Executar plano asks the confirmation with the card and its button, and Replanejar still asks its own', () => {
    const asked: unknown[] = [];
    const replanned: unknown[] = [];
    const subject = planned();
    const parts = cardRunParts(subject, { onRun: (c: unknown, from: unknown) => asked.push([c, from]), onReplan: (c: unknown) => replanned.push(c) });
    const run = one(parts.actions, '[data-action="run"]');
    click(run);
    assert.deepEqual(asked, [[subject, run]]);
    click(one(parts.actions, '[data-action="replan"]'));
    assert.deepEqual(replanned, [subject]);
  });

  test('a failed planning keeps the red reason and, with a plan out, still offers Executar plano', () => {
    const subject = planned(506, { planning: { state: 'failed', reason: 'A sessão parou com erro de API' } });
    const parts = cardRunParts(subject, {});
    assert.equal(texto(parts.note), 'A sessão parou com erro de API');
    assert.equal(texto(one(parts.actions, '[data-action="run"]')), 'Executar plano');
  });

  test('while the plan is being written the card keeps "planejando…" and offers no action', () => {
    const parts = cardRunParts(planned(506, { planning: { state: 'running' } }), {});
    assert.equal(texto(parts.badge), 'planejando…');
    assert.equal(parts.actions, null);
  });

  test('a card in another column than Planejamento with a plan does not offer Executar plano (the queue is issue 477)', () => {
    for (const column of ['queued', 'review', 'done']) {
      const parts = cardRunParts(planned(506, { column }), {});
      assert.equal(parts.actions, null, column);
    }
  });
});

describe('"subindo…" and Abrir sessão on the card (465-2, 465-6)', () => {
  test('AC-2 a card with a booting run shows "subindo…" as a status badge and no action', () => {
    const subject = planned(506, { column: 'running', execution: { state: 'booting' } });
    const parts = cardRunParts(subject, {});
    assert.equal(runState(subject), 'booting');
    assert.equal(texto(parts.badge), 'subindo…');
    assert.equal(parts.badge.getAttribute('role'), 'status');
    assert.equal(parts.badge.getAttribute('data-state'), 'booting');
    assert.ok(parts.badge.classList.contains('wb-pill-waiting'));
    assert.equal(parts.actions, null);
    const root = workCard(subject, { now: NOW, parts });
    assert.equal(texto(one(root, '.wb-badges [role="status"]')), 'subindo…');
    assert.equal(all(root, 'button').length, 0);
  });

  test('AC-5 with a live session the action is Abrir sessão, handed the card and its button', () => {
    for (const state of ['working', 'needs-you']) {
      const opened: unknown[] = [];
      const subject = card(500, { column: state === 'working' ? 'running' : 'blocked', sessions: { count: 1, state, ids: ['11111111-1111-4111-8111-111111111111'] } });
      const parts = cardRunParts(subject, { onOpenSession: (c: unknown, from: unknown) => opened.push([c, from]) });
      assert.equal(runState(subject), 'live', state);
      const open = one(parts.actions, '[data-action="open-session"]');
      assert.equal(texto(open), 'Abrir sessão');
      assert.equal(open.getAttribute('aria-label'), 'Abrir a sessão da #500');
      click(open);
      assert.deepEqual(opened, [[subject, open]]);
      assert.equal(all(parts.actions, '[data-action="run"]').length, 0);
    }
  });

  test('two sessions still give one Abrir sessão; an idle session, a card in review or done, and a booting run with no session give none', () => {
    const two = card(500, { column: 'running', sessions: { count: 2, state: 'working', ids: ['a', 'b'] } });
    assert.equal(all(cardRunParts(two, {}).actions, '[data-action="open-session"]').length, 1);
    const idle = card(500, { column: 'running', sessions: { count: 1, state: 'idle', ids: ['a'] } });
    assert.equal(cardRunParts(idle, {}).actions, null);
    for (const column of ['review', 'done']) {
      const subject = card(500, { column, sessions: { count: 1, state: 'working', ids: ['a'] } });
      assert.equal(cardRunParts(subject, {}).actions, null, column);
    }
  });

  test('the actions are keyboard buttons with a name, and every icon is hidden from readers', () => {
    const parts = [cardRunParts(planned(), {}), cardRunParts(card(500, { column: 'running', sessions: { count: 1, state: 'working', ids: ['a'] } }), {})];
    for (const part of parts) {
      for (const button of all(part.actions, 'button')) assert.ok(labelOf(button).length > 0);
      for (const svg of all(part.actions, 'svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
    }
  });
});

describe('the confirmation anchored on the card (465-6)', () => {
  const base = { repo: REPO, number: 506, folder: '~/Workspace/ahrena-console', prompt: 'Athena, execute o plano da #506 (5 passos) em ahrenatechnology/ahrena-console…' };

  test('AC-2 shows the repository, the folder, where to open and the start of the prompt, with no account row', () => {
    const root = runConfirm(base);
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('data-kind'), 'run');
    assert.equal(root.getAttribute('aria-label'), 'Executar o plano da #506');
    assert.equal(texto(one(root, 'h3')), 'Executar o plano da #506');
    assert.equal(texto(one(root, '[data-field="repo"]')), REPO);
    assert.equal(texto(one(root, '[data-field="folder"]')), '~/Workspace/ahrena-console');
    assert.equal(all(root, '[data-field="account"]').length, 0, 'the account is issue 524');
    assert.ok(!texto(root).includes('Conta'));
    const radios = all(root, '[role="radio"]');
    assert.deepEqual(radios.map((r) => texto(r)), ['Claude Desktop', 'Terminal']);
    assert.equal(radios[0]!.getAttribute('aria-checked'), 'true');
    assert.equal(texto(one(root, '[data-field="prompt"]')), base.prompt);
    assert.equal(texto(one(root, '[data-action="confirm"]')), 'Executar plano');
    assert.equal(all(root, '[data-field="limit"]').length, 0);
  });

  test('without a known folder the folder row is left out, not invented', () => {
    const root = runConfirm({ ...base, folder: null });
    assert.equal(all(root, '[data-field="folder"]').length, 0);
  });

  test('the hint says the card goes straight to Em execução and counts against the limit when the count is known', () => {
    const root = runConfirm({ ...base, running: 1, limit: 2 });
    const hint = texto(one(root, '.wb-plan-hint'));
    assert.ok(hint.includes('o card vai direto para Em execução'));
    assert.ok(hint.includes('Conta como 1 das 2 execuções; hoje há 1 rodando.'));
    assert.ok(!texto(runConfirm(base)).includes('Conta como'));
  });

  test('the choice of where to open follows the target and reports a change; Escape, Cancelar and the button call their handlers', () => {
    const calls: string[] = [];
    const root = runConfirm({ ...base, target: 'terminal', onTarget: (t: string) => calls.push(`target:${t}`), onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm') });
    const [desktop, terminal] = all(root, '[role="radio"]');
    assert.equal(terminal!.getAttribute('aria-checked'), 'true');
    click(desktop!);
    click(one(root, '[data-action="cancel"]'));
    click(one(root, '[data-action="confirm"]'));
    key(root, 'Escape');
    assert.deepEqual(calls, ['target:desktop', 'cancel', 'confirm', 'cancel']);
  });

  test('while the request is in flight the button is busy and refuses a second press', () => {
    const calls: string[] = [];
    const root = runConfirm({ ...base, busy: true, onConfirm: () => calls.push('confirm') });
    const button = one(root, '[data-action="confirm"]');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.hasAttribute('disabled'), true);
  });

  test('AC-3 the limit full warns with the count and the button becomes "Executar mesmo assim"', () => {
    const calls: string[] = [];
    const root = runConfirm({ ...base, full: { running: 2, limit: 2 }, onConfirm: () => calls.push('force') });
    assert.equal(root.getAttribute('data-kind'), 'run-full');
    const warn = one(root, '[data-field="limit"]');
    assert.equal(warn.getAttribute('role'), 'alert');
    assert.ok(texto(warn).includes('Passa do limite.'));
    assert.ok(texto(warn).includes('2 de 2 rodando'));
    assert.ok(texto(warn).includes('esta seria a 3ª execução'));
    const button = one(root, '[data-action="confirm"]');
    assert.equal(texto(button), 'Executar mesmo assim');
    assert.equal(all(root, '[data-action="confirm"]').length, 1);
    assert.ok(texto(one(root, '.wb-plan-hint')).includes('Executar mesmo assim abre a sessão agora.'));
    click(button);
    assert.deepEqual(calls, ['force']);
  });

  test('AC-4 the missing folder is the command with "Copiar comando", and the card stays where it was', async () => {
    const command = 'git clone https://example.invalid/ahrena-console.git ~/Workspace/ahrena-console';
    const copied: string[] = [];
    const root = missingFolder({ repo: REPO, command, copy: async (text: string) => void copied.push(text) });
    assert.equal(root.getAttribute('data-kind'), 'folder');
    assert.equal(texto(one(root, '[role="note"]')), command);
    const button = one(root, '[data-action="copy"]');
    assert.equal(texto(button), 'Copiar comando');
    assert.ok(texto(root).includes('o card fica onde estava'));
    click(button);
    await Promise.resolve();
    assert.deepEqual(copied, [command]);
  });
});

describe('the notice after confirming (465-6)', () => {
  test('AC-2 says where the session opened and offers Abrir', () => {
    const calls: string[] = [];
    const root = runNotice({ number: 506, opened: 'desktop', onOpen: () => calls.push('open'), onClose: () => calls.push('close') });
    assert.equal(root.getAttribute('role'), 'status');
    assert.equal(texto(one(root, '[data-field="text"]')), 'Sessão da Athena abrindo no Claude Desktop para a #506');
    click(one(root, '[data-action="open"]'));
    click(one(root, '[data-action="close"]'));
    assert.deepEqual(calls, ['open', 'close']);
  });

  test('the terminal and a focused terminal each say so', () => {
    assert.ok(texto(runNotice({ number: 506, opened: 'terminal' })).includes('abrindo no Terminal para a #506'));
    assert.ok(texto(runNotice({ number: 506, opened: 'focused' })).includes('Terminal à frente para a #506'));
  });

  test('without a handler for Abrir the button is left out', () => {
    assert.equal(all(runNotice({ number: 506, opened: 'desktop' }), '[data-action="open"]').length, 0);
  });
});

describe('the same actions in the issue panel (467-1)', () => {
  const issue = (n: number, over: Obj = {}) => ({
    key: `${REPO}#${n}`,
    repo: REPO,
    type: 'story',
    number: n,
    title: `Issue ${n}`,
    state: 'OPEN',
    url: `https://github.com/${REPO}/issues/${n}`,
    labels: [],
    milestone: null,
    projectStatus: 'Todo',
    body: 'Corpo',
    comments: [],
    commentsTotal: 0,
    parents: [],
    subIssues: [],
    plan: { count: 0, steps: [] },
    pullRequest: null,
    fetchedAt: NOW,
    stale: false,
    staleReason: null,
    ...over,
  });

  test('AC-1 with a plan the panel offers Executar plano and Replanejar, in the action row, and not Planejar', () => {
    const subject = planned(506);
    const root = issuePanel({ card: subject, issue: issue(506), now: NOW, parts: cardRunParts(subject, {}) });
    assert.equal(texto(one(root, '.wb-panel-acts [data-action="run"]')), 'Executar plano');
    assert.equal(texto(one(root, '.wb-panel-acts [data-action="replan"]')), 'Replanejar');
    assert.equal(all(root, '[data-action="plan"]').length, 0);
    assert.ok(!texto(root.querySelector('.wb-panel-acts')!).includes('Pôr na fila'));
  });

  test('without a plan the panel keeps Planejar and has no Executar plano', () => {
    const subject = card(509);
    const root = issuePanel({ card: subject, issue: issue(509), now: NOW, parts: cardRunParts(subject, {}) });
    assert.equal(texto(one(root, '.wb-panel-acts [data-action="plan"]')), 'Planejar');
    assert.equal(all(root, '[data-action="run"]').length, 0);
  });

  test('AC-2 and AC-5 a booting run shows "subindo…" and a live session shows Abrir sessão in the panel', () => {
    const booting = planned(506, { column: 'running', execution: { state: 'booting' } });
    const a = issuePanel({ card: booting, issue: issue(506), now: NOW, parts: cardRunParts(booting, {}) });
    assert.equal(texto(one(a, '.wb-panel-acts [role="status"]')), 'subindo…');
    const live = card(500, { column: 'running', sessions: { count: 1, state: 'working', ids: ['a'] } });
    const b = issuePanel({ card: live, issue: issue(500), now: NOW, parts: cardRunParts(live, {}) });
    assert.equal(texto(one(b, '.wb-panel-acts [data-action="open-session"]')), 'Abrir sessão');
  });
});

describe('the files follow the /ui rules', () => {
  test('the new files write no colour, no inline style, no innerHTML, no fetch and no external address', () => {
    for (const file of FILES) {
      const text = readFileSync(`${UI_FOLDER}${file}`, 'utf8');
      const urls = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${file} names an external address`);
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${file} writes a colour by hand`);
      assert.doesNotMatch(text, /style=|innerHTML|\bfetch\(/, `${file} uses inline style, innerHTML or fetch`);
    }
  });

  test('every wb-run class the JS uses is styled in the panel CSS', () => {
    const css = readFileSync(`${UI_FOLDER}work-board-issue-panel.css`, 'utf8');
    const js = readFileSync(`${UI_FOLDER}screens/work-board-run.js`, 'utf8');
    const used = new Set([...js.matchAll(/\bwb-run-[a-z0-9-]+/g)].map((m) => m[0]));
    assert.ok(used.size > 0);
    for (const c of used) assert.ok(css.includes(`.${c}`), `${c} is not in work-board-issue-panel.css`);
  });
});
