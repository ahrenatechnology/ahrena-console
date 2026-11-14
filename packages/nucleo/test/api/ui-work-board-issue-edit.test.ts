/* issue 535: the components of the issue panel's edit mode (layer 2), pure render functions in the fake DOM.
One test per state of wireframes 478-1 (edit), 478-2 (conflict) and 478-3 (refused), plus the line diff the conflict
marks. There is no workbench, visual or axe tool in this project (component map: node:test with the fake DOM), so the
accessibility checks are assertions on roles and accessible names. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import {
  conflictView,
  diffLines,
  issueEditPanel,
  refusalBand,
  savedAtLabel,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-issue-edit.js';

instalarDomFalso();

const FILES = ['screens/work-board-issue-edit.js'];
const NOW = new Date(2026, 10, 13, 23, 16, 0).getTime();
const SAVED = new Date(2026, 10, 13, 23, 14, 5).getTime();
const REPO = 'ahrena-technology/example';

type Obj = Record<string, unknown>;
const all = (root: ElementoFalso, selector: string) => root.querySelectorAll(selector);
const one = (root: ElementoFalso, selector: string) => {
  const found = root.querySelector(selector);
  assert.ok(found, `no ${selector}`);
  return found;
};
const click = (node: ElementoFalso) => node.dispatchEvent({ type: 'click' });
const keydown = (node: ElementoFalso, k: string) => node.dispatchEvent({ type: 'keydown', key: k });
const typeInto = (node: ElementoFalso, value: string) => {
  node.value = value;
  node.dispatchEvent({ type: 'input' });
};
const choose = (node: ElementoFalso, value: string) => {
  node.value = value;
  node.dispatchEvent({ type: 'change' });
};
const byName = (root: ElementoFalso, name: string) => {
  const found = [...all(root, '[aria-label]')].find((n) => n.getAttribute('aria-label') === name);
  assert.ok(found, `no control named "${name}"`);
  return found;
};

const BODY = '**Como** Fernando,\n**quero** abrir a issue.\n\n```gherkin\nCenário: Abrir pelo card\n```';
const STEPS = [
  { number: 520, title: 'Rota do detalhe', state: 'OPEN' },
  { number: 521, title: 'Painel lateral', state: 'OPEN' },
  { number: 522, title: 'Plano e PR', state: 'OPEN' },
];

function model(over: Obj = {}): Obj {
  return {
    card: { type: 'story', number: 506, column: 'planning' },
    issue: {
      number: 506,
      url: `https://github.com/${REPO}/issues/506`,
      comments: [
        { author: 'ana-exemplo', body: 'O passo 4 pode ficar para depois.', createdAt: new Date(NOW - 20 * 3_600_000).toISOString() },
        { author: 'voce', body: 'Começar pelo painel.', createdAt: new Date(NOW - 24 * 3_600_000).toISOString() },
      ],
      commentsTotal: 2,
    },
    now: NOW,
    savedAt: SAVED,
    title: 'Abrir a issue no Console a partir do card',
    body: { mode: 'edit', text: BODY, tab: 'write' },
    details: {
      type: { value: 'story', options: [{ value: 'story', label: 'História' }, { value: 'bug', label: 'Bug' }] },
      milestone: { value: 'M3', options: [{ value: 'M3', label: 'M3 · Quadro do trabalho' }, { value: 'M4', label: 'M4 · Fila' }] },
      parent: { value: '6', options: [{ value: '6', label: '#6 Quadro do trabalho' }, { value: '7', label: '#7 Fila' }] },
      labels: { values: ['ui', 'work-board'], options: ['ui', 'work-board', 'docs'] },
    },
    plan: { steps: STEPS, editing: null, adding: null, removed: null },
    comment: { text: '' },
    busy: null,
    ...over,
  };
}
const panel = (over: Obj = {}) => issueEditPanel(model(over));

describe('the line diff', () => {
  test('equal texts mark nothing, on either side', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    assert.deepEqual(d.mine, [{ text: 'a', changed: false }, { text: 'b', changed: false }, { text: 'c', changed: false }]);
    assert.deepEqual(d.theirs, d.mine);
  });

  test('a line only in mine is marked in mine, and the line only in theirs in theirs', () => {
    const d = diffLines('a\nb\nmine', 'a\nb\ntheirs');
    assert.deepEqual(d.mine.map((l: Obj) => l.changed), [false, false, true]);
    assert.deepEqual(d.theirs.map((l: Obj) => l.changed), [false, false, true]);
    assert.equal(d.mine[2].text, 'mine');
    assert.equal(d.theirs[2].text, 'theirs');
  });

  test('an inserted line in the middle keeps the common lines on both sides unmarked', () => {
    const d = diffLines('a\nnew\nb', 'a\nb');
    assert.deepEqual(d.mine.map((l: Obj) => l.changed), [false, true, false]);
    assert.deepEqual(d.theirs.map((l: Obj) => l.changed), [false, false]);
  });

  test('line endings do not count as a difference, and an empty side marks the whole other side', () => {
    const d = diffLines('a\r\nb', 'a\nb');
    assert.ok(d.mine.every((l: Obj) => !l.changed));
    const e = diffLines('', 'x\ny');
    assert.deepEqual(e.theirs.map((l: Obj) => l.changed), [true, true]);
    assert.ok(e.mine.every((l: Obj) => !l.changed || l.text === ''));
    assert.deepEqual(diffLines(null, undefined), { mine: [{ text: '', changed: false }], theirs: [{ text: '', changed: false }] });
  });

  test('the saved-at label is the local hour, and nothing when the time is unknown', () => {
    assert.equal(savedAtLabel(SAVED), 'gravado no GitHub às 23:14');
    assert.equal(savedAtLabel(new Date(SAVED).toISOString()), 'gravado no GitHub às 23:14');
    assert.equal(savedAtLabel(null), null);
    assert.equal(savedAtLabel('nonsense'), null);
  });
});

describe('the edit mode (478-1)', () => {
  test('the header names the issue, says editando and when GitHub last got a change, and has Concluir and close', () => {
    let done = 0;
    let closed = 0;
    const root = panel({ onDone: () => done++, onClose: () => closed++ });
    assert.equal(root.tagName, 'ASIDE');
    assert.equal(root.getAttribute('role'), 'dialog');
    assert.equal(root.getAttribute('aria-label'), 'Edição da issue #506');
    const head = one(root, '.wb-edit-head');
    const text = texto(head);
    for (const part of ['História', '#506', 'editando', 'gravado no GitHub às 23:14', 'Concluir']) assert.ok(text.includes(part), `${part} in ${text}`);
    assert.equal(one(head, '.wb-edit-saved').getAttribute('role'), 'status');
    click(one(head, '[data-action="done"]'));
    click(one(head, '[data-action="close"]'));
    assert.deepEqual([done, closed], [1, 1]);
    assert.equal(one(head, '[data-action="close"]').getAttribute('aria-label'), 'Fechar o detalhe');
    assert.ok(!texto(panel({ savedAt: null })).includes('gravado no GitHub'), 'no saved label before a change reached GitHub');
  });

  test('the title is a named field that saves on Enter and reports what is typed', () => {
    const typed: string[] = [];
    const saved: string[] = [];
    const root = panel({ onTitle: (v: string) => typed.push(v), onTitleSave: (v: string) => saved.push(v) });
    const input = byName(root, 'Título da issue');
    assert.equal(input.tagName, 'INPUT');
    assert.equal(input.value, 'Abrir a issue no Console a partir do card');
    typeInto(input, 'Novo título');
    keydown(input, 'Enter');
    assert.deepEqual(typed, ['Novo título']);
    assert.deepEqual(saved, ['Novo título']);
  });

  test('the description has Escrever and Pré-visualizar as tabs, the editor as the panel, Salvar descrição, Cancelar and the Markdown hint', () => {
    const tabs: string[] = [];
    let saved = 0;
    let canceled = 0;
    const typed: string[] = [];
    const root = panel({ body: { mode: 'edit', text: BODY, tab: 'write', onTab: (t: string) => tabs.push(t), onText: (v: string) => typed.push(v), onSave: () => saved++, onCancel: () => canceled++ } });
    const list = one(root, '[role="tablist"]');
    const [write, preview] = all(list, '[role="tab"]');
    assert.deepEqual([texto(write!), texto(preview!)], ['Escrever', 'Pré-visualizar']);
    assert.deepEqual([write!.getAttribute('aria-selected'), preview!.getAttribute('aria-selected')], ['true', 'false']);
    assert.equal(write!.getAttribute('tabindex'), '0');
    assert.equal(preview!.getAttribute('tabindex'), '-1');
    const pane = one(root, '[role="tabpanel"]');
    assert.equal(pane.getAttribute('aria-labelledby'), write!.getAttribute('id'));
    assert.equal(write!.getAttribute('aria-controls'), pane.getAttribute('id'));
    const area = one(pane, 'textarea');
    assert.equal(area.value, BODY);
    assert.equal(area.getAttribute('aria-label'), 'Descrição da issue (Markdown)');
    typeInto(area, 'x');
    assert.deepEqual(typed, ['x']);
    click(preview!);
    keydown(write!, 'ArrowRight');
    assert.deepEqual(tabs, ['preview', 'preview']);
    const save = one(root, '[data-action="save-body"]');
    assert.equal(texto(save), 'Salvar descrição');
    click(save);
    click(one(root, '[data-action="cancel-body"]'));
    assert.deepEqual([saved, canceled], [1, 1]);
    assert.ok(texto(one(root, '[data-section="description"]')).includes('Markdown'));
  });

  test('Pré-visualizar shows the body as text, never as HTML', () => {
    const evil = 'Olá <img src=x onerror=alert(1)> **negrito**\n\n```\n<script>boom()</script>\n```';
    const root = panel({ body: { mode: 'edit', text: evil, tab: 'preview' } });
    const [write, preview] = all(root, '[role="tab"]');
    assert.deepEqual([write!.getAttribute('aria-selected'), preview!.getAttribute('aria-selected')], ['false', 'true']);
    const pane = one(root, '[role="tabpanel"]');
    assert.equal(pane.getAttribute('aria-labelledby'), preview!.getAttribute('id'));
    assert.equal(all(pane, 'textarea').length, 0);
    assert.ok(texto(pane).includes('<img src=x onerror=alert(1)>'));
    assert.ok(texto(pane).includes('<script>boom()</script>'));
    assert.equal(all(root, 'img').length + all(root, 'script').length, 0, 'no element was made from the text');
    assert.equal(all(root, '*').filter((n) => n.innerHTMLFalso !== '' && n.tagName !== 'SVG').length, 0);
  });

  test('the details save on choose: Tipo, Milestone and Pai are named selects, Labels are chips with a remove and a + label', () => {
    const calls: Array<[string, string]> = [];
    const root = panel({
      onType: (v: string) => calls.push(['type', v]),
      onMilestone: (v: string) => calls.push(['milestone', v]),
      onParent: (v: string) => calls.push(['parent', v]),
      onLabelAdd: (v: string) => calls.push(['add', v]),
      onLabelRemove: (v: string) => calls.push(['remove', v]),
    });
    const section = one(root, '[data-section="details"]');
    assert.ok(texto(section).includes('grava ao escolher'));
    for (const [name, value] of [['Tipo', 'bug'], ['Milestone', 'M4'], ['Pai', '7']] as const) {
      const select = byName(section, name);
      assert.equal(select.tagName, 'SELECT');
      choose(select, value);
    }
    assert.equal(byName(section, 'Tipo').getAttribute('aria-label'), 'Tipo');
    const chosen = all(byName(section, 'Pai'), 'option').find((o) => o.hasAttribute('selected'));
    assert.equal(texto(chosen!), '#6 Quadro do trabalho');
    const chips = all(section, '.wb-edit-chip');
    assert.deepEqual(chips.map((c) => texto(c)), ['ui', 'work-board']);
    click(byName(section, 'Tirar a label work-board'));
    const add = byName(section, 'Adicionar uma label');
    assert.deepEqual(all(add, 'option').map((o) => texto(o)), ['+ label', 'docs'], 'only the labels not yet on the issue are offered');
    choose(add, 'docs');
    assert.deepEqual(calls, [['type', 'bug'], ['milestone', 'M4'], ['parent', '7'], ['remove', 'work-board'], ['add', 'docs']]);
  });

  test('the plan lists each step with a handle, its number, title, #N, edit and remove, under the count and the hint', () => {
    const edited: number[] = [];
    const removed: number[] = [];
    const root = panel({ plan: { steps: STEPS, editing: null, adding: null, removed: null, onEdit: (s: Obj) => edited.push(s.number as number), onRemove: (s: Obj) => removed.push(s.number as number) } });
    const section = one(root, '[data-section="plan"]');
    assert.ok(texto(section).includes('Plano · 3 passos'));
    const rows = all(section, 'li[data-number]');
    assert.equal(rows.length, 3);
    const second = rows[1]!;
    assert.equal(texto(one(second, '.wb-edit-step-n')), '2');
    assert.ok(texto(second).includes('Painel lateral'));
    assert.ok(texto(second).includes('#521'));
    assert.equal(one(second, '[data-action="grip"]').getAttribute('aria-label'), 'Reordenar o passo 2: Painel lateral');
    click(byName(second, 'Editar o passo 2: Painel lateral'));
    click(byName(second, 'Remover o passo 2: Painel lateral'));
    assert.deepEqual([edited, removed], [[521], [521]]);
    assert.ok(texto(section).includes('Arraste para reordenar. Remover fecha a sub-issue como “not planned” no GitHub, com Desfazer.'));
    assert.equal(texto(one(section, '[data-action="add-step"]')), 'Acrescentar passo');
    assert.equal(all(section, 'ol').length, 1);
    assert.equal(one(section, 'ol').getAttribute('aria-label'), 'Passos do plano');
  });

  test('one step is open for editing: an input with the title and Salvar, which Enter also does, and Escape cancels', () => {
    const typed: string[] = [];
    const log: string[] = [];
    const root = panel({
      plan: { steps: STEPS, editing: { number: 521, text: 'Painel lateral' }, adding: null, removed: null, onEditText: (v: string) => typed.push(v), onEditSave: () => log.push('save'), onEditCancel: () => log.push('cancel') },
    });
    const open = all(root, 'li.wb-edit-editing');
    assert.equal(open.length, 1);
    assert.equal(open[0]!.getAttribute('data-number'), '521');
    const input = byName(open[0]!, 'Título do passo 2');
    assert.equal(input.value, 'Painel lateral');
    typeInto(input, 'Painel lateral, com Editar');
    keydown(input, 'Enter');
    keydown(input, 'Escape');
    click(one(open[0]!, '[data-action="save-step"]'));
    assert.deepEqual(typed, ['Painel lateral, com Editar']);
    assert.deepEqual(log, ['save', 'cancel', 'save']);
    assert.equal(texto(one(open[0]!, '[data-action="save-step"]')), 'Salvar');
  });

  test('Acrescentar passo opens a new row with an input and Salvar', () => {
    const log: string[] = [];
    const root = panel({ plan: { steps: STEPS, editing: null, adding: { text: 'Teste de ponta a ponta' }, removed: null, onAddText: (v: string) => log.push(`text:${v}`), onAddSave: () => log.push('save'), onAddCancel: () => log.push('cancel') } });
    const row = one(root, 'li.wb-edit-new-step');
    const input = byName(row, 'Título do novo passo');
    assert.equal(input.value, 'Teste de ponta a ponta');
    typeInto(input, 'Outro');
    keydown(input, 'Enter');
    keydown(input, 'Escape');
    assert.deepEqual(log, ['text:Outro', 'save', 'cancel']);
    assert.equal(all(root, '[data-action="add-step"]').length, 0, 'the add control is the open row while it is open');
    click(one(row, '[data-action="save-new-step"]'));
    assert.equal(log.at(-1), 'save');
  });

  test('reordering: the handle moves a step with the arrow keys, and a drag from one handle to a row drops it there', () => {
    const moves: Array<[number, number]> = [];
    const root = panel({ plan: { steps: STEPS, editing: null, adding: null, removed: null, onMove: (s: Obj, to: number) => moves.push([s.number as number, to]) } });
    const rows = all(root, 'li[data-number]');
    const grip = (i: number) => one(rows[i]!, '[data-action="grip"]');
    keydown(grip(1), 'ArrowUp');
    keydown(grip(1), 'ArrowDown');
    keydown(grip(0), 'ArrowUp');
    keydown(grip(2), 'ArrowDown');
    assert.deepEqual(moves, [[521, 0], [521, 2]], 'the ends stay put');
    grip(0).dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {}, effectAllowed: '' } });
    rows[2]!.dispatchEvent({ type: 'dragover' });
    rows[2]!.dispatchEvent({ type: 'drop' });
    assert.deepEqual(moves.at(-1), [520, 2]);
    assert.equal(grip(0).getAttribute('draggable'), 'true');
  });

  test('after a remove, a notice with Desfazer reopens the step', () => {
    let undone = 0;
    const root = panel({ plan: { steps: STEPS.slice(0, 2), editing: null, adding: null, removed: { number: 522, title: 'Plano e PR' }, onUndo: () => undone++ } });
    const notice = one(root, '[data-section="plan"] .wb-edit-notice');
    assert.equal(notice.getAttribute('role'), 'status');
    assert.ok(texto(notice).includes('Plano e PR'));
    assert.ok(texto(notice).includes('removido'));
    assert.ok(texto(root).includes('Plano · 2 passos'));
    click(one(notice, '[data-action="undo"]'));
    assert.equal(undone, 1);
    assert.equal(texto(one(notice, '[data-action="undo"]')), 'Desfazer');
    assert.equal(all(panel(), '.wb-edit-notice').length, 0);
  });

  test('the comments show the existing ones, then the box and Comentar', () => {
    const typed: string[] = [];
    const sent: string[] = [];
    const root = panel({ comment: { text: 'olá', onText: (v: string) => typed.push(v), onSubmit: (v: string) => sent.push(v) } });
    const section = one(root, '[data-section="comments"]');
    assert.ok(texto(section).includes('Comentários · 2'));
    assert.ok(texto(section).includes('ana-exemplo'));
    assert.ok(texto(section).includes('O passo 4 pode ficar para depois.'));
    const box = byName(section, 'Escreva um comentário (Markdown)…');
    assert.equal(box.tagName, 'TEXTAREA');
    assert.equal(box.getAttribute('placeholder'), 'Escreva um comentário (Markdown)…');
    assert.equal(box.value, 'olá');
    typeInto(box, 'novo');
    click(one(section, '[data-action="comment"]'));
    assert.deepEqual(typed, ['novo']);
    assert.deepEqual(sent, ['novo']);
    assert.equal(texto(one(section, '[data-action="comment"]')), 'Comentar');
  });

  test('text from GitHub goes in as text: a title, a step, a label and a comment with markup make no element', () => {
    const markup = '<img src=x onerror=boom()>';
    const root = panel({
      title: markup,
      plan: { steps: [{ number: 9, title: markup, state: 'OPEN' }], editing: null, adding: null, removed: { number: 8, title: markup } },
      details: { ...(model().details as Obj), labels: { values: [markup], options: [markup] } },
      issue: { number: 506, comments: [{ author: markup, body: markup, createdAt: null }], commentsTotal: 1 },
    });
    assert.equal(all(root, 'img').length, 0);
    assert.ok(texto(root).includes(markup));
    assert.equal(byName(root, 'Título da issue').value, markup);
  });

  test('a write in flight disables only the control that sent it and marks it aria-busy', () => {
    const root = panel({ busy: 'save-body' });
    const busy = all(root, '[aria-busy="true"]').filter((n) => n.tagName !== 'ASIDE');
    assert.deepEqual(busy.map((n) => n.getAttribute('data-action')), ['save-body']);
    assert.ok(busy[0]!.hasAttribute('disabled'));
    assert.equal(all(root, '[disabled]').length, 1, 'the others stay usable');
    assert.equal(all(panel({ busy: null }), '[aria-busy="true"]').length, 0);
    const type = panel({ busy: 'type' });
    assert.ok(byName(type, 'Tipo').hasAttribute('disabled'));
    assert.equal(byName(type, 'Tipo').getAttribute('aria-busy'), 'true');
    assert.ok(!texto(root).includes('Salvando'), 'no new text for a write in flight');
  });
});

describe('the conflict (478-2)', () => {
  const conflict = { github: { text: 'a\nb\ntheirs', author: 'ana-exemplo', updatedAt: new Date(NOW - 2 * 60_000).toISOString() } };
  const body = (extra: Obj = {}) => ({ mode: 'conflict', text: 'a\nb\nmine', tab: 'write', conflict, ...extra });

  test('the band says the issue changed and that nothing was written, over two versions with the differing lines marked', () => {
    const root = panel({ body: body() });
    const section = one(root, '[data-section="description"]');
    const band = one(section, '.wb-edit-band');
    assert.equal(band.getAttribute('role'), 'status');
    assert.ok(texto(band).includes('A #506 mudou no GitHub enquanto você editava.'));
    assert.ok(texto(band).includes('Nada foi gravado por cima. Escolha a versão que fica.'));
    const [mine, theirs] = all(section, '.wb-edit-version');
    assert.ok(texto(one(mine!, '.wb-edit-version-title')).includes('A sua versão · não gravada'));
    assert.ok(texto(one(theirs!, '.wb-edit-version-title')).includes('No GitHub · ana-exemplo, há 2 min'));
    assert.deepEqual(all(mine!, '.wb-edit-line').map((l) => texto(l)), ['a', 'b', 'diferente: mine'].map((s) => s));
    const marked = (v: ElementoFalso) => all(v, '.wb-edit-line').filter((l) => l.hasAttribute('data-changed')).map((l) => texto(one(l, 'mark')));
    assert.deepEqual(marked(mine!), ['mine']);
    assert.deepEqual(marked(theirs!), ['theirs']);
    assert.ok(texto(theirs!).includes('diferente'), 'a cue that is not colour');
    assert.equal(all(mine!, '.wb-edit-line').filter((l) => !l.hasAttribute('data-changed')).every((l) => !texto(l).includes('diferente')), true);
    assert.equal(mine!.getAttribute('role'), 'group');
  });

  test('without an author, the GitHub version says only how long ago', () => {
    const root = conflictView({ issueNumber: 506, mine: 'x', conflict: { github: { text: 'y', updatedAt: new Date(NOW - 2 * 60_000).toISOString() } }, now: NOW });
    assert.ok(texto(root).includes('No GitHub · há 2 min'));
  });

  test('there are three exits, plain buttons, none primary and none focused, and the editor is gone while it is open', () => {
    const log: string[] = [];
    const root = panel({ body: body({ onOverwrite: () => log.push('overwrite'), onKeepGithub: () => log.push('github'), onCopyMine: () => log.push('copy') }) });
    const section = one(root, '[data-section="description"]');
    const exits = all(section, '.wb-edit-exits button');
    assert.deepEqual(exits.map((b) => texto(b)), ['Gravar a minha por cima', 'Ficar com a do GitHub', 'Copiar a minha']);
    for (const b of exits) {
      assert.equal(b.getAttribute('type'), 'button');
      assert.ok(!b.classList.contains('filled'), 'none is the primary');
      assert.ok(!b.hasAttribute('autofocus'));
      assert.ok(!b.hasAttribute('disabled'));
    }
    assert.equal(all(root, '[autofocus]').length, 0);
    exits.forEach(click);
    assert.deepEqual(log, ['overwrite', 'github', 'copy']);
    assert.equal(all(section, 'textarea').length, 0);
    assert.equal(all(section, '[data-action="save-body"]').length, 0, 'nothing offers to save while the conflict is open');
  });

  test('the version from GitHub is text: markup in it makes no element', () => {
    const root = conflictView({ issueNumber: 506, mine: 'x', conflict: { github: { text: '<img src=x onerror=boom()>', author: '<b>x</b>', updatedAt: null } }, now: NOW });
    assert.equal(all(root, 'img').length, 0);
    assert.ok(texto(root).includes('<img src=x onerror=boom()>'));
    assert.ok(texto(root).includes('<b>x</b>'), 'the author is text too');
  });

  test('an exit in flight is disabled and aria-busy, the other two are not', () => {
    const root = panel({ body: body(), busy: 'overwrite' });
    const busy = all(root, '.wb-edit-exits button').filter((b) => b.getAttribute('aria-busy') === 'true');
    assert.deepEqual(busy.map((b) => b.getAttribute('data-action')), ['overwrite']);
    assert.ok(busy[0]!.hasAttribute('disabled'));
  });
});

describe('the refusal (478-3)', () => {
  const REASON = 'Sem permissão para editar issues em ahrena-technology/example (403).';
  const body = (extra: Obj = {}) => ({ mode: 'refused', text: `${BODY}\nO texto digitado.`, tab: 'write', reason: REASON, ...extra });

  test('the red band is an alert with the reason in words and says the text stayed', () => {
    const root = panel({ body: body() });
    const band = one(root, '[data-section="description"] .wb-edit-refusal');
    assert.equal(band.getAttribute('role'), 'alert');
    const text = texto(band);
    assert.ok(text.includes('O GitHub recusou a edição.'));
    assert.ok(text.includes(REASON));
    assert.ok(text.includes('O texto continua aqui; nada se perdeu.'));
    assert.equal(texto(refusalBand({ reason: REASON })).includes(REASON), true);
  });

  test('the editor keeps the typed text, with Tentar de novo as the main action, Copiar texto and Cancelar', () => {
    const log: string[] = [];
    const root = panel({ body: body({ onRetry: () => log.push('retry'), onCopy: () => log.push('copy'), onCancel: () => log.push('cancel') }) });
    const section = one(root, '[data-section="description"]');
    assert.equal(one(section, 'textarea').value, `${BODY}\nO texto digitado.`);
    const retry = one(section, '[data-action="retry"]');
    assert.equal(texto(retry), 'Tentar de novo');
    assert.ok(retry.classList.contains('filled'));
    assert.equal(texto(one(section, '[data-action="copy"]')), 'Copiar texto');
    click(retry);
    click(one(section, '[data-action="copy"]'));
    click(one(section, '[data-action="cancel-body"]'));
    assert.deepEqual(log, ['retry', 'copy', 'cancel']);
    assert.equal(all(section, '[data-action="save-body"]').length, 0, 'Tentar de novo takes the place of Salvar');
  });

  test('it never draws a time for a next attempt: the /ui does not retry on its own', () => {
    const root = panel({ body: body({ reason: 'O GitHub não respondeu.' }) });
    assert.doesNotMatch(texto(one(root, '[data-section="description"]')), /próxima tentativa|tentando de novo|\d\d:\d\d/i);
  });

  test('the retry in flight is disabled and aria-busy', () => {
    const root = panel({ body: body(), busy: 'retry' });
    const retry = one(root, '[data-action="retry"]');
    assert.ok(retry.hasAttribute('disabled'));
    assert.equal(retry.getAttribute('aria-busy'), 'true');
    assert.equal(all(root, '[disabled]').length, 1);
  });
});

describe('the files follow the project rules', () => {
  test('they call nothing outside, write no colour, no inline style, no innerHTML, no fetch, no URL access', () => {
    for (const file of FILES) {
      const text = readFileSync(`${UI_FOLDER}${file}`, 'utf8');
      assert.deepEqual(text.match(/https?:\/\/[^\s"'`)]+/g) ?? [], [], `${file} names an external address`);
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${file} writes a colour by hand`);
      assert.doesNotMatch(text, /style=|innerHTML|\bfetch\(/, `${file} uses inline style, innerHTML or fetch`);
      assert.doesNotMatch(text, /\blocation\.|\bhistory\.|URLSearchParams|ctx\.read/, `${file} reads or writes the URL or the API`);
    }
  });

  test('the module has a DOM-free part above a DOM divider and every wb- class it uses is styled', () => {
    const js = readFileSync(`${UI_FOLDER}screens/work-board-issue-edit.js`, 'utf8');
    assert.ok(js.indexOf('// ---------- DOM') > 0, 'a DOM divider');
    assert.doesNotMatch(js.slice(0, js.indexOf('// ---------- DOM')), /\bel\(|document\./, 'the part above the divider touches no DOM');
    const css = readFileSync(`${UI_FOLDER}work-board-issue-panel.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const styled = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const used = [...js.matchAll(/\bwb-[a-z0-9-]+/g)].map((m) => m[0]).filter((c) => !c.endsWith('-'));
    const own = used.filter((c) => c.startsWith('wb-edit-'));
    assert.ok(own.length > 10);
    for (const c of used) assert.ok(styled.has(c) || /^wb-(panel|type|number|pill)/.test(c), `${c} is in no stylesheet`);
    assert.deepEqual(used.filter((c) => !c.startsWith('wb-edit-') && !/^wb-(panel|type|number|pill)/.test(c)), []);
  });
});
