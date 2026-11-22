/* Where `processes-by-session` reads the sessions from (#722, #720): the live registry and the title the console knows. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSessionSource } from './diagnosis-sessions.ts';
import type { LiveProcess } from './session-open.ts';

const A = '0413a6d2-3b1c-4c0e-9d3a-6f1f0a2b7c11';
const live = (list: LiveProcess[]) => {
  const calls: string[] = [];
  return { calls, reader: { refresh: async () => void calls.push('refresh'), listLive: () => (calls.push('list'), list) } };
};

describe('createSessionSource', () => {
  test('#720/AC-2 Given a registry, Then the live sessions are listed after a refresh, with the fields attribution compares', async () => {
    const { reader, calls } = live([{ pid: 7, sessionId: A, cwd: '/w', procStart: 'Sat Nov 21 21:00:00 2026' }]);
    const source = createSessionSource({ live: reader, sessionName: async () => null, desktopTitle: () => null });
    assert.deepEqual(await source.registered(), [{ pid: 7, sessionId: A, cwd: '/w', procStart: 'Sat Nov 21 21:00:00 2026' }]);
    assert.deepEqual(calls, ['refresh', 'list']);
  });

  test('#720/AC-1 Given a Desktop title and a session name, Then the Desktop title wins; without it the name; without both null', async () => {
    const source = (desktop: string | null, name: string | null) => createSessionSource({ live: live([]).reader, sessionName: async () => name, desktopTitle: () => desktop });
    assert.equal(await source('From Desktop', 'From name').titleOf(A), 'From Desktop');
    assert.equal(await source(null, 'From name').titleOf(A), 'From name');
    assert.equal(await source(null, null).titleOf(A), null);
  });

  test('#720/AC-1 Given a title with a line break or a very long one, Then it comes back clean and short', async () => {
    const source = createSessionSource({ live: live([]).reader, sessionName: async () => `fix\nthe\u0007 suite ${'x'.repeat(200)}`, desktopTitle: () => null });
    const title = await source.titleOf(A);
    assert.ok(title && !/[\n\u0007]/.test(title) && title.length <= 60);
  });
});
