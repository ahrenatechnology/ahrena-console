import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_IDLE_GRACE_MS, describeGrace, IDLE_GRACE_ENV, IdleExit, resolveIdleGraceMs } from './idle-exit.ts';

describe('IdleExit', () => {
  test('in use never expires', () => {
    const idle = new IdleExit(1000);
    for (const now of [0, 5000, 50_000]) assert.equal(idle.observe(true, now), 'in-use');
  });

  test('with nobody left, it waits the whole grace before expiring', () => {
    const idle = new IdleExit(1000);
    assert.equal(idle.observe(false, 10_000), 'idle-started');
    assert.equal(idle.observe(false, 10_500), 'idle');
    assert.equal(idle.observe(false, 10_999), 'idle');
    assert.equal(idle.observe(false, 11_000), 'expired');
  });

  test('a client that attaches during the grace cancels it, and the next idle period starts over', () => {
    const idle = new IdleExit(1000);
    idle.observe(false, 0);
    assert.equal(idle.observe(false, 900), 'idle');
    assert.equal(idle.observe(true, 950), 'in-use');
    assert.equal(idle.observe(false, 2000), 'idle-started');
    assert.equal(idle.observe(false, 2900), 'idle');
    assert.equal(idle.observe(false, 3000), 'expired');
  });

  test('a zero grace expires on the first idle check (the behaviour before #706)', () => {
    assert.equal(new IdleExit(0).observe(false, 0), 'expired');
  });
});

describe('resolveIdleGraceMs', () => {
  test('defaults to eight hours', () => {
    assert.equal(DEFAULT_IDLE_GRACE_MS, 8 * 3_600_000);
    assert.equal(resolveIdleGraceMs({}), DEFAULT_IDLE_GRACE_MS);
    assert.equal(resolveIdleGraceMs({ [IDLE_GRACE_ENV]: '' }), DEFAULT_IDLE_GRACE_MS);
  });

  test('reads whole seconds, zero included', () => {
    assert.equal(resolveIdleGraceMs({ [IDLE_GRACE_ENV]: '0' }), 0);
    assert.equal(resolveIdleGraceMs({ [IDLE_GRACE_ENV]: '90' }), 90_000);
  });

  test('refuses anything else', () => {
    for (const v of ['-1', '1.5', 'abc', '8h', ' 3']) assert.throws(() => resolveIdleGraceMs({ [IDLE_GRACE_ENV]: v }), new RegExp(IDLE_GRACE_ENV));
  });
});

describe('describeGrace', () => {
  test('hours, minutes or seconds', () => {
    assert.equal(describeGrace(DEFAULT_IDLE_GRACE_MS), '8 h');
    assert.equal(describeGrace(90 * 60_000), '90 min');
    assert.equal(describeGrace(30_000), '30 s');
    assert.equal(describeGrace(0), '0 s');
  });
});
