/* The reader seam of the diagnosis next to a saturation alert (#566, layer 4 of 4): the 200 body checked against
docs/contracts/diagnosis.md, and each status of GET /api/diagnosis mapped to the outcome the state understands, per the
table of wireframe 566-18. Unit tests: no DOM, `ctx.read` is a function the test gives. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// @ts-expect-error: browser module, plain JavaScript
import { ReadError } from '../../ui/api.js';
// @ts-expect-error: browser module, plain JavaScript
const reader = await import('../../ui/screens/machine-diagnosis-read.js');

const GB = 1024 ** 3;
const ALERT = { id: 'swap-high', kind: 'swap-high', level: 'error', message: 'O swap passou de 90%', since: '2026-11-14T11:48:00.000Z' };
const DISK = { id: 'volume-full:/', kind: 'volume-full', level: 'warning', message: 'O volume / passou de 85%', since: '2026-11-14T11:48:00.000Z' };
const diagnosis = (over: Record<string, unknown> = {}) => ({
  machine: 'local',
  alertId: 'swap-high',
  kind: 'swap-high',
  takenAt: '2026-11-14T12:00:00.000Z',
  sections: [
    { id: 'processes-by-rss', status: 'ok', items: [{ pid: 412, name: 'next-server', rssBytes: 2 * GB, cpuPct: 56, startedAt: '2026-11-14T08:00:00.000Z' }] },
    { id: 'swap', status: 'unavailable', items: [], reason: 'short reason' },
  ],
  ...over,
});
const signal = new AbortController().signal;
const fail = (status: number, body: unknown) => new ReadError(`O núcleo respondeu ${status}`, { status, route: '/api/diagnosis', body });
/** What the reader gives for a read that answers (or throws) this (#566). */
const run = (answer: unknown, alert = ALERT, machine = 'local') =>
  reader.diagnosisReader({ read: async () => { if (answer instanceof Error) throw answer; return answer; } }, machine)(alert, { signal });

