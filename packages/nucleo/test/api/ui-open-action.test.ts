// The shared "open the session where it runs" action of the /ui (#285, C70 and C71): what it shows
// per target, what the click sends and the states beside the button. The writer is a stub: nothing
// here reaches a core, a terminal or the Claude Desktop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { documentoFalso, ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// @ts-expect-error: browser module, plain JavaScript
const { describeOpenAction, openAction, openedText, openRoute, stateOfAnswer, SUCCESS_MS } = await import('../../ui/open-action.js');
// @ts-expect-error: idem
const { ICON_NAMES } = await import('../../ui/dom.js');

const UUID = '4d2a9c35-1b7e-4c11-9d0a-2f6c8e1a7b30';
const COMMAND = `cd '/tmp/demo' && claude --resume ${UUID}`;

type Call = { route: string; body: unknown };
/** A writer stub: records the call and answers with `answer` (or throws it, when it is an Error). */
function stubWriter(answer: unknown) {
  const calls: Call[] = [];
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const write = async (route: string, body: unknown) => {
    calls.push({ route, body });
    await gate;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { write, calls, release };
}
function writeError(message: string, status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(message), { name: 'WriteError', status, body });
}
const settle = () => new Promise((ok) => setTimeout(ok, 0));
const byClass = (root: ElementoFalso, c: string) => root.querySelectorAll(`.${c}`);
const clickEvent = () => ({ type: 'click' }) as { type: string; defaultPrevented?: boolean };

describe('open action: what it shows per target', () => {
  test('the five targets: label, icon, title and disabled', () => {
    assert.deepEqual(
      ['desktop', 'terminal', 'terminal-live'].map((target) => {
        const d = describeOpenAction({ target, command: null });
        return [d.label, d.icon, d.title, d.disabled, d.external];
      }),
      [
        ['Abrir no Claude Desktop', 'monitor', 'Abre a conversa no Claude Desktop', false, true],
        ['Abrir no terminal', 'terminal', 'Abre o terminal padrão e roda claude --resume na pasta da sessão', false, true],
        ['Ir para o terminal', 'square-terminal', 'Já roda num terminal; traz a janela à frente', false, false],
      ],
    );
    const remote = describeOpenAction({ target: 'remote', command: null }, { machine: 'ws-exemplo' });
    assert.deepEqual([remote.label, remote.disabled, remote.where, remote.smallLabel], ['Abrir no terminal', true, 'roda em ws-exemplo', 'Roda em ws-exemplo']);
    const unknown = describeOpenAction({ target: 'remote', command: null });
    assert.deepEqual([unknown.where, unknown.smallLabel, unknown.title], ['roda em outra máquina', 'Roda em outra máquina', 'A sessão roda em outra máquina']);
    assert.equal(describeOpenAction({ target: 'none', command: null }), null);
    assert.equal(describeOpenAction(undefined), null);
    for (const t of ['desktop', 'terminal', 'terminal-live']) assert.ok(ICON_NAMES.includes(describeOpenAction({ target: t }).icon));
    assert.ok(ICON_NAMES.includes('server') && ICON_NAMES.includes('external') && ICON_NAMES.includes('copy'));
  });

  test('the success text by `opened`, and the failure keeps the core text and its command', () => {
    assert.deepEqual(['desktop', 'terminal', 'focused'].map(openedText), ['Aberta no Claude Desktop', 'Aberta no terminal', 'Terminal à frente']);
    assert.deepEqual(stateOfAnswer({ ok: true, opened: 'focused' }), { kind: 'ok', text: 'Terminal à frente' });
    assert.deepEqual(stateOfAnswer(null, writeError('Nenhum terminal respondeu', 502, { error: 'x', command: COMMAND })), { kind: 'fail', text: 'Nenhum terminal respondeu', command: COMMAND });
    assert.deepEqual(stateOfAnswer(null, writeError('Sem pasta', 422, { error: 'Sem pasta' })), { kind: 'fail', text: 'Sem pasta', command: null });
    assert.equal(openRoute(UUID), `/api/sessions/${UUID}/open`);
  });

  test('the DOM per size: full has the label and the external mark, small the label, icon only the icon with aria-label', () => {
    const full = openAction({ id: UUID, open: { target: 'desktop', command: null } }, { size: 'full' }) as ElementoFalso;
    const fullButton = full.querySelector('button')!;
    assert.equal(texto(fullButton), 'Abrir no Claude Desktop');
    assert.equal(fullButton.querySelectorAll('svg').length, 2, 'monitor and the external mark');
    assert.equal(full.querySelector('.open-status')!.getAttribute('role'), 'status');
    assert.equal(full.querySelector('.open-status')!.getAttribute('aria-live'), 'polite');

    const small = openAction({ id: UUID, open: { target: 'terminal', command: COMMAND } }, { size: 'small' }) as ElementoFalso;
    assert.equal(texto(small.querySelector('button')), 'Abrir no terminal');
    assert.equal(small.querySelector('button')!.querySelectorAll('svg').length, 1, 'no external mark in the foot');

    const live = openAction({ id: UUID, open: { target: 'terminal-live', command: COMMAND } }, { size: 'icon' }) as ElementoFalso;
    const iconButton = live.querySelector('button')!;
    assert.equal(texto(iconButton), '');
    assert.equal(iconButton.getAttribute('aria-label'), 'Ir para o terminal');
    assert.equal(iconButton.getAttribute('title'), 'Já roda num terminal; traz a janela à frente');

    const remoteFull = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'full' }) as ElementoFalso;
    assert.equal(remoteFull.querySelector('button')!.getAttribute('aria-disabled'), 'true');
    assert.equal(texto(remoteFull), 'Abrir no terminal roda em outra máquina');
    const remoteSmall = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'small', machine: 'ws-exemplo' }) as ElementoFalso;
    assert.equal(texto(remoteSmall), 'Roda em ws-exemplo');
    const remoteIcon = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'icon', machine: 'ws-exemplo' }) as ElementoFalso;
    assert.equal(remoteIcon.querySelector('button')!.getAttribute('title'), 'A sessão roda em ws-exemplo');

    assert.equal(openAction({ id: 'demo-1', open: { target: 'none', command: null } }, { size: 'icon' }), null, 'none: no button at all');
  });
});

