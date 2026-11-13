// The words of the Update button (issue 462, decision 0022 section 7): the table of the decision is the SOURCE and
// this compares the text of every exit with it; every key the classifier can produce has a text; the keys are English.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { classify } from '../../src/telemetry/core-update-protocol.ts';
import { renderUpdateText, textKeyOrFallback, UPDATE_TEXTS, type UpdateTextKey } from '../../src/telemetry/core-update-texts.ts';

const DOC = readFileSync(new URL('../../../../docs/decisoes/0022-remote-core-update-button.md', import.meta.url), 'utf8');
const SECTION = DOC.slice(DOC.indexOf('### 7. O que a tela diz'), DOC.indexOf('### 8.'));
const ROWS = new Map<string, string>();
for (const line of SECTION.split('\n')) {
  const m = /^\| (.+?) \| (.+) \|$/.exec(line);
  if (m && !m[1]!.startsWith('---') && m[1] !== 'Saída') ROWS.set(m[1]!.replace(/`/g, ''), m[2]!);
}
/** The cell as plain text: no code ticks, the version of the example as the placeholder. */
const plain = (s: string) => s.replace(/`/g, '').replace('em <n> s.', 'em <seconds> s.').replace(/0\.0\.17/g, '<newVersion>').replace(/porta 4720/g, 'porta <port>');
const text = (key: UpdateTextKey) => UPDATE_TEXTS[key].replace(/^(.*?)( Nada foi parado\.)$/, '$1');

describe('issue 462 the texts of the Update button', () => {
  test('the table of section 7 was found, row by row', () => {
    for (const code of ['0', '20', '21', '22', '23', '30', '31', '32', '33', '40', '41']) assert.ok(ROWS.has(code), code);
  });

  test('the single-text exits are the table\'s, word for word', () => {
    const single: [string, UpdateTextKey][] = [
      ['0', 'exit-0'], ['20', 'exit-20'], ['21', 'exit-21'], ['22', 'exit-22'], ['23', 'exit-23'], ['31', 'exit-31'], ['33', 'exit-33'], ['40', 'exit-40'], ['41', 'exit-41'],
    ];
    for (const [code, key] of single) assert.ok(plain(ROWS.get(code)!).includes(UPDATE_TEXTS[key]), `${code}: ${UPDATE_TEXTS[key]}`);
  });

  test('the exits that depend on the reason carry the table\'s sentence of each reason, then "Nada foi parado."', () => {
    const c30 = plain(ROWS.get('30')!);
    for (const key of ['exit-30-not-a-checkout', 'exit-30-dirty-tree', 'exit-30-unknown-ref', 'exit-30-new-dependencies'] as const) {
      assert.ok(c30.includes(text(key).replace(/\.$/, '')), key);
      assert.ok(UPDATE_TEXTS[key].endsWith(' Nada foi parado.'), key);
    }
    const c32 = plain(ROWS.get('32')!);
    for (const key of ['exit-32-data-dir-mismatch', 'exit-32-process-mismatch', 'exit-32-no-options'] as const) {
      assert.ok(c32.includes(text(key).replace(/\.$/, '')), key);
      assert.ok(UPDATE_TEXTS[key].endsWith(' Nada foi parado.'), key);
    }
    assert.ok(c30.includes('Sempre: "Nada foi parado."'));
  });

  test('the Mac-side rows: cancel, ssh, timeouts, unknown code', () => {
    const rest = [...ROWS.entries()].filter(([k]) => !/^\d+$/.test(k));
    const byKey: [string, UpdateTextKey][] = [
      ['SSH 255 / sem fase', 'ssh-unreachable'],
      ['tempo antes do swap', 'timeout-before-swap'],
      ['tempo depois do swap', 'timeout-after-swap'],
      ['código desconhecido', 'unknown-exit'],
    ];
    for (const [label, key] of byKey) {
      const row = rest.find(([k]) => plain(k) === label);
      assert.ok(row, label);
      assert.ok(plain(row![1]).includes(UPDATE_TEXTS[key]), `${label}: ${UPDATE_TEXTS[key]}`);
    }
    assert.ok([...ROWS.values()].some((v) => v.includes(UPDATE_TEXTS.canceled)));
  });

  test('carry-in fix: the exit-40 text says "se estava no ar antes", which the wireframe cell lacked', () => {
    assert.match(UPDATE_TEXTS['exit-40'], /O núcleo de lá está no ar como estava, se estava no ar antes\.$/);
  });

  test('every key the classifier can produce has a text of its own, and keys are English words', () => {
    const produced = new Set<string>();
    const reasons = [null, 'dirty-tree', 'unknown-ref', 'new-dependencies', 'not-a-checkout', 'process-mismatch', 'no-options', 'data-dir-mismatch', 'started-failed'];
    for (const kind of ['check', 'update'] as const)
      for (const exitCode of [0, 2, 20, 21, 22, 23, 30, 31, 32, 33, 40, 41, 126, 127, 130, 255, 77, null])
        for (const reason of reasons) for (const phase of [null, 'check', 'swap'] as const) produced.add(classify({ exitCode, reason, phase }, kind).key);
    produced.add(classify({ exitCode: null, reason: null, phase: null, spawnFailed: true }, 'update').key);
    for (const key of produced) assert.ok(key in UPDATE_TEXTS || key.startsWith('exit-30-') || key.startsWith('exit-32-'), key);
    for (const key of Object.keys(UPDATE_TEXTS)) assert.match(key, /^[a-z0-9-]+$/, key);
    // A reason with no text falls back, never to a raw key.
    assert.equal(textKeyOrFallback('exit-30-whatever'), 'unknown-exit');
  });

  test('placeholders are filled; an unknown value is a question mark, never a raw <name>', () => {
    assert.equal(renderUpdateText('exit-41', { backupPath: '/b', oldCommit: 'abc1234' }), 'A atualização falhou e a volta também. A Workstation pode estar sem núcleo. O backup está em /b e o commit anterior era abc1234. Restaure pelo terminal da Workstation, seguindo o runbook.');
    assert.equal(renderUpdateText('exit-41', {}).includes('<'), false);
    assert.equal(renderUpdateText('unknown-exit', { n: 77 }), 'O comando saiu com o código 77. Nada na tela é lido da saída.');
  });
});

// Decision 0024 section 4 is the SOURCE of the two texts of what is missing before the core updates itself.
const DOC_0024 = readFileSync(new URL('../../../../docs/decisoes/0024-automatic-remote-core-update.md', import.meta.url), 'utf8');
const SECTION_0024 = DOC_0024.slice(DOC_0024.indexOf('### 4. A tela'), DOC_0024.indexOf('### 5.'));
const ROWS_0024 = new Map<string, string>();
for (const line of SECTION_0024.split('\n')) {
  const m = /^\| `(.+?)` \| "(.+)" \|$/.exec(line);
  if (m) ROWS_0024.set(m[1]!, m[2]!);
}

describe('issue 484 the texts of what is missing, from decision 0024', () => {
  test('#484/AC-1 the table of 0024 section 4 has both keys, and the texts are the table\'s, word for word', () => {
    assert.deepEqual([...ROWS_0024.keys()].sort(), ['problem-credential-missing', 'problem-missing']);
    for (const key of ['problem-missing', 'problem-credential-missing'] as const) assert.equal(UPDATE_TEXTS[key], ROWS_0024.get(key), key);
  });
});
