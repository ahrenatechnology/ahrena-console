/* issue 535: the state behind the issue panel's edit mode (layer 3): unit tests on the transitions, and interaction tests
that drive issueEditPanel from the state in the fake DOM (no workbench, visual or axe tool in this project). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import {
  addLabel,
  bodyMode,
  cancelBody,
  cancelStepEdit,
  chooseMilestone,
  chooseParent,
  chooseTab,
  chooseType,
  copyMine,
  finishEdit,
  keepGithub,
  moveStep,
  overwrite,
  reasonOf,
  refusalPlace,
  rejected,
  reloadFailed,
  reloaded,
  removeLabel,
  removeStep,
  retryWrite,
  saveBody,
  saveNewStep,
  saveStep,
  saveTitle,
  startAddStep,
  startEdit,
  startStepEdit,
  stepCount,
  submitComment,
  textToCopy,
  typeBody,
  typeComment,
  typeNewStep,
  typeStepText,
  typeTitle,
  undoRemove,
  written,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-issue-edit-state.js';
// @ts-expect-error: browser module, plain JavaScript
import { issueEditPanel } from '../../ui/screens/work-board-issue-edit.js';

instalarDomFalso();

const REPO = 'ahrenatechnology/ahrena-console';
type Obj = Record<string, any>;
const step = (n: number, over: Obj = {}): Obj => ({ number: n, title: `Passo ${n}`, url: '', state: 'OPEN', updatedAt: `S${n}`, ...over });
const issue = (over: Obj = {}): Obj => ({
  repo: REPO,
  number: 506,
  title: 'Abrir a issue',
  body: 'texto\nda issue',
  updatedAt: 'T1',
  type: 'story',
  milestone: 'M3',
  labels: ['ui'],
  parents: [{ repo: REPO, number: 6 }],
  comments: [],
  commentsTotal: 0,
  plan: { count: 3, steps: [step(520), step(521), step(522)] },
  ...over,
});
const open = (over: Obj = {}): Obj => startEdit(issue(over));
/** The write the state asks for, then the answer the core gives. (issue 535) */
const asked = (s: Obj) => {
  assert.ok(s.request, 'a request was expected');
  return s.request;
};
const answered = (s: Obj, over: Obj = {}, at = 1_000) => written(s, issue(over), asked(s).id, at);
const fail = (s: Obj, failure: Obj) => rejected(s, failure, asked(s).id);

