// #285: where a session opens. The descriptor every surface carries (`open`), and the resume
// command the "Copiar comando" copies, which no cwd or id can turn into another command (#285/AC-4).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { describeOpen, isUsableCwd, resumeCommand, SESSION_ID_PATTERN, SessionOpenDescriber, shellQuote } from '../../src/api/session-open.ts';

const ID = '0f8c1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const LOCAL = 'local_00000000-0000-4000-8000-0000000000d1';

describe('the open descriptor (#285)', () => {
  test('desktop: the Desktop index knows the session; no command', () => {
    assert.deepEqual(describeOpen({ sessionId: ID, cwd: '/w/app', local: LOCAL, machine: null, live: false }), { target: 'desktop', command: null });
    assert.deepEqual(describeOpen({ sessionId: ID, cwd: '/w/app', local: LOCAL, machine: null, live: true }), { target: 'desktop', command: null }, 'the Desktop wins over a live process');
  });

  test('terminal-live: no Desktop entry and a live claude process here', () => {
    assert.deepEqual(describeOpen({ sessionId: ID, cwd: '/w/app', local: null, machine: null, live: true }), { target: 'terminal-live', command: `cd '/w/app' && claude --resume ${ID}` });
  });

  test('terminal: no Desktop entry, no live process, a cwd', () => {
    assert.deepEqual(describeOpen({ sessionId: ID, cwd: '/w/app', local: null, machine: null, live: false }), { target: 'terminal', command: `cd '/w/app' && claude --resume ${ID}` });
  });

  test('remote: another machine, whatever else it carries; never a command', () => {
    assert.deepEqual(describeOpen({ sessionId: ID, cwd: '/w/app', local: LOCAL, machine: { id: 'ws', label: 'Workstation' }, live: true }), { target: 'remote', command: null });
  });

  test('none: no cwd, a relative cwd, a cwd with a line break, or an id that is not the UUID', () => {
    for (const cwd of [null, '', 'w/app', '/w/a\nb', '/w/a\rb', '/w/a\0b']) {
      assert.deepEqual(describeOpen({ sessionId: ID, cwd, local: null, machine: null, live: false }), { target: 'none', command: null }, JSON.stringify(cwd));
    }
    for (const id of ['sim-panel-current', `${ID};rm -rf ~`, `-${ID.slice(1)}`, `${ID}\n`]) {
      assert.deepEqual(describeOpen({ sessionId: id, cwd: '/w/app', local: null, machine: null, live: false }), { target: 'none', command: null }, id);
    }
  });

  test('a malformed local id is not a Desktop entry', () => {
    assert.equal(describeOpen({ sessionId: ID, cwd: '/w/app', local: 'local_x; open -a Calculator', machine: null, live: false }).target, 'terminal');
  });

  test('SESSION_ID_PATTERN is the UUID and nothing else', () => {
    assert.ok(SESSION_ID_PATTERN.test(ID));
    assert.ok(!SESSION_ID_PATTERN.test(`${ID}x`));
    assert.ok(!SESSION_ID_PATTERN.test(`../${ID}`));
  });

  test('isUsableCwd: absolute, no NUL, no line break', () => {
    assert.ok(isUsableCwd('/w/a b'));
    assert.ok(!isUsableCwd('~/w'));
    assert.ok(!isUsableCwd('/w/a\nb'));
    assert.ok(!isUsableCwd(null));
  });
});

describe('the resume command and its quoting (#285/AC-4)', () => {
  const nasty = [
    "/w/it's here",
    '/w/$(touch pwned)',
    '/w/`touch pwned`',
    '/w/with spaces/and  tabs\there',
    "/w/'; touch pwned; echo '",
    '/w/$HOME/${PATH}',
    '/w/\\back\\slash',
    '/w/glob*?[x]',
  ];

  test('shellQuote: single quotes, each inner quote closed, escaped and reopened', () => {
    assert.equal(shellQuote('/a b'), "'/a b'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  test('the shell reads back exactly the cwd, and runs nothing inside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahrena-quote-'));
    try {
      for (const cwd of nasty) {
        // `printf %s <quoted>` in a real sh, from inside an empty folder: the output is the cwd, byte for byte,
        // and no `pwned` file appears.
        const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(cwd)}`], { cwd: dir, encoding: 'utf8' });
        assert.equal(out, cwd);
      }
      assert.deepEqual(execFileSync('ls', ['-A', dir], { encoding: 'utf8' }), '', 'nothing ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resumeCommand quotes the cwd and refuses a line break', () => {
    assert.equal(resumeCommand("/w/it's", ID), `cd '/w/it'\\''s' && claude --resume ${ID}`);
    assert.equal(resumeCommand('/w/a\nb', ID), null);
    assert.equal(resumeCommand('/w/a', 'not-a-uuid'), null);
  });
});

describe('SessionOpenDescriber: the descriptor with the live processes', () => {
  test('without a process reader, no session is live', async () => {
    const d = new SessionOpenDescriber();
    await d.refresh();
    assert.equal(d.describe({ sessionId: ID, cwd: '/w/app', local: null }).target, 'terminal');
  });

  test('with a reader, a session with a live process is terminal-live; the process cwd covers a missing one', async () => {
    let refreshed = 0;
    const live = {
      refresh: async () => void refreshed++,
      find: (id: string) => (id === ID ? { pid: 42, sessionId: ID, cwd: '/w/live', procStart: null } : null),
    };
    const d = new SessionOpenDescriber({ live });
    await d.refresh();
    assert.equal(refreshed, 1);
    assert.deepEqual(d.describe({ sessionId: ID, cwd: null, local: null }), { target: 'terminal-live', command: `cd '/w/live' && claude --resume ${ID}` });
    assert.equal(d.describe({ sessionId: ID, cwd: '/w/app', local: LOCAL }).target, 'desktop');
    assert.equal(d.describe({ sessionId: ID, cwd: '/w/app', local: null, machine: { id: 'm', label: 'M' } }).target, 'remote');
  });
});
