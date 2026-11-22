// GET /api/tools for the embedded ai-memory (#726): the version, the embedded source, no action.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { macService, wsService } from '../../test/tools/machines.ts';

const EMBEDDED = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';

describe('#719/AC-1 ai-memory in the tools overview', () => {
  test('#719/AC-1 #726/AC-1 lists ai-memory 3.5.1 from the embedded source and offers no install or update', async () => {
    const { service, run } = macService({ run: { [`${EMBEDDED} --version`]: 'ai-memory 3.5.1' }, extra: { embeddedAiMemoryPath: () => EMBEDDED } });
    const o = (await service.overview())!;
    const item = o.items.find((i) => i.id === 'ai-memory')!;
    assert.equal(item.installed, '3.5.1');
    assert.equal(item.source, 'embedded');
    assert.equal(item.manager, 'embutido no console');
    assert.equal(item.state, 'ok');
    assert.deepEqual(item.actions, []);
    assert.ok(run.calls.some((a) => a[0] === EMBEDDED), 'the embedded path was spawned');
    assert.ok(!run.calls.some((a) => a[0] === 'ai-memory'), 'never by name');
    for (const action of ['install', 'update'])
      assert.deepEqual(await service.actionPlan('local', 'ai-memory', action), { kind: 'not-offered' });
  });

  test('#719/AC-1 #726/AC-2 a missing embedded binary is reported as a failed probe, not as not installed, still with no action', async () => {
    const { service } = macService({ extra: { embeddedAiMemoryPath: () => null } });
    const item = (await service.overview())!.items.find((i) => i.id === 'ai-memory')!;
    assert.equal(item.state, 'failed');
    assert.equal(item.installed, null);
    assert.equal(item.source, 'embedded');
    assert.deepEqual(item.actions, []);
  });

  test('#719/AC-1 #726/AC-2 a binary that prints nothing readable is a failed probe', async () => {
    const { service } = macService({ run: { [`${EMBEDDED} --version`]: 'something else' }, extra: { embeddedAiMemoryPath: () => EMBEDDED } });
    const item = (await service.overview())!.items.find((i) => i.id === 'ai-memory')!;
    assert.equal(item.state, 'failed');
    assert.deepEqual(item.actions, []);
  });

  test('#719/AC-1 #726/AC-2 on Linux ai-memory is not applicable: state na, no action, the embedded binary never spawned', async () => {
    const { service, run } = wsService();
    const item = (await service.overview())!.items.find((i) => i.id === 'ai-memory')!;
    assert.equal(item.state, 'na');
    assert.deepEqual(item.actions, []);
    assert.ok(!run.calls.some((a) => a.some((part) => part.includes('ai-memory'))), 'the embedded binary was never spawned');
  });
});