describe('AC-1: the fields save through the core and the panel shows GitHub answer', () => {
  test('Editar opens on the issue as GitHub holds it, with nothing in flight', () => {
    const s = open();
    assert.equal(s.open, true);
    assert.equal(s.title, 'Abrir a issue');
    assert.equal(s.body.text, 'texto\nda issue');
    assert.equal(s.body.tab, 'write');
    assert.equal(s.busy, null);
    assert.equal(s.request, null);
    assert.equal(s.savedAt, null);
    assert.equal(bodyMode(s), 'edit');
  });

  test('Enter on the title sends PATCH with the title and the version it was opened at; the panel shows the answer', () => {
    const s0 = saveTitle(typeTitle(open(), '  Novo título '));
    assert.deepEqual(s0.request.body, { repo: REPO, number: 506, title: 'Novo título', updatedAt: 'T1' });
    assert.equal(s0.request.method, 'PATCH');
    assert.equal(s0.request.route, '/api/work/issue');
    assert.equal(s0.busy, 'save-title');
    const s1 = answered(s0, { title: 'Título do GitHub', updatedAt: 'T2' }, 5_000);
    assert.equal(s1.title, 'Título do GitHub');
    assert.equal(s1.savedAt, 5_000);
    assert.equal(s1.busy, null);
    assert.equal(s1.request, null);
    assert.equal(s1.bases.title, 'T2');
  });

  test('a blank or unchanged title writes nothing', () => {
    assert.equal(saveTitle(typeTitle(open(), '   ')).request, null);
    assert.equal(saveTitle(open()).request, null);
  });

  test('Salvar descrição sends the body with its version; the preview tab is only a view', () => {
    const typed = typeBody(open(), 'novo\ntexto');
    assert.equal(chooseTab(typed, 'preview').body.tab, 'preview');
    assert.equal(chooseTab(typed, 'other').body.tab, 'write');
    assert.equal(chooseTab(typed, 'preview').request, null);
    const s = saveBody(typed);
    assert.deepEqual(s.request.body, { repo: REPO, number: 506, body: 'novo\ntexto', updatedAt: 'T1' });
    assert.equal(s.busy, 'save-body');
    const done = answered(s, { body: 'novo\ntexto', updatedAt: 'T2' });
    assert.equal(done.body.text, 'novo\ntexto');
    assert.equal(done.bases.body, 'T2');
  });

  test('an unchanged body writes nothing, and Cancelar returns the description to GitHub is', () => {
    assert.equal(saveBody(open()).request, null);
    assert.equal(cancelBody(typeBody(open(), 'rascunho')).body.text, 'texto\nda issue');
  });

  test('a saved title does not erase the body being typed, and keeps that body its own version', () => {
    const s0 = saveTitle(typeBody(typeTitle(open(), 'Outro'), 'rascunho'));
    const s1 = answered(s0, { title: 'Outro', updatedAt: 'T2' });
    assert.equal(s1.body.text, 'rascunho');
    assert.equal(s1.bases.body, 'T1');
  });

  test('type, milestone and parent save on choose, alone; an unchanged choice and a clear are told apart', () => {
    assert.deepEqual(asked(chooseType(open(), 'bug')).body, { repo: REPO, number: 506, type: 'bug' });
    assert.deepEqual(asked(chooseMilestone(open(), 'M4')).body, { repo: REPO, number: 506, milestone: 'M4' });
    assert.deepEqual(asked(chooseMilestone(open(), '')).body, { repo: REPO, number: 506, milestone: null });
    assert.deepEqual(asked(chooseParent(open(), `${REPO}#7`)).body, { repo: REPO, number: 506, parent: `${REPO}#7` });
    assert.equal(chooseType(open(), 'story').request, null);
    assert.equal(chooseParent(open(), `${REPO}#6`).request, null);
    assert.equal(chooseType(open(), 'bug').busy, 'type');
  });

  test('labels are sent as the whole set: a chosen label added, a chip removed', () => {
    assert.deepEqual(asked(addLabel(open(), 'docs')).body.labels, ['ui', 'docs']);
    assert.deepEqual(asked(removeLabel(open(), 'ui')).body.labels, []);
    assert.equal(addLabel(open(), 'ui').request, null);
    assert.equal(removeLabel(open(), 'nope').request, null);
  });

  test('a comment goes to the comments route and its box empties on the answer; a blank one is not sent', () => {
    assert.equal(submitComment(typeComment(open(), '  ')).request, null);
    const s = submitComment(typeComment(open(), 'Começar pelo painel.'));
    assert.equal(s.request.route, '/api/work/issue/comments');
    assert.deepEqual(s.request.body, { repo: REPO, number: 506, body: 'Começar pelo painel.' });
    const done = answered(s, { commentsTotal: 1 });
    assert.equal(done.comment.text, '');
    assert.equal(done.issue.commentsTotal, 1);
  });

  test('one write at a time: a second control does nothing while one is in flight', () => {
    const s = chooseType(open(), 'bug');
    const again = chooseMilestone(s, 'M4');
    assert.equal(again.request.id, s.request.id);
    assert.equal(again.busy, 'type');
  });

  test('an answer for an older request is ignored', () => {
    const s = chooseType(open(), 'bug');
    assert.equal(written(s, issue({ type: 'bug' }), s.request.id + 1, 1), s);
    assert.equal(rejected(s, { status: 502, error: 'github-refused' }, 99), s);
  });

  test('Concluir leaves the edit mode, but not while a write is in flight or a conflict waits', () => {
    assert.equal(finishEdit(open()).open, false);
    assert.equal(finishEdit(chooseType(open(), 'bug')).open, true);
    const conflict = fail(saveBody(typeBody(open(), 'a')), { status: 409, error: 'conflict', body: 'b', updatedAt: 'T9' });
    assert.equal(finishEdit(conflict).open, true);
  });
});

