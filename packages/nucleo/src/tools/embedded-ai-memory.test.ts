// #719/AC-3 (#725): the core resolves the ai-memory binary the app bundle carries, by absolute path
// from its own location, with no PATH lookup.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { embeddedAiMemoryPath } from './embedded-ai-memory.ts';

/** A bundle laid out as the app's: Resources/packages/nucleo/src/tools/ (the module) and Resources/ai-memory/. */
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
});
