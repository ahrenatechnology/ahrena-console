// issue 467, issue 508: the components of the issue panel and of Planejar (layer 2), pure render functions in the fake DOM.
// One test per wireframe state: 467-1 (sem plano, com plano, em review), 465-6 (confirmation, planejando…, plano · N passos,
// the failed planning, the missing folder) and 465-2 (the card's actions). There is no workbench, visual or axe tool in this
// project (component map: node:test with the fake DOM), so the accessibility checks are assertions on roles and names.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import {
  cardPlanParts,
  missingFolder,
  planConfirm,
  planState,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-plan.js';
import {
  issuePanel,
  issuePanelFailure,
  issuePanelLoading,
  issuePanelStage,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-issue-panel.js';
// @ts-expect-error: browser module, plain JavaScript
import { workCard } from '../../ui/screens/work-board-parts.js';

instalarDomFalso();

const FILES = ['screens/work-board-plan.js', 'screens/work-board-issue-panel.js', 'work-board-issue-panel.css'];
const REPO = 'ahrenatechnology/ahrena-console';
const NOW = new Date(2026, 10, 13, 23, 12, 40).getTime();
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
const ref = (n: number, title: string, type = 'plan', state = 'OPEN') => ({ key: `${REPO}#${n}`, repo: REPO, number: n, title, url: `https://github.com/${REPO}/issues/${n}`, state, type });
function issue(n: number, over: Obj = {}): Obj {
  return {
    key: `${REPO}#${n}`,
    repo: REPO,
    type: 'story',
    number: n,
    title: `Abrir a issue #${n} pelo card`,
    state: 'OPEN',
    url: `https://github.com/${REPO}/issues/${n}`,
    labels: ['work-board'],
    milestone: 'M3 · Quadro do trabalho',
    projectStatus: 'Todo',
    body: 'O detalhe abre ao lado do quadro.\n\n```gherkin\nCenário: Abrir pelo card\n  Quando clico no card\n```',
    comments: [],
    commentsTotal: 0,
    parents: [ref(1, 'Console como cockpit', 'initiative'), ref(6, 'Quadro do trabalho', 'epic')],
    subIssues: [],
    plan: { count: 0, steps: [] },
    pullRequest: null,
    fetchedAt: NOW,
    stale: false,
    staleReason: null,
    ...over,
  };
}
const steps = (nums: number[], state = 'OPEN') => nums.map((n) => ({ number: n, title: `Passo ${n}`, url: `https://github.com/${REPO}/issues/${n}`, state }));
const withPlan = (nums: number[], state = 'OPEN') => ({ subIssues: steps(nums, state), plan: { count: nums.length, steps: steps(nums, state) } });

const all = (root: ElementoFalso, selector: string) => root.querySelectorAll(selector);
const one = (root: ElementoFalso, selector: string) => {
  const found = root.querySelector(selector);
  assert.ok(found, `no ${selector}`);
  return found;
};
const labelOf = (node: ElementoFalso) => node.getAttribute('aria-label') ?? texto(node);
const click = (node: ElementoFalso) => node.dispatchEvent({ type: 'click' });
const key = (node: ElementoFalso, k: string) => node.dispatchEvent({ type: 'keydown', key: k });
const PARTS_DEAD = ['Executar plano', 'Pôr na fila', 'Tirar da fila', 'Editar'];
const noDeadAction = (node: ElementoFalso) => {
  for (const word of PARTS_DEAD) assert.ok(!texto(node).includes(word), `${word} belongs to another issue`);
};
const slot = (parts: { badge: ElementoFalso | null; note: ElementoFalso | null; actions: ElementoFalso | null }) => [parts.badge, parts.note, parts.actions].filter(Boolean) as ElementoFalso[];
const holder = (parts: Parameters<typeof slot>[0]) => {
  const root = new ElementoFalso('div');
  root.append(...slot(parts));
  return root;
};

describe('Planejar on the card (465-2, 465-6)', () => {
  test('a story, task, bug or spike without a plan has Planejar as the one primary action', () => {
    for (const type of ['story', 'task', 'bug', 'spike']) {
      const parts = cardPlanParts(card(500, { type }), {});
      assert.equal(planState(card(500, { type })), 'unplanned', type);
      const button = one(parts.actions, '[data-action="plan"]');
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(texto(button), 'Planejar');
      assert.equal(button.getAttribute('aria-label'), 'Planejar a #500');
      assert.ok(button.classList.contains('filled'), 'the primary action is a filled button');
      assert.equal(all(parts.actions, 'button').length, 1, 'one action only');
      assert.equal(parts.badge, null);
      assert.equal(parts.note, null);
      noDeadAction(parts.actions);
    }
  });

  test('an epic, an initiative and a plan step have no action, nor does a card out of Planejamento', () => {
    for (const type of ['epic', 'initiative', 'plan']) {
      const parts = cardPlanParts(card(6, { type }), {});
      assert.equal(planState(card(6, { type })), 'hidden', type);
      assert.deepEqual(parts, { badge: null, note: null, actions: null }, type);
    }
    for (const column of ['queued', 'running', 'review', 'blocked', 'done']) {
      assert.equal(planState(card(500, { column })), 'hidden', column);
      assert.equal(cardPlanParts(card(500, { column }), {}).actions, null, column);
    }
  });

  test('Planejar asks the confirmation with the card and the button that was pressed', () => {
    const asked: unknown[] = [];
    const subject = card(500);
    const parts = cardPlanParts(subject, { onPlan: (c: unknown, from: unknown) => asked.push([c, from]) });
    const button = one(parts.actions, '[data-action="plan"]');
    click(button);
    assert.deepEqual(asked, [[subject, button]]);
  });

  test('while planning the card says "planejando…" and offers no Planejar', () => {
    const subject = card(500, { planning: { state: 'running' } });
    const parts = cardPlanParts(subject, {});
    assert.equal(planState(subject), 'planning');
    assert.equal(texto(parts.badge), 'planejando…');
    assert.equal(parts.badge.getAttribute('role'), 'status');
    assert.equal(parts.note, null);
    const root = holder(parts);
    assert.equal(all(root, '[data-action="plan"]').length, 0);
    assert.equal(all(root, '[data-action="replan"]').length, 0);
  });

  test('while planning, "Abrir sessão" appears only when the screen can open it', () => {
    const subject = card(500, { planning: { state: 'running' } });
    assert.equal(all(holder(cardPlanParts(subject, {})), '[data-action="open-session"]').length, 0);
    let opened = 0;
    const parts = cardPlanParts(subject, { onOpenSession: () => (opened += 1) });
    const open = one(holder(parts), '[data-action="open-session"]');
    assert.equal(texto(open), 'Abrir sessão');
    assert.equal(open.getAttribute('aria-label'), 'Abrir a sessão de planejamento da #500');
    click(open);
    assert.equal(opened, 1);
  });

  test('with a plan the action is Replanejar, a secondary link, and Planejar is gone', () => {
    const subject = card(500, { plan: { steps: 3 } });
    const parts = cardPlanParts(subject, { onReplan: () => {} });
    assert.equal(planState(subject), 'planned');
    assert.equal(parts.badge, null);
    assert.equal(all(parts.actions, '[data-action="plan"]').length, 0);
    const link = one(parts.actions, '[data-action="replan"]');
    assert.equal(texto(link), 'Replanejar');
    assert.equal(link.getAttribute('aria-label'), 'Replanejar a #500');
    assert.ok(!link.classList.contains('filled'), 'secondary, not a filled button');
    assert.equal(link.closest('div')?.classList.contains('wb-plan-links'), true, 'in the line below, as a link');
    noDeadAction(parts.actions);
  });

  test('Replanejar asks the confirmation with the card and its button', () => {
    const asked: unknown[] = [];
    const subject = card(500, { plan: { steps: 3 } });
    const parts = cardPlanParts(subject, { onReplan: (c: unknown, from: unknown) => asked.push([c, from]) });
    const link = one(parts.actions, '[data-action="replan"]');
    click(link);
    assert.deepEqual(asked, [[subject, link]]);
  });

  test('a failed planning puts the card back to Planejar with the reason, in a red alert', () => {
    const subject = card(500, { planning: { state: 'failed', reason: 'A sessão de planejamento terminou sem plano' } });
    const parts = cardPlanParts(subject, {});
    assert.equal(planState(subject), 'failed');
    assert.equal(parts.badge, null);
    assert.equal(parts.note.getAttribute('role'), 'alert');
    assert.equal(texto(parts.note), 'A sessão de planejamento terminou sem plano');
    assert.equal(texto(one(parts.actions, '[data-action="plan"]')), 'Planejar');
    assert.equal(all(parts.actions, '[data-action="replan"]').length, 0);
  });

  test('the actions are keyboard buttons with a name, and every icon is hidden from readers', () => {
    const parts = cardPlanParts(card(500), {});
    for (const button of all(parts.actions, 'button')) assert.ok(labelOf(button).length > 0);
    for (const svg of all(parts.actions, 'svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
  });
});

describe('the card carries the planning parts and opens the detail (465-2, 467-1)', () => {
  test('workCard places the note, the badge and the actions, and stays as it was without them', () => {
    const plain = workCard(card(500), { now: NOW });
    assert.equal(all(plain, 'button').length, 0);
    const failed = card(500, { planning: { state: 'failed', reason: 'A sessão de planejamento não abriu a tempo' } });
    const root = workCard(failed, { now: NOW, parts: cardPlanParts(failed, {}) });
    assert.ok(root.classList.contains('wb-card-fail'), 'a failed planning marks the card red');
    assert.equal(texto(one(root, '[role="alert"]')), 'A sessão de planejamento não abriu a tempo');
    assert.equal(texto(one(root, '[data-action="plan"]')), 'Planejar');
    const running = card(501, { planning: { state: 'running' } });
    const busy = workCard(running, { now: NOW, parts: cardPlanParts(running, {}) });
    assert.equal(texto(one(busy, '.wb-badges [role="status"]')), 'planejando…');
  });

  test('"plano · N passos" shows on the card once the plan is out', () => {
    const planned = card(500, { plan: { steps: 3 } });
    const root = workCard(planned, { now: NOW, parts: cardPlanParts(planned, {}) });
    assert.ok(texto(root).includes('plano · 3 passos'));
    assert.equal(texto(one(root, '[data-action="replan"]')), 'Replanejar');
  });

  test('a click on the card opens the detail, a click on a button or the title link does not', () => {
    const opened: unknown[] = [];
    const subject = card(500);
    const root = workCard(subject, { now: NOW, onOpen: (c: unknown) => opened.push(c), parts: cardPlanParts(subject, {}) });
    click(root);
    click(one(root, '.wb-number'));
    assert.equal(opened.length, 2);
    click(one(root, '[data-action="plan"]'));
    click(one(root, '.wb-card-title a'));
    assert.equal(opened.length, 2, 'buttons and links keep their own click');
  });

  test('the card is reachable by keyboard when it opens the detail, and marks the open one', () => {
    const opened: unknown[] = [];
    const subject = card(500);
    const root = workCard(subject, { now: NOW, onOpen: (c: unknown) => opened.push(c), selected: true });
    assert.equal(root.getAttribute('tabindex'), '0');
    assert.equal(root.hasAttribute('data-openable'), true);
    assert.equal(root.hasAttribute('data-selected'), true);
    key(root, 'Enter');
    assert.equal(opened.length, 1);
    const inert = workCard(subject, { now: NOW });
    assert.equal(inert.hasAttribute('tabindex'), false);
    assert.equal(inert.hasAttribute('data-openable'), false);
    assert.equal(inert.hasAttribute('data-selected'), false);
  });
});

describe('the Planejar confirmation anchored on the card (465-6)', () => {
  const base = { repo: REPO, number: 509, account: 'Ahrena · Team', folder: '~/Workspace/ahrena-console', prompt: 'Athena, só planejamento: leia a ahrenatechnology/ahrena-console#509 e o código.' };

  test('names the issue and shows repository, folder, current account, destination and the start of the prompt', () => {
    const root = planConfirm({ ...base, target: 'desktop' });
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Planejar a #509 com a Athena');
    assert.equal(texto(one(root, 'h3')), 'Planejar a #509 com a Athena');
    const rows = texto(one(root, 'dl'));
    for (const part of ['Repositório', REPO, 'Pasta', '~/Workspace/ahrena-console', 'Conta', 'Ahrena · Team', 'Abrir em']) assert.ok(rows.includes(part), part);
    assert.equal(texto(one(root, '.wb-plan-prompt')), base.prompt);
    assert.equal(one(root, '.wb-plan-prompt').getAttribute('aria-label'), 'Começo do prompt');
    assert.ok(texto(root).includes('planejando…'), 'says what the card shows next');
    assert.ok(texto(root).includes('Não conta no limite de execuções'));
  });

  test('the account is read-only: no select, no button, no chevron in its row', () => {
    const root = planConfirm({ ...base, target: 'desktop' });
    const account = one(root, '[data-field="account"]');
    assert.equal(texto(account), 'Ahrena · Team');
    assert.equal(all(account, 'button').length + all(account, 'select').length + all(account, 'input').length, 0);
    assert.equal(all(account, 'svg').length, 0);
    assert.equal(account.getAttribute('role'), null);
  });

  test('folder and prompt rows appear only when given: the contract reveals them after the POST', () => {
    const root = planConfirm({ repo: REPO, number: 509, account: 'Ahrena · Team', target: 'desktop' });
    assert.ok(!texto(root).includes('Pasta'));
    assert.equal(all(root, '.wb-plan-prompt').length, 0);
    assert.ok(texto(root).includes('Repositório'));
    const noAccount = planConfirm({ repo: REPO, number: 509, target: 'desktop' });
    assert.equal(all(noAccount, '[data-field="account"]').length, 0);
  });

  test('the destination is a radio group with Claude Desktop and Terminal, the chosen one checked', () => {
    const asked: string[] = [];
    const root = planConfirm({ ...base, target: 'terminal', onTarget: (t: string) => asked.push(t) });
    const group = one(root, '[role="radiogroup"]');
    assert.equal(group.getAttribute('aria-label'), 'Abrir em');
    const radios = all(group, '[role="radio"]');
    assert.deepEqual(radios.map((r) => texto(r)), ['Claude Desktop', 'Terminal']);
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true']);
    assert.deepEqual(radios.map((r) => r.getAttribute('data-target')), ['desktop', 'terminal']);
    click(radios[0]!);
    assert.deepEqual(asked, ['desktop']);
  });

  test('Cancelar and Planejar are named buttons, and Planejar confirms', () => {
    const calls: string[] = [];
    const root = planConfirm({ ...base, target: 'desktop', onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm') });
    const cancel = one(root, '[data-action="cancel"]');
    const confirm = one(root, '[data-action="confirm"]');
    assert.equal(texto(cancel), 'Cancelar');
    assert.equal(texto(confirm), 'Planejar');
    assert.ok(confirm.classList.contains('filled'));
    click(cancel);
    click(confirm);
    assert.deepEqual(calls, ['cancel', 'confirm']);
    for (const button of all(root, 'button')) assert.ok(labelOf(button).length > 0);
  });

  test('Escape cancels', () => {
    let cancelled = 0;
    const root = planConfirm({ ...base, target: 'desktop', onCancel: () => (cancelled += 1) });
    key(root, 'Escape');
    key(root, 'Enter');
    assert.equal(cancelled, 1);
  });

  test('while the request runs the confirm button is disabled and busy', () => {
    const root = planConfirm({ ...base, target: 'desktop', busy: true });
    const confirm = one(root, '[data-action="confirm"]');
    assert.equal(confirm.hasAttribute('disabled'), true);
    assert.equal(confirm.getAttribute('aria-busy'), 'true');
  });

  test('replanning reuses the confirmation: Replanejar in the title and on the button', () => {
    const root = planConfirm({ ...base, target: 'desktop', replan: true });
    assert.equal(root.getAttribute('aria-label'), 'Replanejar a #509 com a Athena');
    assert.equal(texto(one(root, '[data-action="confirm"]')), 'Replanejar');
    assert.ok(texto(root).includes('plano atual'), 'says the current plan goes to the session');
  });
});

describe('the missing folder (465-6)', () => {
  const command = "claude 'Athena, só planejamento: leia a ahrenatechnology/ahrena-console#509'";

  test('says the folder is missing, shows the command, offers Fechar and Copiar comando', () => {
    const root = missingFolder({ repo: REPO, command });
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Falta a pasta do repositório nesta máquina');
    assert.equal(texto(one(root, 'h3')), 'Falta a pasta do repositório nesta máquina');
    assert.ok(texto(root).includes(REPO));
    assert.ok(texto(root).includes('o card fica onde estava'));
    assert.equal(texto(one(root, '.wb-plan-cmd')), command);
    assert.equal(one(root, '.wb-plan-cmd').getAttribute('aria-label'), 'Comando');
    assert.equal(texto(one(root, '[data-action="close"]')), 'Fechar');
    assert.equal(texto(one(root, '[data-action="copy"]')), 'Copiar comando');
    for (const button of all(root, 'button')) assert.ok(labelOf(button).length > 0);
  });

  test('the message of the core wins over the default text', () => {
    const message = 'Não achei uma pasta de ahrenatechnology/ahrena-console nesta máquina; copie o comando e rode na pasta do repositório';
    const root = missingFolder({ repo: REPO, command, message });
    assert.ok(texto(root).includes(message));
    assert.ok(!texto(root).includes('O Console não achou'));
  });

  test('Copiar comando copies exactly the command and says so; a refusal says so too', async () => {
    const copied: string[] = [];
    const root = missingFolder({ repo: REPO, command, copy: async (text: string) => void copied.push(text) });
    const copy = one(root, '[data-action="copy"]');
    click(copy);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(copied, [command]);
    assert.equal(texto(copy), 'Copiado');
    const refused = missingFolder({ repo: REPO, command, copy: async () => Promise.reject(new Error('denied')) });
    const again = one(refused, '[data-action="copy"]');
    click(again);
    await new Promise((r) => setImmediate(r));
    assert.equal(texto(again), 'Não deu para copiar');
  });

  test('Fechar and Escape close it; with no command there is nothing to copy', () => {
    let closed = 0;
    const root = missingFolder({ repo: REPO, command, onClose: () => (closed += 1) });
    click(one(root, '[data-action="close"]'));
    key(root, 'Escape');
    assert.equal(closed, 2);
    const bare = missingFolder({ repo: REPO });
    assert.equal(all(bare, '[data-action="copy"]').length, 0);
    assert.equal(all(bare, '.wb-plan-cmd').length, 0);
  });
});

describe('the issue panel (467-1)', () => {
  const comments = [
    { author: 'fernando', createdAt: ago(24 * HOUR), body: 'Começar pelo painel ao lado.' },
    { author: 'ana-exemplo', createdAt: ago(20 * HOUR), body: 'O passo 4 pode ficar para depois.' },
  ];

  test('sem plano: header, title, parent chain, Planejar, description, empty plan, empty PR, details, no comments', () => {
    const subject = card(509);
    const root = issuePanel({ card: subject, issue: issue(509), now: NOW, parts: cardPlanParts(subject, {}) });
    assert.equal(root.tagName, 'ASIDE');
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Detalhe da issue #509');
    const head = texto(one(root, '.wb-panel-head'));
    for (const part of ['História', '#509', 'Planejamento · há 3 h']) assert.ok(head.includes(part), part);
    assert.equal(texto(one(root, 'h2')), 'Abrir a issue #509 pelo card');
    assert.equal(texto(one(root, '.wb-panel-chain')), '#1 Console como cockpit › #6 Quadro do trabalho › #509');
    assert.equal(texto(one(root, '.wb-panel-acts [data-action="plan"]')), 'Planejar');
    assert.ok(texto(one(root, '[data-section="description"]')).includes('O detalhe abre ao lado do quadro.'));
    const plan = texto(one(root, '[data-section="plan"]'));
    assert.ok(plan.includes('Plano'));
    assert.ok(plan.includes('Sem plano ainda. Planejar abre uma sessão da Athena só de planejamento'));
    assert.equal(all(root, '[data-section="plan"] li').length, 0);
    assert.ok(texto(one(root, '[data-section="pr"]')).includes('Nenhum PR ainda. Aparece aqui quando a sessão abrir o PR que fecha a #509.'));
    const details = texto(one(root, '[data-section="details"]'));
    for (const part of ['Tipo', 'História', 'Labels', 'work-board', 'Milestone', 'M3 · Quadro do trabalho', 'Pai', '#6 Quadro do trabalho', 'Status do Project', 'Todo', 'Repositório', 'ahrena-console']) assert.ok(details.includes(part), part);
    assert.ok(texto(one(root, '[data-section="comments"]')).includes('Comentários · 0'));
    noDeadAction(root);
  });

  test('com plano: lists the steps in order with their numbers, and Replanejar is the secondary action', () => {
    const subject = card(506, { plan: { steps: 5 } });
    const root = issuePanel({ card: subject, issue: issue(506, withPlan([520, 521, 522, 523, 524])), now: NOW, parts: cardPlanParts(subject, {}) });
    assert.ok(texto(one(root, '[data-section="plan"] h3')).startsWith('Plano · 5 passos'));
    const items = all(root, '[data-section="plan"] li');
    assert.equal(items.length, 5);
    assert.deepEqual(items.map((li) => texto(li)), ['1 Passo 520 #520', '2 Passo 521 #521', '3 Passo 522 #522', '4 Passo 523 #523', '5 Passo 524 #524']);
    assert.ok(items.every((li) => li.getAttribute('data-state') === 'open'));
    assert.equal(one(root, '[data-section="plan"] ol').getAttribute('aria-label'), 'Passos do plano');
    const replan = one(root, '.wb-panel-acts [data-action="replan"]');
    assert.equal(texto(replan), 'Replanejar');
    assert.ok(!replan.classList.contains('filled'));
    assert.equal(all(root, '[data-action="plan"]').length, 0);
    noDeadAction(root);
  });

  test('em review: the plan is closed and the PR shows CI, the checks and the review', () => {
    const subject = card(497, { column: 'review', plan: { steps: 3 } });
    const pr = { number: 512, title: 'feat(ui): os filtros do quadro na URL', url: `https://github.com/${REPO}/pull/512`, state: 'OPEN', isDraft: false, ci: 'PENDING', checks: { total: 5, passed: 3, failed: 0, running: 2 }, review: 'REVIEW_REQUIRED' };
    const root = issuePanel({ card: subject, issue: issue(497, { ...withPlan([515, 516, 517], 'CLOSED'), pullRequest: pr }), now: NOW, parts: cardPlanParts(subject, {}) });
    assert.ok(texto(one(root, '[data-section="plan"] h3')).includes('Plano · 3 passos, todos fechados'));
    const items = all(root, '[data-section="plan"] li');
    assert.ok(items.every((li) => li.getAttribute('data-state') === 'closed'));
    const prText = texto(one(root, '[data-section="pr"]'));
    for (const part of ['#512', 'feat(ui): os filtros do quadro na URL', 'CI …', '3 de 5 checks', 'review']) assert.ok(prText.includes(part), part);
    assert.equal(one(root, '[data-section="pr"] a').getAttribute('href'), pr.url);
    assert.equal(all(root, '.wb-panel-acts button').length, 0, 'Em review has no action');
    assert.ok(texto(one(root, '[data-section="pr"]')).includes('CI …'));
  });

  test('the PR tells a passing, a failing, an approved and a merged state', () => {
    const subject = card(497, { column: 'review' });
    const read = (over: Obj) => texto(one(issuePanel({ card: subject, issue: issue(497, { pullRequest: { number: 9, title: 'PR', url: `https://github.com/${REPO}/pull/9`, state: 'OPEN', isDraft: false, ci: 'SUCCESS', checks: null, review: 'APPROVED', ...over } }), now: NOW }), '[data-section="pr"]'));
    const ok = read({});
    assert.ok(ok.includes('CI ✓') && ok.includes('aprovado'));
    const failing = read({ ci: 'FAILURE', review: 'CHANGES_REQUESTED' });
    assert.ok(failing.includes('CI ✕') && failing.includes('ajustes'));
    assert.ok(read({ state: 'MERGED' }).includes('mergeado'));
    assert.ok(read({ isDraft: true }).includes('rascunho'));
  });

  test('comments show an initials avatar hidden from readers, the author, the age and the text', () => {
    const root = issuePanel({ card: card(509), issue: issue(509, { comments, commentsTotal: 2 }), now: NOW });
    const list = all(root, '[data-section="comments"] .wb-panel-comment');
    assert.equal(list.length, 2);
    assert.ok(texto(list[0]!).includes('fernando'));
    assert.ok(texto(list[0]!).includes('há 1 d'));
    assert.ok(texto(list[0]!).includes('Começar pelo painel ao lado.'));
    assert.equal(one(list[0]!, '.wb-panel-avatar').getAttribute('aria-hidden'), 'true');
    assert.equal(texto(one(list[1]!, '.wb-panel-avatar')), 'AN');
    assert.ok(texto(one(root, '[data-section="comments"]')).includes('Comentários · 2'));
    assert.equal(all(root, '[data-section="comments"] a').length, 0, 'every comment is shown');
  });

  test('when GitHub holds more comments than the read carries, a link to GitHub says so', () => {
    const root = issuePanel({ card: card(509), issue: issue(509, { comments, commentsTotal: 7 }), now: NOW });
    const more = one(root, '[data-section="comments"] a');
    assert.equal(texto(more), 'Ver os 7 comentários no GitHub');
    assert.equal(more.getAttribute('href'), `https://github.com/${REPO}/issues/509`);
    assert.equal(more.getAttribute('rel'), 'noopener noreferrer');
  });

  test('a planning in course or a failed one shows in the panel as on the card', () => {
    const running = card(509, { planning: { state: 'running' } });
    const busy = issuePanel({ card: running, issue: issue(509), now: NOW, parts: cardPlanParts(running, {}) });
    assert.equal(texto(one(busy, '.wb-panel-acts [role="status"]')), 'planejando…');
    assert.equal(all(busy, '[data-action="plan"]').length, 0);
    const failed = card(509, { planning: { state: 'failed', reason: 'A sessão de planejamento não abriu a tempo' } });
    const back = issuePanel({ card: failed, issue: issue(509), now: NOW, parts: cardPlanParts(failed, {}) });
    assert.equal(texto(one(back, '.wb-panel-acts [role="alert"]')), 'A sessão de planejamento não abriu a tempo');
    assert.equal(texto(one(back, '.wb-panel-acts [data-action="plan"]')), 'Planejar');
  });

  test('the GitHub link and the close button are named, and the close button and Escape close the panel', () => {
    let closed = 0;
    const root = issuePanel({ card: card(509), issue: issue(509), now: NOW, onClose: () => (closed += 1) });
    const github = one(root, '.wb-panel-head a');
    assert.equal(github.getAttribute('aria-label'), 'Abrir no GitHub');
    assert.equal(github.getAttribute('href'), `https://github.com/${REPO}/issues/509`);
    assert.equal(github.getAttribute('target'), '_blank');
    assert.equal(github.getAttribute('rel'), 'noopener noreferrer');
    const close = one(root, '[data-action="close"]');
    assert.equal(close.getAttribute('aria-label'), 'Fechar o detalhe');
    click(close);
    key(root, 'Escape');
    assert.equal(closed, 2);
  });

  test('the body is text: markup stays text, a fenced block is a code block, paragraphs are split', () => {
    const body = 'Primeiro parágrafo.\n\n<script>alert(1)</script>\n\n```text\nlinha 1\nlinha 2\n```\n\nÚltimo.';
    const root = issuePanel({ card: card(509), issue: issue(509, { body }), now: NOW });
    assert.equal(all(root, 'script').length, 0);
    const section = one(root, '[data-section="description"]');
    assert.ok(texto(section).includes('<script>alert(1)</script>'));
    assert.equal(texto(one(section, 'pre')), 'linha 1 linha 2');
    assert.equal(one(section, 'pre').childNodes.map((n) => n.textContent).join(''), 'linha 1\nlinha 2');
    assert.equal(all(section, 'p').length, 3);
  });

  test('every section is a labelled region and every interactive element has a name', () => {
    const subject = card(506, { plan: { steps: 2 } });
    const root = issuePanel({ card: subject, issue: issue(506, { ...withPlan([520, 521]), comments, commentsTotal: 2 }), now: NOW, parts: cardPlanParts(subject, {}) });
    for (const name of ['description', 'plan', 'pr', 'details', 'comments']) {
      const section = one(root, `[data-section="${name}"]`);
      assert.equal(section.tagName, 'SECTION');
      assert.ok((section.getAttribute('aria-label') ?? '').length > 0, name);
    }
    for (const node of [...all(root, 'button'), ...all(root, 'a')]) assert.ok(labelOf(node).length > 0);
    for (const svg of all(root, 'svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(all(root, 'h1').length, 0, 'the screen already has its h1');
  });

  test('the stage puts the board behind a scrim hidden from readers and the panel on the right', () => {
    const board = new ElementoFalso('div');
    const panel = issuePanel({ card: card(509), issue: issue(509), now: NOW });
    const stage = issuePanelStage({ board, panel });
    const [first, scrim, last] = stage.children;
    assert.equal(first, board);
    assert.equal(scrim!.getAttribute('aria-hidden'), 'true');
    assert.equal(last, panel);
  });
});

describe('the panel while it loads, when it fails and when it is stale (467-1, decisions 1 and 2)', () => {
  test('loading keeps the header and the close button and shows a skeleton body', () => {
    let closed = 0;
    const root = issuePanelLoading({ card: card(509), now: NOW, onClose: () => (closed += 1) });
    assert.equal(root.tagName, 'ASIDE');
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Detalhe da issue #509');
    assert.equal(root.getAttribute('aria-busy'), 'true');
    const head = texto(one(root, '.wb-panel-head'));
    for (const part of ['História', '#509', 'Planejamento · há 3 h']) assert.ok(head.includes(part), part);
    assert.ok(all(root, '.bone').length > 0, 'a skeleton body');
    assert.equal(all(root, '[data-action="plan"]').length, 0, 'no action before the issue is read');
    click(one(root, '[data-action="close"]'));
    key(root, 'Escape');
    assert.equal(closed, 2);
  });

  test('a failed read shows the reason in a red band with Tentar de novo, header and close kept', () => {
    let retried = 0;
    let closed = 0;
    const root = issuePanelFailure({ card: card(509), now: NOW, reason: 'O GitHub não respondeu', onRetry: () => (retried += 1), onClose: () => (closed += 1) });
    assert.equal(root.getAttribute('aria-label'), 'Detalhe da issue #509');
    const band = one(root, '.error-band');
    assert.equal(band.getAttribute('role'), 'alert');
    assert.ok(texto(band).includes('O GitHub não respondeu'));
    const retry = one(root, '.error-band button');
    assert.equal(texto(retry), 'Tentar de novo');
    click(retry);
    click(one(root, '[data-action="close"]'));
    assert.deepEqual([retried, closed], [1, 1]);
    assert.equal(all(root, '.bone').length, 0);
  });

  test('a failed read with no reason still names the failure', () => {
    const root = issuePanelFailure({ card: card(509), now: NOW });
    assert.ok(texto(one(root, '.error-band')).length > 'Tentar de novo'.length);
  });

  test('a stale issue shows the stale band "Mostrando a issue de HH:MM" under the header, with Tentar agora', () => {
    let retried = 0;
    const fetchedAt = new Date(2026, 10, 13, 22, 5).getTime();
    const root = issuePanel({ card: card(509), issue: issue(509, { stale: true, staleReason: 'rate-limit', fetchedAt }), now: NOW, onRetry: () => (retried += 1) });
    const band = one(root, '.wb-stale-band');
    assert.ok(texto(band).includes('Mostrando a issue de 22:05'), texto(band));
    assert.ok(!texto(band).includes('quadro'), 'it is the issue, not the board');
    click(one(band, '[data-action="retry"]'));
    assert.equal(retried, 1);
    assert.equal(all(issuePanel({ card: card(509), issue: issue(509), now: NOW }), '.wb-stale-band').length, 0);
  });
});

describe('the files follow the project rules', () => {
  test('they call nothing outside, write no colour, no inline style, no innerHTML, no fetch, no URL access', () => {
    for (const file of FILES) {
      const text = readFileSync(`${UI_FOLDER}${file}`, 'utf8');
      const urls = (text.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${file} names an external address`);
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${file} writes a colour by hand`);
      assert.doesNotMatch(text, /style=|innerHTML|\bfetch\(/, `${file} uses inline style, innerHTML or fetch`);
      assert.doesNotMatch(text, /\blocation\.|\bhistory\.|URLSearchParams|ctx\.read/, `${file} reads or writes the URL or the API`);
    }
  });

  test('the CSS styles only wb- classes no other stylesheet styles, and the JS uses only classes that exist', () => {
    const classes = (file: string) => new Set([...readFileSync(`${UI_FOLDER}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const frame = classes('shell.css');
    const mine = [...classes('work-board-issue-panel.css')].filter((c) => !frame.has(c));
    assert.ok(mine.length > 20, 'the stylesheet is not empty');
    assert.deepEqual(mine.filter((c) => !c.startsWith('wb-')), [], 'own class without the wb- prefix');
    const others = readdirSync(UI_FOLDER).filter((f) => f.endsWith('.css') && !['work-board-issue-panel.css', 'shell.css', 'brand.css'].includes(f));
    for (const other of others) assert.deepEqual(mine.filter((c) => classes(other).has(c)), [], `work-board-issue-panel.css and ${other} style the same classes`);
    const known = new Set([...mine, ...classes('work-board.css'), ...frame]);
    for (const file of ['screens/work-board-plan.js', 'screens/work-board-issue-panel.js']) {
      const js = readFileSync(`${UI_FOLDER}${file}`, 'utf8');
      const used = new Set([...js.matchAll(/\bwb-[a-z0-9-]+/g)].map((m) => m[0]).filter((c) => !c.endsWith('-')));
      for (const c of used) assert.ok(known.has(c), `${c} of ${file} is in no stylesheet`);
    }
  });

  test('the panel uses colour only through brand variables, and sets no inline style', () => {
    const css = readFileSync(`${UI_FOLDER}work-board-issue-panel.css`, 'utf8');
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    assert.match(css, /var\(--/);
  });
});
