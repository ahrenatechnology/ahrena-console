// The atomic write of `embedding_provider = "none"` into config.toml, in temporary folders only (#740/AC-2).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createMemoryActionFiles } from './memory-config-file.ts';

const root = mkdtempSync(join(tmpdir(), 'memory-config-file-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const dir = join(root, `data-${++n}`);
  mkdirSync(dir);
  return dir;
};
const files = createMemoryActionFiles();

describe('#740/AC-2 writeEmbeddingsOff', () => {
  test('#740/AC-2 Given a config.toml with other keys and comments, When embeddings are turned off, Then the key is set and the rest is kept, with no temporary file left', async () => {
    const dir = fresh();
    const path = join(dir, 'config.toml');
    writeFileSync(path, '# mine\nllm_provider = "ollama"\n[decay]\nhalf_life_days = 30\n', { mode: 0o600 });
    await files.writeEmbeddingsOff(path);
    const text = readFileSync(path, 'utf8');
    assert.ok(text.includes('embedding_provider = "none"'));
    for (const kept of ['# mine', 'llm_provider = "ollama"', '[decay]', 'half_life_days = 30']) assert.ok(text.includes(kept), kept);
    assert.deepEqual(readdirSync(dir), ['config.toml']);
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the mode of the file is kept');
  });

  test('#740/AC-2 Given a config.toml that already sets another provider, When embeddings are turned off, Then that key becomes "none"', async () => {
    const dir = fresh();
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'embedding_provider = "openai"\nx = 1\n');
    await files.writeEmbeddingsOff(path);
    assert.equal(readFileSync(path, 'utf8'), 'embedding_provider = "none"\nx = 1\n');
  });

  test('#740/AC-2 Given no config.toml yet, When embeddings are turned off, Then the file is created, owner-only, with just the key', async () => {
    const dir = fresh();
    const path = join(dir, 'config.toml');
    await files.writeEmbeddingsOff(path);
    assert.equal(readFileSync(path, 'utf8').trim(), 'embedding_provider = "none"');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test('#740/AC-2 Given a folder that cannot be written, When embeddings are turned off, Then it rejects and the original file is intact', async () => {
    const dir = fresh();
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'x = 1\n');
    chmodSync(dir, 0o500);
    try {
      await assert.rejects(files.writeEmbeddingsOff(path));
      assert.equal(readFileSync(path, 'utf8'), 'x = 1\n');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test('#740/AC-5 Given a path that is not a config.toml, Then it is refused and nothing is written', async () => {
    const dir = fresh();
    for (const name of ['auth-token', 'auth-header', 'other.toml']) await assert.rejects(files.writeEmbeddingsOff(join(dir, name)));
    await assert.rejects(files.writeEmbeddingsOff('config.toml'), 'a relative path');
    assert.deepEqual(readdirSync(dir), []);
  });

  test('#740 isDirectory and exists answer from the file system', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'f'), '');
    assert.equal(files.isDirectory(dir), true);
    assert.equal(files.isDirectory(join(dir, 'f')), false);
    assert.equal(files.isDirectory(join(dir, 'nope')), false);
    assert.equal(files.exists(join(dir, 'f')), true);
    assert.equal(files.exists(join(dir, 'nope')), false);
  });
});