describe('AC-2: the plan steps are edited, reordered, added and removed', () => {
  test('editing a step sends PATCH with the step key, its own version and the new title', () => {
    const s0 = typeStepText(startStepEdit(open(), 521), 'Painel lateral novo');
    assert.deepEqual(s0.steps.editing, { number: 521, text: 'Painel lateral novo', base: 'S521' });
    const s1 = saveStep(s0);
    assert.equal(s1.request.route, '/api/work/issue/steps');
    assert.equal(s1.request.method, 'PATCH');
    assert.deepEqual(s1.request.body, { repo: REPO, number: 506, step: `${REPO}#521`, updatedAt: 'S521', title: 'Painel lateral novo' });
    assert.equal(s1.busy, 'save-step');
    const steps = [step(520), step(521, { title: 'Painel lateral novo', updatedAt: 'S521b' }), step(522)];
    const s2 = answered(s1, { plan: { count: 3, steps } });
    assert.equal(s2.steps.editing, null);
    assert.equal(s2.issue.plan.steps[1].title, 'Painel lateral novo');
  });

  test('Escape or an unchanged title closes the field and writes nothing', () => {
    const s = startStepEdit(open(), 521);
    assert.equal(saveStep(s).request, null);
    assert.equal(cancelStepEdit(s).steps.editing, null);
    assert.equal(saveStep(typeStepText(s, '  ')).request, null);
  });

  test('a step with no updatedAt asks for a reload with ?refresh=1 and does not open the field', () => {
    const s = startStepEdit(open({ plan: { count: 1, steps: [step(520, { updatedAt: '' })] } }), 520);
    assert.equal(s.steps.editing, null);
    assert.equal(s.request, null);
    assert.equal(s.reload.url, `/api/work/issue?repo=${encodeURIComponent(REPO)}&number=506&refresh=1`);
    const again = startStepEdit(s, 520);
    assert.equal(again.reload.id, s.reload.id, 'one reload at a time');
    const fresh = reloaded(s, issue({ plan: { count: 1, steps: [step(520, { updatedAt: 'S1' })] } }), s.reload.id);
    assert.equal(fresh.reload, null);
    assert.equal(startStepEdit(fresh, 520).steps.editing.base, 'S1');
  });

  test('a title with no updatedAt asks for a reload before writing', () => {
    const s = saveTitle(typeTitle(open({ updatedAt: '' }), 'Outro'));
    assert.equal(s.request, null);
    assert.ok(s.reload);
  });

  test('adding a step sends POST with its title; blank sends nothing; the new step comes with the answer', () => {
    assert.equal(saveNewStep(typeNewStep(startAddStep(open()), '  ')).request, null);
    const s = saveNewStep(typeNewStep(startAddStep(open()), 'Quarto passo'));
    assert.equal(s.request.method, 'POST');
    assert.equal(s.request.route, '/api/work/issue/steps');
    assert.deepEqual(s.request.body, { repo: REPO, number: 506, title: 'Quarto passo' });
    const done = answered(s, { plan: { count: 4, steps: [step(520), step(521), step(522), step(523, { title: 'Quarto passo' })] } });
    assert.equal(done.steps.adding, null);
    assert.equal(stepCount(done), 4, 'the card shows the new count');
  });

  test('reordering sends the step and the one it goes behind, or null for the top', () => {
    assert.deepEqual(asked(moveStep(open(), 522, 0)).body, { repo: REPO, number: 506, step: `${REPO}#522`, after: null });
    assert.deepEqual(asked(moveStep(open(), 520, 2)).body.after, `${REPO}#522`);
    assert.deepEqual(asked(moveStep(open(), 520, 1)).body.after, `${REPO}#521`);
    assert.equal(asked(moveStep(open(), 520, 1)).route, '/api/work/issue/steps/order');
    assert.equal(moveStep(open(), 520, 0).request, null, 'same place');
    assert.equal(moveStep(open(), 520, 3).request, null, 'past the end');
    assert.equal(moveStep(open(), 999, 1).request, null, 'not a step');
  });

  test('removing sends DELETE at once; the notice names the step and the count falls with the answer', () => {
    const s = removeStep(open(), 521);
    assert.equal(s.request.method, 'DELETE');
    assert.deepEqual(s.request.body, { repo: REPO, number: 506, step: `${REPO}#521` });
    assert.equal(s.busy, 'remove:521');
    assert.equal(s.steps.removed, null, 'the notice waits for GitHub');
    const done = answered(s, { plan: { count: 2, steps: [step(520), step(522)] } });
    assert.deepEqual(done.steps.removed, { number: 521, title: 'Passo 521' });
    assert.equal(stepCount(done), 2);
  });

  test('Desfazer posts to the restore route and the notice goes with the answer', () => {
    const removed = answered(removeStep(open(), 521), { plan: { count: 2, steps: [step(520), step(522)] } });
    const s = undoRemove(removed);
    assert.equal(s.request.route, '/api/work/issue/steps/restore');
    assert.equal(s.request.method, 'POST');
    assert.deepEqual(s.request.body, { repo: REPO, number: 506, step: `${REPO}#521` });
    assert.equal(s.busy, 'undo');
    const back = answered(s);
    assert.equal(back.steps.removed, null);
    assert.equal(stepCount(back), 3);
    assert.equal(undoRemove(open()).request, null, 'nothing to undo');
  });

  test('a restore answered 409 not-removed drops the notice and reads the issue again', () => {
    const removed = answered(removeStep(open(), 521), { plan: { count: 2, steps: [step(520), step(522)] } });
    const s = fail(undoRemove(removed), { status: 409, error: 'not-removed' });
    assert.equal(s.steps.removed, null);
    assert.ok(s.reload);
    assert.equal(s.refusal, null);
  });
});

