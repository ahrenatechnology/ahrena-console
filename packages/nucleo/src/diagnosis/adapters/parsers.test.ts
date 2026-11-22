/* The `ps` tree reading of the diagnosis (#722, #720): pure parsing of what the catalog command prints. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseProcStatStartTime, parsePsTree } from './parsers.ts';

describe('parsePsTree', () => {
  test('#720/AC-2 Given ps rows with pid, ppid, CPU, the start and the full command, Then each becomes a sample with the start as ps printed it', () => {
    const out = [
      '67562     1  10.5 Sat Nov 21 21:00:00 2026 claude --resume 0413a6d2',
      '67601 67562   0.0 Sat Nov 21 21:05:09 2026 /bin/zsh -c -l eval pnpm test',
      '  912   901 102.4 Fri Nov  6 08:01:02 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu',
    ].join('\n');
    assert.deepEqual(parsePsTree(out), [
      { pid: 67562, ppid: 1, cpuPct: 10.5, start: 'Sat Nov 21 21:00:00 2026', command: 'claude --resume 0413a6d2' },
      { pid: 67601, ppid: 67562, cpuPct: 0, start: 'Sat Nov 21 21:05:09 2026', command: '/bin/zsh -c -l eval pnpm test' },
      { pid: 912, ppid: 901, cpuPct: 102.4, start: 'Fri Nov 6 08:01:02 2026', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu' },
    ]);
  });

  test('#720/AC-2 Given a line that is not a process row, Then it is skipped', () => {
    assert.deepEqual(parsePsTree('garbage\n\n  12 1 0.0 not a date here cmd\n'), []);
  });

  test('#720/AC-2 Given a row with no command, Then it is skipped', () => {
    assert.deepEqual(parsePsTree('  12 1 0.0 Sat Nov 21 21:00:00 2026'), []);
  });
});

describe('parseProcStatStartTime', () => {
  /* Fields 3..22 after `comm`: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime (#722) */
  const after = (starttime: string) => `S 1 1 1 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${starttime} 123456 789 18446744073709551615`;

  test('#720/AC-2 Given a stat line, Then the start is field 22, the clock ticks Claude Code writes as procStart on Linux', () => {
    assert.equal(parseProcStatStartTime(`480890 (claude) ${after('480890526')}`), '480890526');
  });

  test('#720/AC-2 Given a command name with spaces and a closing parenthesis, Then the fields are counted from the last parenthesis', () => {
    assert.equal(parseProcStatStartTime(`4242 (my ) prog (v2)) ${after('9001')}\n`), '9001');
  });

  test('#720/AC-2 Given text that is not a stat line or has too few fields, Then there is no start', () => {
    assert.equal(parseProcStatStartTime(''), null);
    assert.equal(parseProcStatStartTime('garbage'), null);
    assert.equal(parseProcStatStartTime('1 (sh) S 1 1'), null);
    assert.equal(parseProcStatStartTime(`1 (sh) ${after('not-a-number')}`), null);
  });
});
