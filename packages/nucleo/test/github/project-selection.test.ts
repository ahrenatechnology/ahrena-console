// Which Project the kanban shows (#241, decision 0011 §7): `AHRENA_CONSOLE_PROJECT` (env) > the
// installation setting `project.selection` > the demo's (only under --demo) > none. No default
// Project anywhere. The kanban is built for the current selection and rebuilt when it changes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseProjectEnv, PROJECT_ENV, ProjectResolver, ProjectSelectionError } from '../../src/github/project-selection.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';

function resolver(env: Record<string, string> = {}, demoSelection: { owner: string; number: number; field: string } | null = null) {
  const settings = new MemoryInstallationSettings();
  const built: string[] = [];
  const r = new ProjectResolver({
    env,
    settings,
    demoSelection,
    build: (sel) => (built.push(`${sel.owner}/${sel.number}:${sel.field}`), { sel }),
  });
  return { r, settings, built };
}

describe('#241/AC-5 the Project selection', () => {
  test('nothing chosen: no selection, no kanban, no default Project', () => {
    const { r, built } = resolver();
    assert.equal(PROJECT_ENV, 'AHRENA_CONSOLE_PROJECT');
    assert.equal(r.selection(), null);
    assert.equal(r.envOverride(), null);
    assert.equal(r.kanban(), null);
    assert.deepEqual(built, []);
  });

  test('select stores it in the settings; the kanban is built for it and rebuilt only when it changes', () => {
    const { r, settings, built } = resolver();
    const answer = r.select({ owner: 'exemplo', number: 3 });
    assert.deepEqual(answer, { selection: { owner: 'exemplo', number: 3, field: 'Status', from: 'settings' }, envOverride: null });
    assert.deepEqual(settings.get('project.selection'), { owner: 'exemplo', number: 3, field: 'Status' });
    const k = r.kanban();
    assert.equal(r.kanban(), k, 'same selection: same kanban');
    r.select({ owner: 'exemplo', number: 3, field: 'Status' });
    assert.equal(r.kanban(), k);
    r.select({ owner: 'exemplo', number: 3, field: 'Fase' });
    assert.notEqual(r.kanban(), k);
    assert.deepEqual(built, ['exemplo/3:Status', 'exemplo/3:Fase']);
  });

  test('a settings change made elsewhere is picked up on the next read', () => {
    const { r, settings } = resolver();
    settings.set('project.selection', { owner: 'acme', number: 7, field: 'Status' });
    assert.deepEqual(r.selection(), { owner: 'acme', number: 7, field: 'Status', from: 'settings' });
  });

  test('the env wins over the setting and reports the override; selecting still stores the choice', () => {
    const { r, settings } = resolver({ AHRENA_CONSOLE_PROJECT: 'my-org/12' });
    settings.set('project.selection', { owner: 'acme', number: 7, field: 'Status' });
    assert.deepEqual(r.selection(), { owner: 'my-org', number: 12, field: 'Status', from: 'env' });
    assert.deepEqual(r.envOverride(), { variable: 'AHRENA_CONSOLE_PROJECT', value: 'my-org/12' });
    const answer = r.select({ owner: 'other', number: 1 });
    assert.equal(answer.selection.from, 'env');
    assert.deepEqual(settings.get('project.selection'), { owner: 'other', number: 1, field: 'Status' });
  });

  test('the demo selection is the last fallback, from demo', () => {
    const sim = { owner: 'exemplo', number: 3, field: 'Status' };
    const { r, settings } = resolver({}, sim);
    assert.deepEqual(r.selection(), { ...sim, from: 'demo' });
    settings.set('project.selection', { owner: 'acme', number: 7, field: 'Status' });
    assert.equal(r.selection()!.from, 'settings');
    const env = resolver({ AHRENA_CONSOLE_PROJECT: 'my-org/12' }, sim).r;
    assert.equal(env.selection()!.from, 'env');
  });

  test('invalid selections are refused without storing anything', () => {
    const { r, settings } = resolver();
    for (const bad of [
      { owner: '-x', number: 1 },
      { owner: 'a b', number: 1 },
      { owner: 'x', number: 0 },
      { owner: 'x', number: 1.5 },
      { owner: 'x', number: 1_000_000_000 },
      { owner: 'x', number: 1, field: '' },
      { owner: 'x', number: 1, field: 'a'.repeat(101) },
      { owner: 'x', number: 1, field: 'tab\there' },
      { owner: 'x', number: '1' },
      null,
    ]) {
      assert.throws(() => r.select(bad as never), ProjectSelectionError, JSON.stringify(bad));
    }
    assert.equal(settings.get('project.selection'), null);
  });

  test('parseProjectEnv: empty is none; owner/number; anything else throws', () => {
    assert.equal(parseProjectEnv(''), null);
    assert.equal(parseProjectEnv('  '), null);
    assert.deepEqual(parseProjectEnv(' my-org/3 '), { owner: 'my-org', number: 3, field: 'Status' });
    assert.throws(() => parseProjectEnv('my-org'), /AHRENA_CONSOLE_PROJECT/);
    assert.throws(() => new ProjectResolver({ env: { AHRENA_CONSOLE_PROJECT: 'nope' }, settings: new MemoryInstallationSettings(), build: () => null }), /AHRENA_CONSOLE_PROJECT/);
  });

  test('#241/AC-4 reset drops the kanban built with the previous identity', () => {
    const { r, built } = resolver();
    r.select({ owner: 'exemplo', number: 3 });
    const k = r.kanban();
    r.reset();
    assert.notEqual(r.kanban(), k);
    assert.equal(built.length, 2);
  });
});