describe('AC-3: a 409 shows both versions, three exits, and writes nothing until the person chooses', () => {
  const conflicted = () => fail(saveBody(typeBody(open(), 'a minha')), { status: 409, error: 'conflict', title: 'T', body: 'a do GitHub', updatedAt: 'T9' });

  test('the conflict keeps both versions, nothing is in flight and the editor is in conflict mode', () => {
    const s = conflicted();
    assert.equal(bodyMode(s), 'conflict');
    assert.deepEqual(s.conflict, { field: 'body', number: null, mine: 'a minha', github: { text: 'a do GitHub', updatedAt: 'T9' } });
    assert.equal(s.busy, null);
    assert.equal(s.request, null);
    assert.equal(s.refusal, null);
  });

  test('every write is refused while the conflict stands, and Copiar a minha leaves it open', () => {
    const s = conflicted();
    for (const next of [saveBody(s), saveTitle(typeTitle(s, 'x')), chooseType(s, 'bug'), addLabel(s, 'docs'), submitComment(typeComment(s, 'c')), removeStep(s, 520), moveStep(s, 520, 2), retryWrite(s)]) assert.equal(next.request, null);
    assert.equal(copyMine(s).conflict, s.conflict);
    assert.equal(textToCopy(s), 'a minha');
  });

  test('Gravar a minha por cima writes the person text with GitHub version, only on that choice', () => {
    const s = overwrite(conflicted());
    assert.deepEqual(s.request.body, { repo: REPO, number: 506, body: 'a minha', updatedAt: 'T9' });
    assert.equal(s.conflict, null);
    assert.equal(s.busy, 'save-body');
    const done = answered(s, { body: 'a minha', updatedAt: 'T10' });
    assert.equal(done.body.text, 'a minha');
  });

  test('Ficar com a do GitHub takes its text and version and writes nothing', () => {
    const s = keepGithub(conflicted());
    assert.equal(s.request, null);
    assert.equal(s.conflict, null);
    assert.equal(s.body.text, 'a do GitHub');
    assert.equal(s.bases.body, 'T9');
    assert.equal(bodyMode(s), 'edit');
  });

  test('a title conflict and a step conflict have the same three exits', () => {
    const t = fail(saveTitle(typeTitle(open(), 'Minha')), { status: 409, error: 'conflict', title: 'Deles', body: 'b', updatedAt: 'T9' });
    assert.equal(t.conflict.field, 'title');
    assert.deepEqual(asked(overwrite(t)).body, { repo: REPO, number: 506, title: 'Minha', updatedAt: 'T9' });
    assert.equal(keepGithub(t).title, 'Deles');
    const p = fail(saveStep(typeStepText(startStepEdit(open(), 521), 'Minha')), { status: 409, error: 'conflict', title: 'Deles', body: '', updatedAt: 'S9' });
    assert.equal(p.conflict.field, 'step');
    assert.deepEqual(asked(overwrite(p)).body, { repo: REPO, number: 506, step: `${REPO}#521`, updatedAt: 'S9', title: 'Minha' });
    const kept = keepGithub(p);
    assert.equal(kept.issue.plan.steps[1].title, 'Deles');
    assert.equal(kept.issue.plan.steps[1].updatedAt, 'S9');
    assert.equal(kept.steps.editing, null);
  });

  test('no exit does anything when there is no conflict', () => {
    const s = open();
    assert.equal(overwrite(s), s);
    assert.equal(keepGithub(s), s);
  });
});

