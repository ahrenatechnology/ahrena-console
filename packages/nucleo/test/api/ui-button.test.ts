// The button component (#435): the CSS contract in shell.css (sizes, variants, one look per state, no
// screen redefining it) and the helper that runs an action with busy, done and failed (ui/button-action.js).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { documentoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();
// @ts-expect-error: browser module, plain JavaScript
const { buttonNote, buttonStateOf, plainError, runButtonAction, setBusy, setDisabled, DONE_MS } = await import('../../ui/button-action.js');
// @ts-expect-error: idem
const { el, icon } = await import('../../ui/dom.js');

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(',').map((x) => x.trim()), body: m[2]! }));
const shell = rules(readFileSync(`${UI_FOLDER}shell.css`, 'utf8'));
const bodyOf = (selector: string) => shell.filter((r) => r.selectors.includes(selector)).map((r) => r.body).join(' ');

describe('button CSS contract (shell.css)', () => {
  test('sizes sm 28, md 32 (the default) and lg 40 are the component\'s', () => {
    assert.match(bodyOf('.btn'), /--btn-h:\s*32px/);
    assert.match(bodyOf('.btn.sm'), /--btn-h:\s*28px/);
    assert.match(bodyOf('.btn.lg'), /--btn-h:\s*40px/);
    assert.match(bodyOf('.btn'), /height:\s*var\(--btn-h\)/);
  });

  test('the four variants exist, and danger has a filled form', () => {
    for (const v of ['.btn.outline', '.btn.filled', '.btn.ghost', '.btn.danger', '.btn.danger.filled']) assert.notEqual(bodyOf(v), '', v);
  });

  test('every variant has hover and pressed (:active), and neither applies to a disabled button', () => {
    const hover = shell.flatMap((r) => r.selectors).filter((s) => s.includes(':hover') && s.startsWith('.btn'));
    const active = shell.flatMap((r) => r.selectors).filter((s) => s.includes(':active') && s.startsWith('.btn'));
    for (const v of ['outline', 'filled', 'ghost', 'danger']) {
      assert.ok(hover.some((s) => s.startsWith(`.btn.${v}`)), `hover ${v}`);
      assert.ok(active.some((s) => s.startsWith(`.btn.${v}`)), `active ${v}`);
    }
    for (const s of [...hover, ...active]) assert.match(s, /:not\(:disabled\):not\(\[aria-disabled="true"\]\)/, s);
  });

  test('busy, done, failed and disabled each have one look', () => {
    assert.match(bodyOf('.btn[aria-busy="true"]'), /cursor:\s*progress/);
    assert.match(bodyOf('.btn[aria-busy="true"]:not(:has(.icon))::before'), /animation:\s*btn-spin/);
    assert.match(bodyOf('.btn[aria-busy="true"] .icon'), /animation/);
    assert.notEqual(bodyOf('.btn[data-state="done"]'), '');
    assert.notEqual(bodyOf('.btn[data-state="failed"]'), '');
    const disabled = shell.find((r) => r.selectors.includes('.btn:disabled'));
    assert.ok(disabled?.selectors.includes('.btn[aria-disabled="true"]:not([aria-busy="true"])'));
    assert.match(disabled!.body, /opacity:\s*\.5/);
  });

  test('reduced motion stops both spinners', () => {
    const css = readFileSync(`${UI_FOLDER}shell.css`, 'utf8');
    assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.btn\[aria-busy="true"\]::before[^}]*animation: none/);
  });

  test('no screen sheet redefines the button: size, opacity or cursor of .btn', () => {
    const offenders: string[] = [];
    for (const a of readdirSync(UI_FOLDER, { recursive: true }).map(String).filter((f) => f.endsWith('.css') && f !== 'shell.css' && f !== 'brand.css')) {
      for (const r of rules(readFileSync(`${UI_FOLDER}${a}`, 'utf8'))) {
        for (const sel of r.selectors) {
          const last = sel.split(/[\s>+~]+/).pop() ?? '';
          // The rules of the component itself (`.btn`, `.btn:disabled`, `.btn.outline`…), not a screen's own class.
          if (!/^\.btn\b/.test(last)) continue;
          if (/(^|;|\s)(height|font-size|opacity|cursor)\s*:/.test(r.body)) offenders.push(`${a}: ${sel}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the old per-screen state names are gone: dk-ghost and dk-danger', () => {
    for (const a of readdirSync(UI_FOLDER, { recursive: true }).map(String).filter((f) => /\.(css|js)$/.test(f))) {
      assert.doesNotMatch(readFileSync(`${UI_FOLDER}${a}`, 'utf8'), /\bdk-(ghost|danger)\b/, a);
    }
  });
});

describe('runButtonAction', () => {
  const makeButton = (withIcon: boolean) => {
    const row = el('div', {});
    const button = el('button', { type: 'button', class: 'btn outline' }, withIcon ? icon('refresh') : null, 'Reiniciar');
    row.append(button);
    return { row, button };
  };
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((ok) => (release = ok));
    return { promise, release };
  };
  const settle = () => new Promise((ok) => setTimeout(ok, 0));

  test('busy while it runs: aria-busy and aria-disabled, never `disabled`, the label and the focus stay', async () => {
    for (const withIcon of [false, true]) {
      const { button } = makeButton(withIcon);
      documentoFalso.activeElement = button;
      const g = gate();
      const run = runButtonAction(button, () => g.promise);
      assert.equal(buttonStateOf(button), 'busy');
      assert.equal(button.getAttribute('aria-busy'), 'true');
      assert.equal(button.getAttribute('aria-disabled'), 'true');
      assert.equal(button.hasAttribute('disabled'), false);
      assert.equal(texto(button), 'Reiniciar');
      assert.equal(documentoFalso.activeElement, button);
      g.release();
      assert.equal((await run).ok, true);
      assert.equal(buttonStateOf(button), 'idle');
    }
  });

  test('busyLabel replaces the label while busy and the original comes back', async () => {
    const { button } = makeButton(true);
    const g = gate();
    const run = runButtonAction(button, () => g.promise, { busyLabel: 'Reiniciando…' });
    assert.equal(texto(button), 'Reiniciando…');
    g.release();
    await run;
    assert.equal(texto(button), 'Reiniciar');
    assert.equal(button.querySelectorAll('.icon').length, 1);
  });

  test('a repeated click while busy is ignored: the action runs once', async () => {
    const { button } = makeButton(false);
    const g = gate();
    let calls = 0;
    const action = () => (calls++, g.promise);
    const first = runButtonAction(button, action);
    const second = await runButtonAction(button, action);
    assert.deepEqual(second, { ignored: true });
    g.release();
    await first;
    assert.equal(calls, 1);
  });

  test('a click on a disabled (aria-disabled) button is ignored: the action does not run', async () => {
    const { button } = makeButton(false);
    setDisabled(button, 'Falta escolher a máquina');
    let calls = 0;
    const result = await runButtonAction(button, async () => void calls++);
    assert.deepEqual(result, { ignored: true });
    assert.equal(calls, 0);
    assert.equal(buttonStateOf(button), 'disabled');
    assert.equal(button.getAttribute('aria-busy'), null);
  });

  test('the width lock is released after the done and failed labels are shown, not before', async () => {
    for (const outcome of ['done', 'failed']) {
      const { button } = makeButton(false);
      const labelsAtRelease: string[] = [];
      const style = button.style;
      const original = style.removeProperty.bind(style);
      style.removeProperty = (name: string) => {
        if (name === 'min-width') labelsAtRelease.push(texto(button));
        return original(name);
      };
      const action = outcome === 'done' ? async () => {} : () => Promise.reject(new Error('x'));
      await runButtonAction(button, action, { doneLabel: 'Reiniciado', failedLabel: 'Tentar de novo', doneMs: 1 });
      assert.equal(labelsAtRelease.at(-1), outcome === 'done' ? 'Reiniciado' : 'Tentar de novo');
      await settle();
    }
  });

  test('done: data-state="done" with the done label, then back to normal after doneMs', async () => {
    const { button } = makeButton(true);
    const result = await runButtonAction(button, async () => 'ok', { doneLabel: 'Reiniciado', doneMs: 5 });
    assert.deepEqual(result, { ok: true, value: 'ok' });
    assert.equal(buttonStateOf(button), 'done');
    assert.equal(texto(button), 'Reiniciado');
    await new Promise((ok) => setTimeout(ok, 15));
    assert.equal(buttonStateOf(button), 'idle');
    assert.equal(texto(button), 'Reiniciar');
    assert.ok(DONE_MS > 0);
  });

  test('without a done label the button simply goes back to normal', async () => {
    const { button } = makeButton(false);
    await runButtonAction(button, async () => {});
    assert.equal(button.getAttribute('data-state'), null);
    assert.equal(texto(button), 'Reiniciar');
  });

  test('failed: the button says "Tentar de novo", a note beside it says what went wrong in plain words', async () => {
    const { row, button } = makeButton(false);
    const result = await runButtonAction(button, async () => {
      throw new Error('O Docker não respondeu. Nada foi reiniciado.');
    });
    assert.equal(result.ok, false);
    assert.equal(buttonStateOf(button), 'failed');
    assert.equal(texto(button), 'Tentar de novo');
    const note = row.querySelector('.btn-note');
    assert.equal(note?.getAttribute('role'), 'alert');
    assert.equal(note?.getAttribute('data-tone'), 'error');
    assert.equal(texto(note), 'O Docker não respondeu. Nada foi reiniciado.');
    assert.equal(row.children.indexOf(note!), row.children.indexOf(button) + 1);
  });

  test('the next click clears the failure and runs again', async () => {
    const { row, button } = makeButton(false);
    await runButtonAction(button, async () => Promise.reject(new Error('falhou')));
    const g = gate();
    const run = runButtonAction(button, () => g.promise);
    assert.equal(row.querySelector('.btn-note'), null);
    assert.equal(button.getAttribute('data-state'), null);
    assert.equal(buttonStateOf(button), 'busy');
    g.release();
    await run;
  });

  test('an error without words gets the fallback; a note the screen gave is used and emptied, not removed', async () => {
    const { button } = makeButton(false);
    const holder = el('span', {});
    await runButtonAction(button, () => Promise.reject({}), { note: holder });
    assert.equal(texto(holder), plainError(null));
    assert.match(plainError(undefined), /Tente de novo/);
    await runButtonAction(button, async () => {});
    assert.equal(texto(holder), '');
  });

  test('an AbortError is not a failure', async () => {
    const { row, button } = makeButton(false);
    const result = await runButtonAction(button, () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    assert.equal(result.ok, false);
    assert.equal(buttonStateOf(button), 'idle');
    assert.equal(row.querySelector('.btn-note'), null);
  });
});

describe('disabled with its reason and the note', () => {
  test('setDisabled puts the reason in title, aria-disabled and aria-describedby; null undoes it', () => {
    const button = el('button', { type: 'button', class: 'btn' }, 'Limpar');
    setDisabled(button, 'Já há uma limpeza rodando', { describedBy: 'why-1' });
    assert.equal(buttonStateOf(button), 'disabled');
    assert.equal(button.getAttribute('title'), 'Já há uma limpeza rodando');
    assert.equal(button.getAttribute('aria-describedby'), 'why-1');
    setDisabled(button, null);
    assert.equal(buttonStateOf(button), 'idle');
    assert.equal(button.getAttribute('title'), null);
  });

  test('setBusy(false) clears busy and disabled', () => {
    const button = el('button', { type: 'button', class: 'btn' }, 'Ir');
    setBusy(button, true);
    assert.equal(buttonStateOf(button), 'busy');
    setBusy(button, false);
    assert.equal(buttonStateOf(button), 'idle');
  });

  test('buttonNote: an error is announced (role alert), info is polite', () => {
    assert.equal(buttonNote('x', { tone: 'error' }).getAttribute('role'), 'alert');
    const info = buttonNote('x');
    assert.equal(info.getAttribute('role'), 'status');
    assert.equal(info.getAttribute('aria-live'), 'polite');
  });
});