describe('open action: the click', () => {
  test('busy "Abrindo…" with the button disabled, then the success beside it, gone after a while', async () => {
    for (const [target, opened, text] of [['desktop', 'desktop', 'Aberta no Claude Desktop'], ['terminal', 'terminal', 'Aberta no terminal'], ['terminal-live', 'focused', 'Terminal à frente']]) {
      const w = stubWriter({ ok: true, opened });
      const root = openAction({ id: UUID, open: { target, command: null } }, { size: 'full', write: w.write, successMs: 20 }) as ElementoFalso;
      const button = root.querySelector('button')!;
      const ev = clickEvent();
      button.dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true);
      assert.deepEqual(w.calls, [{ route: `/api/sessions/${UUID}/open`, body: {} }]);
      assert.equal(texto(root.querySelector('.open-status')), 'Abrindo…');
      assert.ok(button.hasAttribute('disabled'));
      button.click();
      assert.equal(w.calls.length, 1, 'a click while in flight sends nothing');
      w.release();
      await settle();
      assert.ok(!button.hasAttribute('disabled'));
      assert.equal(texto(root.querySelector('.open-status')), text);
      assert.equal(byClass(root, 'open-copy').length, 0);
      await new Promise((ok) => setTimeout(ok, 40));
      assert.equal(texto(root.querySelector('.open-status')), '', 'the success fades');
    }
    assert.equal(SUCCESS_MS, 4000);
  });

  test('an error with a command shows the core text and "Copiar comando", which copies it', async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
    const w = stubWriter(writeError('Nenhum app de terminal respondeu', 502, { error: 'Nenhum app de terminal respondeu', command: COMMAND }));
    w.release();
    const root = openAction({ id: UUID, open: { target: 'terminal', command: COMMAND } }, { size: 'full', write: w.write }) as ElementoFalso;
    root.querySelector('button')!.click();
    await settle();
    assert.equal(texto(root.querySelector('.open-fail')), 'Nenhum app de terminal respondeu');
    const copy = root.querySelector('.open-copy')!;
    assert.equal(texto(copy), 'Copiar comando');
    copy.click();
    await settle();
    assert.deepEqual(copied, [COMMAND], 'the command of the answer, not screen text');
    assert.equal(texto(copy), 'Copiado');
  });

  test('an error without a command shows only the text; the remote button sends nothing', async () => {
    const w = stubWriter(writeError('A sessão não tem pasta para abrir', 422, { error: 'A sessão não tem pasta para abrir' }));
    w.release();
    const root = openAction({ id: UUID, open: { target: 'desktop', command: null } }, { size: 'icon', write: w.write }) as ElementoFalso;
    root.querySelector('button')!.click();
    await settle();
    assert.equal(texto(root.querySelector('.open-status')), 'A sessão não tem pasta para abrir');
    assert.equal(byClass(root, 'open-copy').length, 0);

    const r = stubWriter({ ok: true });
    const remote = openAction({ id: UUID, open: { target: 'remote', command: null } }, { size: 'icon', write: r.write }) as ElementoFalso;
    remote.querySelector('button')!.click();
    assert.equal(r.calls.length, 0);
  });

  test('a click inside the action never reaches the card or row around it', () => {
    const w = stubWriter({ ok: true, opened: 'desktop' });
    const row = documentoFalso.createElement('tr');
    let navigated = 0;
    row.addEventListener('click', () => void navigated++);
    const root = openAction({ id: UUID, open: { target: 'desktop', command: null } }, { size: 'icon', write: w.write }) as ElementoFalso;
    row.append(root);
    root.querySelector('button')!.click();
    root.querySelector('.open-status')!.click();
    assert.equal(navigated, 0);
    assert.equal(w.calls.length, 1);
    w.release();
  });
});

test('open-action.css: only open- classes, no colour by hand, loaded once by index.html', () => {
  const css = readFileSync(`${UI_FOLDER}open-action.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const shell = new Set([...readFileSync(`${UI_FOLDER}shell.css`, 'utf8').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const own = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))].filter((c) => !shell.has(c));
  assert.deepEqual(own.filter((c) => !c.startsWith('open-')), [], 'own class without the open- prefix');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i);
  const page = readFileSync(`${UI_FOLDER}index.html`, 'utf8');
  assert.equal(page.match(/href="\/ui\/open-action\.css"/g)?.length, 1);
});
