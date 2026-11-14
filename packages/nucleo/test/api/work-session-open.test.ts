// #515: the "Copiar comando" text of a planning session carries the same tool restriction as the terminal.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sessionCommand } from '../../src/api/work-session-open.ts';
import { PLANNING_TOOL_FLAGS } from '../../src/api/terminal-launch.ts';
import { executionPrompt } from '../../src/github/work-execution.ts';
import { planningPrompt } from '../../src/github/work-plan.ts';

const quoteAll = (parts: readonly string[]): string => parts.map((p) => `'${p.replaceAll("'", `'\\''`)}'`).join(' ');

describe('#515 sessionCommand', () => {
  const PLAN = planningPrompt({ repo: 'acme/app', number: 1 });

  test('#515/AC-1 a planning prompt: claude, the quoted flags in order, then the quoted prompt', () => {
    assert.equal(sessionCommand('/w/app', PLAN), `cd '/w/app' && claude ${quoteAll(PLANNING_TOOL_FLAGS)} -- ${quoteAll([PLAN])}`);
    assert.equal(sessionCommand(null, PLAN), `claude ${quoteAll(PLANNING_TOOL_FLAGS)} -- ${quoteAll([PLAN])}`);
    assert.match(sessionCommand('/w/app', PLAN), /'--permission-mode' 'dontAsk' '--allowedTools' 'Read,Grep,Glob,Skill,Agent,Bash\(gh issue view:\*\)/);
  });

  test('another prompt: unchanged', () => {
    const exec = executionPrompt({ repo: 'acme/app', number: 1, steps: [2] });
    assert.equal(sessionCommand('/w/app', exec), `cd '/w/app' && claude ${quoteAll([exec])}`);
    assert.equal(sessionCommand(null, "it's plain"), `claude 'it'\\''s plain'`);
  });
});
