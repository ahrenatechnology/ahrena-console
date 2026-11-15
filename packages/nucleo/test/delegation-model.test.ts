// The delegation model (#567): the vias, which vias a machine accepts, the budget and the host.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SSH_HOST, URL_BUDGET, VIAS, acceptsVia, isVia, viasFor } from '../src/delegation/model.ts';

describe('delegation model', () => {
  test('#567/AC-1 the vias are desktop, terminal and ssh', () => {
    assert.deepEqual([...VIAS], ['desktop', 'terminal', 'ssh']);
    assert.equal(isVia('desktop'), true);
    assert.equal(isVia('carrier-pigeon'), false);
    assert.equal(isVia(7), false);
  });

  test('#567/AC-8 this machine accepts desktop and terminal only', () => {
    assert.deepEqual([...viasFor('local')], ['desktop', 'terminal']);
    assert.equal(acceptsVia('local', 'ssh'), false);
  });

  test('#567/AC-8 any other machine accepts ssh only', () => {
    assert.deepEqual([...viasFor('workstation')], ['ssh']);
    assert.equal(acceptsVia('workstation', 'desktop'), false);
    assert.equal(acceptsVia('workstation', 'terminal'), false);
    assert.equal(acceptsVia('workstation', 'ssh'), true);
  });

  test('#567/AC-3 the ssh host and the url budget are fixed', () => {
    assert.equal(SSH_HOST, 'ahrena-workstation');
    assert.equal(URL_BUDGET, 12_000);
  });
});