describe('the diagnosis reader (issue 566)', () => {
  test('#566/AC-2 it reads the route of this machine and alert, with the screen signal', async () => {
    const calls: unknown[][] = [];
    const ctx = { read: async (...args: unknown[]) => (calls.push(args), diagnosis({ alertId: 'volume-full:/', kind: 'volume-full', machine: 'ws-example', sections: [] })) };
    await reader.diagnosisReader(ctx, 'ws-example')(DISK, { signal });
    assert.equal(calls[0]![0], '/api/diagnosis?machine=ws-example&alert=volume-full%3A%2F');
    assert.deepEqual(calls[0]![1], { signal });
  });

  test('#566/AC-2 a 200 that is a diagnosis of the alert is ready, as it came', async () => {
    const body = diagnosis();
    assert.deepEqual(await run(body), { state: 'ready', diagnosis: body });
  });

  test('#566/AC-2 a 200 with a worktrees field on known-caches keeps it, and one without is still ready', async () => {
    const withTrees = diagnosis({ alertId: 'volume-full:/', kind: 'volume-full', sections: [{ id: 'known-caches', status: 'ok', items: [], worktrees: { oldAfterDays: 14, root: '~/Workspace' } }] });
    assert.deepEqual((await run(withTrees, DISK)).diagnosis.sections[0].worktrees, { oldAfterDays: 14, root: '~/Workspace' });
    const without = diagnosis({ alertId: 'volume-full:/', kind: 'volume-full', sections: [{ id: 'known-caches', status: 'ok', items: [] }] });
    assert.equal((await run(without, DISK)).state, 'ready');
  });

  test('#566/AC-2 a section id the screen does not know is still ready: the screen leaves it out', async () => {
    const body = diagnosis({ sections: [{ id: 'something-new', status: 'ok', items: [] }] });
    assert.equal((await run(body)).state, 'ready');
  });

  describe('a 200 body that is not a diagnosis of the alert is a failure with no status', () => {
    const bad: Array<[string, unknown]> = [
      ['null', null],
      ['a string', 'ok'],
      ['a list', []],
      ['no sections', diagnosis({ sections: undefined })],
      ['sections that is not a list', diagnosis({ sections: {} })],
      ['a section with no id', diagnosis({ sections: [{ status: 'ok', items: [] }] })],
      ['a section with a status the contract does not have', diagnosis({ sections: [{ id: 'swap', status: 'weird', items: [] }] })],
      ['a section whose items is not a list', diagnosis({ sections: [{ id: 'swap', status: 'ok', items: 'x' }] })],
      ['a section that is not an object', diagnosis({ sections: [null] })],
      ['no kind', diagnosis({ kind: undefined })],
      ['the kind of another alert', diagnosis({ kind: 'load-high' })],
      ['the id of another alert', diagnosis({ alertId: 'memory-high' })],
      ['no takenAt', diagnosis({ takenAt: undefined })],
    ];
    for (const [name, body] of bad) {
      test(name, async () => assert.deepEqual(await run(body), { state: 'failed', failure: { status: null } }));
    }
  });

  describe('each status becomes the state of wireframe 566-18', () => {
    test('404 alert-not-open: the alert already closed', async () => {
      assert.deepEqual(await run(fail(404, { error: 'x', reason: 'alert-not-open' })), { state: 'closed' });
    });
    test('404 unknown-machine, and a 404 with no reason: a failure, with the status', async () => {
      assert.deepEqual(await run(fail(404, { error: 'x', reason: 'unknown-machine' })), { state: 'failed', failure: { status: 404 } });
      assert.deepEqual(await run(fail(404, null)), { state: 'failed', failure: { status: 404 } });
    });
    test('422 not-diagnosable: a failure, with the status (the screen only asks for the four saturation kinds)', async () => {
      assert.deepEqual(await run(fail(422, { error: 'x', reason: 'not-diagnosable' })), { state: 'failed', failure: { status: 422 } });
    });
    test('501 with error diagnosis-unsupported: unsupported, decided by the field and never by the message', async () => {
      assert.deepEqual(await run(fail(501, { error: 'diagnosis-unsupported' })), { state: 'unsupported' });
      const words = new ReadError('O núcleo da Workstation ainda não faz diagnóstico', { status: 501, body: { error: 'other-thing' } });
      assert.deepEqual(await run(words), { state: 'failed', failure: { status: 501 } });
      assert.deepEqual(await run(fail(501, null)), { state: 'failed', failure: { status: 501 } });
    });
    test('502 carries the Workstation reason, only one the contract names', async () => {
      assert.deepEqual(await run(fail(502, { error: 'x', reason: 'unreachable' })), { state: 'failed', failure: { status: 502, reason: 'unreachable' } });
      assert.deepEqual(await run(fail(502, { error: 'x', reason: 'bad-response' })), { state: 'failed', failure: { status: 502, reason: 'bad-response' } });
      assert.deepEqual(await run(fail(502, { error: 'x', reason: 'a sentence from the core' })), { state: 'failed', failure: { status: 502 } });
      assert.deepEqual(await run(fail(502, null)), { state: 'failed', failure: { status: 502 } });
    });
    test('400, 405, 500 and other statuses: a failure, with the status', async () => {
      for (const status of [400, 405, 500, 503]) assert.deepEqual(await run(fail(status, { error: 'x' })), { state: 'failed', failure: { status } });
    });
    test('no answer from the core (status 0, timed out) is a failure with no status', async () => {
      assert.deepEqual(await run(new ReadError('O núcleo em 127.0.0.1:4720 não respondeu')), { state: 'failed', failure: { status: null } });
      assert.deepEqual(await run(new ReadError('x', { timedOut: true })), { state: 'failed', failure: { status: null } });
    });
    test('an error that is not a ReadError is a failure with no status', async () => {
      assert.deepEqual(await run(new TypeError('boom')), { state: 'failed', failure: { status: null } });
    });
    test('a read that was aborted goes on as the abort, for the state to drop', async () => {
      const aborted = new DOMException('This operation was aborted', 'AbortError');
      await assert.rejects(run(aborted), (e: Error) => e.name === 'AbortError');
    });
  });

  test('the response normalizer returns the diagnosis for a good body and null for any other', () => {
    const body = diagnosis();
    assert.equal(reader.normalizeDiagnosis(body, ALERT), body);
    assert.equal(reader.normalizeDiagnosis({}, ALERT), null);
    assert.equal(reader.normalizeDiagnosis(undefined, ALERT), null);
  });
});
