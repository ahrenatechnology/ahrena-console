// #719/AC-3 (#725): the core resolves the bundled ai-memory by absolute path, no PATH lookup.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { embeddedAiMemoryEnv, embeddedAiMemoryPath, registeredAccountFolder } from './embedded-ai-memory.ts';

function bundle(): { resources: string; moduleUrl: string; done: () => void } {
  const resources = mkdtempSync(join(tmpdir(), 'embedded-ai-memory-'));
  const tools = join(resources, 'packages', 'nucleo', 'src', 'tools');
  mkdirSync(tools, { recursive: true });
  return { resources, moduleUrl: pathToFileURL(join(tools, 'embedded-ai-memory.ts')).href, done: () => rmSync(resources, { recursive: true, force: true }) };
}

describe('embeddedAiMemoryPath', () => {
  test('#719/AC-3 #725/AC-3 the binary beside packages/ in the bundle resolves to its absolute path', () => {
    const b = bundle();
    try {
      mkdirSync(join(b.resources, 'ai-memory'));
      const binary = join(b.resources, 'ai-memory', 'ai-memory');
      writeFileSync(binary, '#!/bin/sh\n');
      chmodSync(binary, 0o755);
      const found = embeddedAiMemoryPath(b.moduleUrl);
      assert.equal(found, binary);
      assert.ok(isAbsolute(found!));
    } finally {
      b.done();
    }
  });

  test('#719/AC-3 no binary in the bundle (a checkout, an older app) is null', () => {
    const b = bundle();
    try {
      assert.equal(embeddedAiMemoryPath(b.moduleUrl), null);
    } finally {
      b.done();
    }
  });

  test('#719/AC-3 a file that is not executable is null', () => {
    const b = bundle();
    try {
      mkdirSync(join(b.resources, 'ai-memory'));
      writeFileSync(join(b.resources, 'ai-memory', 'ai-memory'), 'x', { mode: 0o644 });
      assert.equal(embeddedAiMemoryPath(b.moduleUrl), null);
    } finally {
      b.done();
    }
  });

  test('#719/AC-3 a binary on the PATH is never taken for the embedded one', () => {
    const b = bundle();
    const onPath = mkdtempSync(join(tmpdir(), 'on-path-'));
    const saved = process.env.PATH;
    try {
      writeFileSync(join(onPath, 'ai-memory'), '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = `${onPath}:${saved ?? ''}`;
      assert.equal(embeddedAiMemoryPath(b.moduleUrl), null);
    } finally {
      process.env.PATH = saved;
      rmSync(onPath, { recursive: true, force: true });
      b.done();
    }
  });

  test('#719/AC-3 an unexpected filesystem error is rethrown, not taken for an absent binary', () => {
    const b = bundle();
    try {
      mkdirSync(join(b.resources, 'ai-memory'));
      const binary = join(b.resources, 'ai-memory', 'ai-memory');
      symlinkSync(binary, binary);
      assert.throws(() => embeddedAiMemoryPath(b.moduleUrl), { code: 'ELOOP' });
    } finally {
      b.done();
    }
  });
});

describe('embeddedAiMemoryEnv (#733/AC-5, #727/AC-2)', () => {
  const FAKE = 'fake-secret-not-real';
  const PLANTED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AI_MEMORY_AUTH_TOKEN', 'AI_MEMORY_DATA_DIR', 'AHRENA_CONSOLE_CORE_PORT', 'OTHER'];

  test('#733/AC-5 #727/AC-2 keeps PATH, HOME, TMPDIR, LANG, USER and LC_*, and nothing else', () => {
    const kept = { PATH: '/usr/bin', HOME: '/Users/someone', TMPDIR: '/tmp/x', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', USER: 'someone' };
    const planted = Object.fromEntries(PLANTED.map((key) => [key, FAKE]));
    assert.deepEqual(embeddedAiMemoryEnv({ ...kept, ...planted }), kept);
  });

  test('#733/AC-5 #727/AC-2 a credential is dropped whatever the case of its name', () => {
    assert.deepEqual(embeddedAiMemoryEnv({ ai_memory_auth_token: FAKE, AI_MEMORY_AUTH_TOKEN: FAKE, github_token: FAKE, PATH: '/usr/bin' }), { PATH: '/usr/bin' });
  });

  test('#733/AC-5 a variable with no value is left out', () => {
    assert.deepEqual(embeddedAiMemoryEnv({ PATH: undefined, HOME: '/h' }), { HOME: '/h' });
  });
});

describe('#740/AC-7 CLAUDE_CONFIG_DIR is the one variable added, and only from the registry', () => {
  const REGISTRY = ['/Users/someone/.claude', '/Users/someone/.claude-work'];
  const exists = (path: string) => REGISTRY.includes(path);

  test('#740/AC-7 Given a folder the registry holds, absolute and existing, Then it is accepted', () => {
    assert.equal(registeredAccountFolder('/Users/someone/.claude-work', REGISTRY, exists), '/Users/someone/.claude-work');
  });

  test('#740/AC-7 Given a value the registry does not hold, a relative one, one that does not exist or one that is not normalized, Then it is refused', () => {
    assert.equal(registeredAccountFolder('/Users/someone/.other', REGISTRY, exists), null, 'not from the registry');
    assert.equal(registeredAccountFolder('.claude', ['.claude'], () => true), null, 'relative');
    assert.equal(registeredAccountFolder('/Users/someone/.claude-work', REGISTRY, () => false), null, 'does not exist');
    assert.equal(registeredAccountFolder('/Users/someone/x/../.claude', ['/Users/someone/x/../.claude'], () => true), null, 'not normalized');
    assert.equal(registeredAccountFolder('/Users/someone/.claude\0', ['/Users/someone/.claude\0'], () => true), null, 'a NUL byte');
  });

  test('#740/AC-7 Given a registered folder, Then CLAUDE_CONFIG_DIR is that folder and the rest of the env is the allowlist', () => {
    const folder = registeredAccountFolder('/Users/someone/.claude', REGISTRY, exists)!;
    assert.deepEqual(embeddedAiMemoryEnv({ PATH: '/usr/bin', HOME: '/h', GH_TOKEN: 'fake-secret-not-real' }, folder), { PATH: '/usr/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/Users/someone/.claude' });
  });

  test('#740/AC-7 Given CLAUDE_CONFIG_DIR in the core environment, Then it never reaches the child, with a folder or without', () => {
    const planted = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/evil/.claude' };
    assert.deepEqual(embeddedAiMemoryEnv(planted), { PATH: '/usr/bin' });
    const folder = registeredAccountFolder('/Users/someone/.claude', REGISTRY, exists)!;
    assert.equal(embeddedAiMemoryEnv(planted, folder).CLAUDE_CONFIG_DIR, '/Users/someone/.claude');
  });
});