describe('AC-4: a refusal keeps the text, says why, and offers Tentar de novo and Copiar texto', () => {
  const refused = () => fail(saveBody(typeBody(open(), 'meu texto')), { status: 502, error: 'github-refused', reason: 'no-permission' });

  test('the text stays in the editor, the band is up with a reason in pt-BR, and nothing is in flight', () => {
    const s = refused();
    assert.equal(bodyMode(s), 'refused');
    assert.equal(s.body.text, 'meu texto');
    assert.equal(s.busy, null);
    assert.equal(s.refusal.control, 'save-body');
    assert.match(s.refusal.reason, /GitHub/);
    assert.equal(s.reload, null, 'a refusal needs no reload');
  });

  test('Copiar texto gives the text of the field that was refused', () => {
    assert.equal(textToCopy(refused()), 'meu texto');
    assert.equal(textToCopy(fail(saveTitle(typeTitle(open(), 'Meu')), { status: 502, error: 'github-refused' })), 'Meu');
    assert.equal(textToCopy(fail(submitComment(typeComment(open(), 'oi')), { status: 502, error: 'github-refused' })), 'oi');
    assert.equal(textToCopy(open()), null);
  });

  test('Tentar de novo is the person click: it repeats the same write once, with a new id', () => {
    const s = refused();
    const r = retryWrite(s);
    assert.deepEqual(r.request.body, { repo: REPO, number: 506, body: 'meu texto', updatedAt: 'T1' });
    assert.notEqual(r.request.id, s.last.id);
    assert.equal(r.refusal, null);
    assert.equal(r.busy, 'save-body');
    assert.equal(retryWrite(r), r, 'not twice while in flight');
    assert.equal(retryWrite(open()).request, null, 'nothing to retry');
  });

  test('other refusals say their own reason', () => {
    assert.match(reasonOf({ error: 'github-refused', reason: 'no-scope' }), /permissão/);
    assert.match(reasonOf({ error: 'unknown-value', param: 'labels' }), /labels/);
    assert.match(reasonOf({ error: 'not-found' }), /não existe/);
    assert.match(reasonOf({ error: 'off' }), /sem conexão/);
    assert.match(reasonOf({ error: 'bad-param' }), /não conseguiu/);
    const s = fail(addLabel(open(), 'x'), { status: 422, error: 'unknown-value', param: 'labels' });
    assert.match(s.refusal.reason, /labels/);
  });

  test('a successful write clears a standing refusal band', () => {
    const r = retryWrite(refused());
    assert.equal(answered(r, { body: 'meu texto' }).refusal, null);
  });
});

describe('REL-3: no automatic retry after github-unavailable or written-unread', () => {
  test('github-unavailable: the band, the text kept, a reload with ?refresh=1, and no new write', () => {
    const s = fail(saveBody(typeBody(open(), 'meu texto')), { status: 502, error: 'github-unavailable', reason: 'timeout' });
    assert.equal(s.request, null, 'the write is not repeated');
    assert.equal(s.busy, null);
    assert.equal(s.body.text, 'meu texto');
    assert.equal(bodyMode(s), 'refused');
    assert.match(s.reload.url, /refresh=1$/);
    assert.match(s.reload.url, /^\/api\/work\/issue\?/);
  });

  test('the reload answering does not send the write either, and the unsaved text stays', () => {
    const s = fail(saveBody(typeBody(open(), 'meu texto')), { status: 502, error: 'github-unavailable' });
    const r = reloaded(s, issue({ body: 'do GitHub', updatedAt: 'T2' }), s.reload.id);
    assert.equal(r.request, null);
    assert.equal(r.busy, null);
    assert.equal(r.body.text, 'meu texto');
    assert.equal(r.issue.body, 'do GitHub');
    assert.equal(r.refusal.control, 'save-body', 'the band waits for the person');
    assert.equal(reloadFailed(s, s.reload.id).reload, null);
    assert.equal(reloaded(s, issue(), s.reload.id + 1), s, 'a stale reload is ignored');
  });

  test('the reload shows GitHub text for a field the person had not changed', () => {
    const s = fail(chooseType(open(), 'bug'), { status: 502, error: 'github-unavailable' });
    const r = reloaded(s, issue({ type: 'bug', title: 'Mudou lá', updatedAt: 'T2' }), s.reload.id);
    assert.equal(r.title, 'Mudou lá');
    assert.equal(r.issue.type, 'bug');
    assert.equal(r.bases.body, 'T2');
  });

  test('written-unread on a PATCH: GitHub applied it, so a reload, no band, no retry, and the failed write is not kept to repeat', () => {
    const s = fail(chooseType(open(), 'bug'), { status: 502, error: 'written-unread', reason: 'timeout' });
    assert.ok(s.reload);
    assert.equal(s.refusal, null);
    assert.equal(s.request, null);
    assert.equal(s.last, null);
    assert.equal(retryWrite(s).request, null);
    assert.equal(bodyMode(s), 'edit');
  });

  test('a single transition never leaves a request after those errors', () => {
    for (const error of ['github-unavailable', 'written-unread']) {
      const s = fail(removeStep(open(), 521), { status: 502, error, reason: 'timeout' });
      assert.equal(s.request, null);
      assert.equal(s.busy, null);
      assert.ok(s.reload);
    }
  });
});

