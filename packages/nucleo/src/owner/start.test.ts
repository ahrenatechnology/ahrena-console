// How the owner `start` spawns the core (#619, layer 1): the window channel is fd 3 of a core it STARTS, never of an adopted one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreSpawn } from './start.ts';

const base = { api: '/x/api/cli.ts', port: 0, installation: 'app' as const, dir: '/d', parent: null };

test('without a channel the core gets no fourth descriptor and no option', () => {
  const s = coreSpawn({ ...base }, 9);
  assert.deepEqual(s.stdio, ['ignore', 9, 9]);
  assert.ok(!s.args.includes('--window-channel'));
});

test('with a channel the core gets it as fd 3 and is told so', () => {
  const s = coreSpawn({ ...base, windowChannelFd: 5 }, 9);
  assert.deepEqual(s.stdio, ['ignore', 9, 9, 5]);
  const i = s.args.indexOf('--window-channel');
  assert.equal(s.args[i + 1], '3');
});

test('the channel cannot arrive through the API options after --', () => {
  assert.throws(() => coreSpawn({ ...base, apiArgs: ['--window-channel', '3'] }, 9), /--window-channel/);
  assert.throws(() => coreSpawn({ ...base, apiArgs: ['--window-channel=3'] }, 9), /--window-channel/);
});
