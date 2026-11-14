// #532: the state behind "Executar plano" on the work board (layer 3), driving the components of #546.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';
import {
  askRun,
  cancelRun,
  cardWithRun,
  chooseRunTarget,
  closeRunMissingFolder,
  closeRunNotice,
  confirmRun,
  initialRunState,
  reconcileRuns,
  runAccepted,
  runFailed,
  runLimitFull,
  runMissingFolder,
  runNoticeOf,
  runOf,
  sessionIdOf,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-run-state.js';
import {
  cardRunParts,
  runConfirm,
  runNotice,
  runState,
  // @ts-expect-error: browser module, plain JavaScript
} from '../../ui/screens/work-board-run.js';
// @ts-expect-error: browser module, plain JavaScript
import { missingFolder } from '../../ui/screens/work-board-plan.js';

instalarDomFalso();

const REPO = 'ahrenatechnology/ahrena-console';
type Obj = Record<string, any>;
const card = (n: number, over: Obj = {}): Obj => ({
  key: `${REPO}#${n}`,
  repo: REPO,
  number: n,
  title: `Issue ${n}`,
  level: 'item',
  type: 'story',
  column: 'planning',
  plan: { steps: 5 },
  planning: null,
  execution: null,
  sessions: { count: 0, state: null, ids: [] },
  ...over,
});
const one = (root: ElementoFalso, selector: string) => {
  const found = root.querySelector(selector);
  assert.ok(found, `no ${selector}`);
  return found;
};
const click = (node: ElementoFalso) => node.dispatchEvent({ type: 'click' });

describe('opening and cancelling the confirmation (AC-1, AC-2)', () => {
  test('starts with nothing confirming, posting or noticed', () => {
    const s = initialRunState();
    assert.deepEqual(s.runs, {});
    assert.equal(s.post, null);
    assert.equal(s.notice, null);
    assert.equal(runOf(s, card(1)).phase, 'idle');
  });

  test('Executar plano on a card with a plan opens the confirmation on desktop; a queued card with a plan does too', () => {
    for (const column of ['planning', 'queued']) {
      const s = askRun(initialRunState(), card(1, { column }));
      assert.equal(runOf(s, card(1, { column })).phase, 'confirming', column);
      assert.equal(runOf(s, card(1, { column })).target, 'desktop');
    }
  });

  test('no confirmation for an epic, an initiative, a card without a plan, a live card or one already running', () => {
    const s0 = initialRunState();
    for (const over of [{ type: 'epic' }, { type: 'initiative' }, { plan: null }, { plan: { steps: 0 } }, { column: 'done' }, { sessions: { count: 1, state: 'working', ids: ['x'] }, column: 'running' }, { execution: { state: 'booting' } }]) {
      assert.equal(askRun(s0, card(1, over)), s0, JSON.stringify(over));
    }
  });

  test('only one confirmation is anchored at a time; opening another closes the first', () => {
    const s = askRun(askRun(initialRunState(), card(1)), card(2));
    assert.equal(runOf(s, card(1)).phase, 'idle');
    assert.equal(runOf(s, card(2)).phase, 'confirming');
  });

  test('the target is chosen on the confirmation; an unknown target is ignored; Cancelar goes back', () => {
    const s0 = askRun(initialRunState(), card(1));
    const s1 = chooseRunTarget(s0, card(1), 'terminal');
    assert.equal(runOf(s1, card(1)).target, 'terminal');
    assert.equal(chooseRunTarget(s1, card(1), 'browser'), s1);
    assert.equal(chooseRunTarget(initialRunState(), card(1), 'terminal').runs[card(1).key], undefined);
    const s2 = cancelRun(s1, card(1));
    assert.equal(runOf(s2, card(1)).phase, 'idle');
    assert.equal(cancelRun(s2, card(1)), s2);
  });
});

describe('confirming and the answers of POST /api/work/run (AC-2 to AC-4)', () => {
  test('confirming posts { repo, number, target } and the card is busy; a second confirm does nothing', () => {
    const s0 = chooseRunTarget(askRun(initialRunState(), card(506)), card(506), 'terminal');
    const s1 = confirmRun(s0, card(506));
    assert.deepEqual(s1.post, { repo: REPO, number: 506, target: 'terminal' });
    assert.equal(runOf(s1, card(506)).phase, 'posting');
    assert.equal(confirmRun(s1, card(506)), s1);
    assert.equal(confirmRun(initialRunState(), card(506)).post, null);
    assert.equal(cancelRun(s1, card(506)), s1, 'not while posting');
  });

  test('AC-2 200 { ok, opened, key }: booting, the card shows Em execução with "subindo…", and a notice says where it opened', () => {
    const s1 = confirmRun(askRun(initialRunState(), card(506)), card(506));
    const s2 = runAccepted(s1, card(506), { opened: 'terminal' });
    assert.equal(s2.post, null);
    assert.equal(runOf(s2, card(506)).phase, 'booting');
    assert.deepEqual(s2.notice, { key: card(506).key, number: 506, opened: 'terminal' });
    assert.deepEqual(runNoticeOf(s2), { number: 506, opened: 'terminal' });
    const shown = cardWithRun(s2, card(506));
    assert.equal(shown.column, 'running');
    assert.deepEqual(shown.execution, { state: 'booting' });
    assert.equal(runState(shown), 'booting');
    assert.equal(closeRunNotice(s2).notice, null);
    assert.equal(runOf(closeRunNotice(s2), card(506)).phase, 'booting', 'the notice goes, the run stays');
    assert.equal(runAccepted(initialRunState(), card(506), { opened: 'desktop' }).notice, null, 'nothing was posted');
  });

  test('AC-3 409 keeps the confirmation open with the count; confirming again sends force: true', () => {
    const s1 = confirmRun(askRun(initialRunState(), card(506)), card(506));
    const s2 = runLimitFull(s1, card(506), { running: 2, limit: 2 });
    const now = runOf(s2, card(506));
    assert.equal(now.phase, 'confirming');
    assert.deepEqual(now.full, { running: 2, limit: 2 });
    assert.equal(s2.post, null);
    const s3 = confirmRun(s2, card(506));
    assert.deepEqual(s3.post, { repo: REPO, number: 506, target: 'desktop', force: true });
    assert.equal(runOf(s3, card(506)).phase, 'posting');
    const s4 = runAccepted(s3, card(506), { opened: 'desktop' });
    assert.equal(runOf(s4, card(506)).phase, 'booting');
  });

  test('a 409 keeps the target already chosen, and Cancelar after it goes back to the card as it was', () => {
    const s0 = chooseRunTarget(askRun(initialRunState(), card(506, { column: 'queued' })), card(506, { column: 'queued' }), 'terminal');
    const s1 = runLimitFull(confirmRun(s0, card(506, { column: 'queued' })), card(506, { column: 'queued' }), { running: 3, limit: 2 });
    assert.equal(runOf(s1, card(506)).target, 'terminal');
    assert.equal(runOf(cancelRun(s1, card(506)), card(506)).phase, 'idle');
  });

  test('AC-4 501 { error, command }: the missing folder with the command, and Fechar leaves the card where it was', () => {
    const s1 = confirmRun(askRun(initialRunState(), card(506)), card(506));
    const s2 = runMissingFolder(s1, card(506), { message: 'Sem pasta.', command: 'git clone x' });
    const now = runOf(s2, card(506));
    assert.equal(now.phase, 'missing-folder');
    assert.equal(now.command, 'git clone x');
    assert.equal(now.message, 'Sem pasta.');
    assert.equal(s2.post, null);
    assert.equal(cardWithRun(s2, card(506)).execution, null);
    assert.equal(cardWithRun(s2, card(506)).column, 'planning');
    const s3 = closeRunMissingFolder(s2, card(506));
    assert.equal(runOf(s3, card(506)).phase, 'idle');
    assert.equal(closeRunMissingFolder(s3, card(506)), s3);
    assert.equal(runMissingFolder(initialRunState(), card(506), {}).runs[card(506).key], undefined);
  });

  test('other failures (422, 502, 503, network): the core error alone, the card back to its action, planning failed in Planejamento', () => {
    const s1 = confirmRun(askRun(initialRunState(), card(506)), card(506));
    const s2 = runFailed(s1, card(506), 'GitHub não respondeu');
    const now = runOf(s2, card(506));
    assert.equal(now.phase, 'failed');
    assert.equal(now.reason, 'GitHub não respondeu');
    assert.equal(s2.post, null);
    const shown = cardWithRun(s2, card(506));
    assert.deepEqual(shown.planning, { state: 'failed', reason: 'GitHub não respondeu' });
    assert.equal(runState(shown), 'planned', 'back to Executar plano with the reason in the note');
    assert.equal(texto(cardRunParts(shown, {}).note as never), 'GitHub não respondeu');
    assert.equal(runFailed(initialRunState(), card(506), 'x').runs[card(506).key], undefined);
    const again = askRun(s2, card(506));
    assert.equal(runOf(again, card(506)).phase, 'confirming', 'a failed card can be run again');
    assert.equal(runOf(again, card(506)).reason, null);
  });

  test('a failure on a queued card goes back to Executar plano with the reason kept in the state', () => {
    const queued = card(7, { column: 'queued' });
    const s = runFailed(confirmRun(askRun(initialRunState(), queued), queued), queued, null);
    assert.equal(runState(cardWithRun(s, queued)), 'queued');
    assert.equal(runOf(s, queued).reason, null);
  });
});

describe('the core takes over after the next board read (the board data)', () => {
  const booting = () => runAccepted(confirmRun(askRun(initialRunState(), card(506)), card(506)), card(506), { opened: 'desktop' });

  test('a read whose card carries execution booting drops the optimistic run; its notice stays', () => {
    const s = reconcileRuns(booting(), [card(506, { column: 'running', execution: { state: 'booting' } })]);
    assert.equal(runOf(s, card(506)).phase, 'idle');
    assert.ok(s.notice);
  });

  test('a read of a card now in Em execução with a live session also drops it', () => {
    const s = reconcileRuns(booting(), [card(506, { column: 'running', sessions: { count: 1, state: 'working', ids: ['u'] } })]);
    assert.equal(runOf(s, card(506)).phase, 'idle');
  });

  test('a read from before the core recorded the run keeps the booting card', () => {
    const s0 = booting();
    assert.equal(reconcileRuns(s0, [card(506)]), s0);
    assert.equal(reconcileRuns(s0, []), s0);
  });

  test('the core state wins when both exist', () => {
    const core = card(506, { column: 'running', execution: { state: 'booting' } });
    assert.deepEqual(cardWithRun(initialRunState(), core).execution, { state: 'booting' });
  });

  test('a card nothing happened to is returned as it came', () => {
    const c = card(9);
    assert.equal(cardWithRun(initialRunState(), c), c);
  });
});

describe('the session of a live card (AC-5)', () => {
  test('the session id is the first of the card and nothing when there is none', () => {
    assert.equal(sessionIdOf(card(1, { sessions: { count: 2, state: 'working', ids: ['a', 'b'] } })), 'a');
    assert.equal(sessionIdOf(card(1)), null);
  });

  test('Abrir sessão hands the card and the button to the screen, which reads the id from the card', () => {
    const live = card(1, { column: 'running', sessions: { count: 1, state: 'working', ids: ['uuid-1'] } });
    const opened: string[] = [];
    const parts = cardRunParts(live, { onOpenSession: (c: Obj) => opened.push(sessionIdOf(c)) });
    click(one(parts.actions, '[data-action="open-session"]'));
    assert.deepEqual(opened, ['uuid-1']);
  });
});

describe('the components driven through the state (scenario)', () => {
  const REGISTER = { repo: REPO, number: 506 };

  // The screen in miniature: state in a variable, render parts read from it, handlers call the transitions.
  function screen(subject: Obj) {
    let state = initialRunState();
    const set = (next: Obj) => (state = next);
    const view = () => {
      const shown = cardWithRun(state, subject);
      const parts = cardRunParts(shown, { onRun: () => set(askRun(state, subject)) });
      const now = runOf(state, subject);
      const confirm =
        now.phase === 'confirming' || now.phase === 'posting'
          ? runConfirm({ ...REGISTER, target: now.target, full: now.full, busy: now.phase === 'posting', onTarget: (t: string) => set(chooseRunTarget(state, subject, t)), onCancel: () => set(cancelRun(state, subject)), onConfirm: () => set(confirmRun(state, subject)) })
          : now.phase === 'missing-folder'
            ? missingFolder({ repo: REPO, message: now.message, command: now.command, onClose: () => set(closeRunMissingFolder(state, subject)) })
            : null;
      const notice = state.notice ? runNotice({ ...runNoticeOf(state), onClose: () => set(closeRunNotice(state)) }) : null;
      return { parts, confirm, notice };
    };
    return { view, answer: (fn: (s: Obj) => Obj) => set(fn(state)), get state() { return state; } };
  }

  test('press Executar plano, choose Terminal, confirm, receive 409, press Executar mesmo assim, see force, then the card boots', () => {
    const subject = card(506);
    const s = screen(subject);
    click(one(s.view().parts.actions, '[data-action="run"]'));
    const radios = s.view().confirm!.querySelectorAll('[role="radio"]');
    click(radios[1]!);
    assert.equal(s.view().confirm!.querySelectorAll('[role="radio"]')[1]!.getAttribute('aria-checked'), 'true');
    click(one(s.view().confirm!, '[data-action="confirm"]'));
    assert.deepEqual(s.state.post, { repo: REPO, number: 506, target: 'terminal' });
    assert.equal(one(s.view().confirm!, '[data-action="confirm"]').getAttribute('aria-busy'), 'true');
    s.answer((st) => runLimitFull(st, subject, { running: 2, limit: 2 }));
    const full = s.view().confirm!;
    assert.equal(texto(one(full, '[data-action="confirm"]')), 'Executar mesmo assim');
    assert.ok(texto(one(full, '[data-field="limit"]')).includes('2 de 2 rodando'));
    click(one(full, '[data-action="confirm"]'));
    assert.deepEqual(s.state.post, { repo: REPO, number: 506, target: 'terminal', force: true });
    s.answer((st) => runAccepted(st, subject, { opened: 'terminal' }));
    const done = s.view();
    assert.equal(done.confirm, null);
    assert.equal(texto(done.parts.badge!), 'subindo…');
    assert.ok(texto(one(done.notice!, '[data-field="text"]')).includes('Terminal'));
    click(one(done.notice!, '[data-action="close"]'));
    assert.equal(s.view().notice, null);
  });

  test('501 shows the command with Copiar comando and Fechar returns the card to Executar plano', () => {
    const subject = card(506, { column: 'queued' });
    const s = screen(subject);
    click(one(s.view().parts.actions, '[data-action="run"]'));
    click(one(s.view().confirm!, '[data-action="confirm"]'));
    s.answer((st) => runMissingFolder(st, subject, { command: 'git clone x' }));
    const block = s.view().confirm!;
    assert.equal(block.getAttribute('data-kind'), 'folder');
    assert.equal(texto(one(block, '[data-action="copy"]')), 'Copiar comando');
    click(one(block, '[data-action="close"]'));
    const back = s.view();
    assert.equal(back.confirm, null);
    assert.equal(texto(one(back.parts.actions!, '[data-action="run"]')), 'Executar plano');
  });
});