describe('issue 535 round 2: a write whose outcome is unknown is never offered again (follow-up 544)', () => {
  const unknown = ['github-unavailable', 'written-unread'];
  const creating: Array<[string, (s: Obj) => Obj, string]> = [
    ['comment', () => submitComment(typeComment(open(), 'oi')), 'comment'],
    ['new step', () => saveNewStep(typeNewStep(startAddStep(open()), 'Quarto')), 'plan'],
  ];

  for (const error of unknown) {
    for (const [name, start, place] of creating) {
      test(`${error} on the ${name} POST: band without Tentar de novo, a reload, the text to copy, nothing to repeat`, () => {
        const s = fail(start(open()), { status: 502, error });
        assert.equal(s.refusal.retry, false);
        assert.match(s.refusal.reason, /não sei se a mudança foi gravada/);
        assert.equal(refusalPlace(s), place);
        assert.match(s.reload.url, /refresh=1$/);
        assert.equal(s.request, null);
        assert.equal(s.last, null);
        assert.equal(retryWrite(s).request, null);
        assert.ok(textToCopy(s));
      });
    }
  }

  test('github-unavailable on a PATCH keeps Tentar de novo, only on the person click', () => {
    const s = fail(saveBody(typeBody(open(), 'meu texto')), { status: 502, error: 'github-unavailable' });
    assert.equal(s.refusal.retry, true);
    assert.equal(s.request, null);
    assert.equal(retryWrite(s).request.body.body, 'meu texto');
  });

  test('a refusal from the core on a POST keeps nothing ambiguous: Tentar de novo stays for a plain refusal', () => {
    const s = fail(submitComment(typeComment(open(), 'oi')), { status: 502, error: 'github-refused' });
    assert.equal(s.refusal.retry, true);
  });

  test('the typed text stays after the reload answers, and the band still waits', () => {
    const s = fail(submitComment(typeComment(open(), 'oi')), { status: 502, error: 'github-unavailable' });
    const r = reloaded(s, issue({ commentsTotal: 1 }), s.reload.id);
    assert.equal(r.comment.text, 'oi');
    assert.equal(r.refusal.retry, false);
  });
});

describe('issue 535 round 2: where the refusal band goes, and a conflict on any field', () => {
  const refuse = (s: Obj, error = 'github-refused') => fail(s, { status: 502, error });
  const cases: Array<[string, () => Obj, string]> = [
    ['title', () => saveTitle(typeTitle(open(), 'Outro')), 'title'],
    ['body', () => saveBody(typeBody(open(), 'outro')), 'body'],
    ['type', () => chooseType(open(), 'bug'), 'details'],
    ['milestone', () => chooseMilestone(open(), 'M4'), 'details'],
    ['parent', () => chooseParent(open(), `${REPO}#7`), 'details'],
    ['label', () => addLabel(open(), 'docs'), 'details'],
    ['step edit', () => saveStep(typeStepText(startStepEdit(open(), 521), 'Novo')), 'plan'],
    ['new step', () => saveNewStep(typeNewStep(startAddStep(open()), 'Novo')), 'plan'],
    ['move', () => moveStep(open(), 520, 2), 'plan'],
    ['remove', () => removeStep(open(), 521), 'plan'],
    ['comment', () => submitComment(typeComment(open(), 'oi')), 'comment'],
  ];
  for (const [name, start, place] of cases) {
    test(`a refusal on ${name} goes ${place}, and only the description refusal puts the description editor in refused mode`, () => {
      const s = refuse(start());
      assert.equal(refusalPlace(s), place);
      assert.equal(bodyMode(s), place === 'body' ? 'refused' : 'edit');
      assert.equal(s.refusal.place, place);
    });
  }

  test('Desfazer refused goes to the plan, a 422 too', () => {
    const removed = answered(removeStep(open(), 521), { plan: { count: 2, steps: [step(520), step(522)] } });
    const s = fail(undoRemove(removed), { status: 422, error: 'unknown-value' });
    assert.equal(refusalPlace(s), 'plan');
    assert.equal(bodyMode(s), 'edit');
  });

  test('no refusal, no place', () => {
    assert.equal(refusalPlace(open()), null);
  });

  test('a 409 on the title or on a step edit is the conflict view, not the band', () => {
    const t = fail(saveTitle(typeTitle(open(), 'Minha')), { status: 409, error: 'conflict', title: 'Deles', updatedAt: 'T9' });
    assert.equal(bodyMode(t), 'conflict');
    assert.equal(refusalPlace(t), null);
  });
});

describe('issue 535 round 2: a missing version asks for one reload, then refuses (no endless reload)', () => {
  test('title: the reload still without updatedAt ends in the generic band, and no write', () => {
    const s0 = saveTitle(typeTitle(open({ updatedAt: '' }), 'Outro'));
    assert.ok(s0.reload);
    const s1 = reloaded(s0, issue({ updatedAt: '', title: 'Abrir a issue' }), s0.reload.id);
    const s2 = saveTitle(s1);
    assert.equal(s2.reload, null);
    assert.equal(s2.request, null);
    assert.equal(s2.refusal.reason, reasonOf({}));
    assert.equal(s2.refusal.retry, false);
    assert.equal(refusalPlace(s2), 'title');
    assert.equal(s2.title, 'Outro');
  });

  test('body: the same', () => {
    const s0 = saveBody(typeBody(open({ updatedAt: '' }), 'novo'));
    const s1 = reloaded(s0, issue({ updatedAt: '' }), s0.reload.id);
    const s2 = saveBody(s1);
    assert.equal(s2.reload, null);
    assert.equal(s2.request, null);
    assert.equal(refusalPlace(s2), 'body');
  });

  test('step: the same, and the field stays closed', () => {
    const plan = { count: 1, steps: [step(520, { updatedAt: '' })] };
    const s0 = startStepEdit(open({ plan }), 520);
    const s1 = reloaded(s0, issue({ plan }), s0.reload.id);
    const s2 = startStepEdit(s1, 520);
    assert.equal(s2.reload, null);
    assert.equal(s2.steps.editing, null);
    assert.equal(refusalPlace(s2), 'plan');
  });

  test('a reload that brings the version lets the save through', () => {
    const s0 = saveTitle(typeTitle(open({ updatedAt: '' }), 'Outro'));
    const s1 = reloaded(s0, issue({ updatedAt: 'T5' }), s0.reload.id);
    assert.equal(saveTitle(s1).request.body.updatedAt, 'T5');
  });
});

describe('issue 535 round 2: a conflict is recorded against the request, not the editor', () => {
  test('a 409 on step 521 stays on step 521 when the editor now holds another step', () => {
    const s0 = saveStep(typeStepText(startStepEdit(open(), 521), 'Minha'));
    const moved = { ...s0, steps: { ...s0.steps, editing: { number: 522, text: 'outra', base: 'S522' } } };
    const s = rejected(moved, { status: 409, error: 'conflict', title: 'Deles', updatedAt: 'S9' }, moved.request.id);
    assert.equal(s.conflict.number, 521);
    assert.equal(s.conflict.mine, 'Minha');
    assert.deepEqual(asked(overwrite(s)).body, { repo: REPO, number: 506, step: `${REPO}#521`, updatedAt: 'S9', title: 'Minha' });
    assert.equal(keepGithub(s).steps.editing.number, 522, 'the other field is left alone');
  });

  test('a 409 with no step open does not throw', () => {
    const s0 = saveStep(typeStepText(startStepEdit(open(), 521), 'Minha'));
    const none = { ...s0, steps: { ...s0.steps, editing: null } };
    const s = rejected(none, { status: 409, error: 'conflict', title: 'Deles', updatedAt: 'S9' }, none.request.id);
    assert.equal(s.conflict.number, 521);
    assert.equal(s.conflict.mine, 'Minha');
  });

  test('the text sent is what the conflict keeps, even if the field changed after sending', () => {
    const s0 = saveBody(typeBody(open(), 'enviado'));
    const edited = typeBody(s0, 'digitado depois');
    const s = rejected(edited, { status: 409, error: 'conflict', body: 'deles', updatedAt: 'T9' }, edited.request.id);
    assert.equal(s.conflict.mine, 'enviado');
  });
});

describe('the components driven from the state', () => {
  const find = (root: ElementoFalso, selector: string) => {
    const found = root.querySelector(selector);
    assert.ok(found, `no ${selector}`);
    return found;
  };
  /** The screen in miniature: render the state, let a control change it, render again. (issue 535) */
  function screen(initial: Obj) {
    const box = { s: initial };
    const set = (fn: (s: Obj) => Obj) => () => void (box.s = fn(box.s));
    const render = () => {
      const s = box.s;
      return issueEditPanel({
        card: { type: 'story', number: 506 },
        issue: s.issue,
        savedAt: s.savedAt,
        title: s.title,
        busy: s.busy,
        body: {
          mode: bodyMode(s),
          text: s.body.text,
          tab: s.body.tab,
          reason: s.refusal?.reason,
          conflict: s.conflict ? { github: s.conflict.github } : null,
          onTab: (t: string) => void (box.s = chooseTab(box.s, t)),
          onText: (t: string) => void (box.s = typeBody(box.s, t)),
          onSave: set(saveBody),
          onCancel: set(cancelBody),
          onRetry: set(retryWrite),
          onOverwrite: set(overwrite),
          onKeepGithub: set(keepGithub),
          onCopyMine: set(copyMine),
        },
        details: { type: { value: s.issue.type, options: [{ value: 'story', label: 'História' }, { value: 'bug', label: 'Bug' }] }, labels: { values: s.issue.labels, options: ['ui', 'docs'] } },
        plan: { steps: s.issue.plan.steps, editing: s.steps.editing, adding: s.steps.adding, removed: s.steps.removed, onRemove: (st: Obj) => void (box.s = removeStep(box.s, st.number)), onUndo: set(undoRemove), onMove: (st: Obj, to: number) => void (box.s = moveStep(box.s, st.number, to)) },
        comment: { text: s.comment.text, onText: (t: string) => void (box.s = typeComment(box.s, t)) },
        onTitle: (t: string) => void (box.s = typeTitle(box.s, t)),
        onTitleSave: set(saveTitle),
        onLabelAdd: (l: string) => void (box.s = addLabel(box.s, l)),
        onType: (v: string) => void (box.s = chooseType(box.s, v)),
      });
    };
    return { box, render };
  }

  test('typing the title and pressing Enter makes the title request; the busy control is disabled', () => {
    const { box, render } = screen(open());
    const input = find(render(), '[data-action="save-title"]');
    input.value = 'Novo';
    input.dispatchEvent({ type: 'input' });
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(box.s.request.body.title, 'Novo');
    assert.equal(find(render(), '[data-action="save-title"]').getAttribute('disabled') !== null, true);
  });

  test('the refusal band shows the reason from the state and Tentar de novo sends the write again', () => {
    const s = fail(saveBody(typeBody(open(), 'meu texto')), { status: 502, error: 'github-refused', reason: 'no-permission' });
    const { box, render } = screen(s);
    const root = render();
    assert.equal(find(root, '.wb-edit-refusal').getAttribute('role'), 'alert');
    assert.ok(texto(find(root, '.wb-edit-refusal')).includes('O GitHub não deixou gravar'));
    assert.equal(find(root, '.wb-edit-textarea').value, 'meu texto');
    find(root, '[data-action="retry"]').dispatchEvent({ type: 'click' });
    assert.equal(box.s.request.body.body, 'meu texto');
  });

  test('the conflict shows both versions and the exits; none writes until clicked, then Ficar com a do GitHub writes nothing', () => {
    const s = fail(saveBody(typeBody(open(), 'a minha')), { status: 409, error: 'conflict', body: 'a deles', updatedAt: 'T9' });
    const { box, render } = screen(s);
    const root = render();
    const text = texto(root);
    assert.ok(text.includes('a minha') && text.includes('a deles'));
    assert.equal(box.s.request, null);
    find(root, '[data-action="keep-github"]').dispatchEvent({ type: 'click' });
    assert.equal(box.s.request, null);
    assert.equal(box.s.body.text, 'a deles');
    assert.equal(bodyMode(box.s), 'edit');
  });

  test('removing from the panel sends DELETE and, answered, the notice with Desfazer appears; Desfazer sends the restore', () => {
    const { box, render } = screen(open());
    find(render(), '[data-action="remove-step"]').dispatchEvent({ type: 'click' });
    assert.equal(box.s.request.method, 'DELETE');
    box.s = answered(box.s, { plan: { count: 2, steps: [step(521), step(522)] } });
    const root = render();
    assert.ok(texto(find(root, '.wb-edit-notice')).includes('Passo 520'));
    assert.ok(texto(root).includes('Plano · 2 passos'));
    find(root, '[data-action="undo"]').dispatchEvent({ type: 'click' });
    assert.equal(box.s.request.route, '/api/work/issue/steps/restore');
  });

  test('the "+ label" select adds the chosen label, and the type select saves the type', () => {
    const { box, render } = screen(open());
    const add = find(render(), '.wb-edit-add-label');
    add.value = 'docs';
    add.dispatchEvent({ type: 'change' });
    assert.deepEqual(box.s.request.body.labels, ['ui', 'docs']);
    box.s = answered(box.s, { labels: ['ui', 'docs'] });
    const type = find(render(), '[data-action="type"]');
    type.value = 'bug';
    type.dispatchEvent({ type: 'change' });
    assert.equal(box.s.request.body.type, 'bug');
  });
});
