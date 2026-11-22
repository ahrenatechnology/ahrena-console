// The config.toml edit that turns embeddings off (#740/AC-2): a top-level key, nothing else changed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { withEmbeddingsOff } from './config-toml.ts';

const KEY = 'embedding_provider = "none"';

describe('#740/AC-2 withEmbeddingsOff', () => {
  test('#740/AC-2 Given a file with no such key, When embeddings are turned off, Then the key sits before the first table and every other line is kept', () => {
    const before = '# my config\nllm_provider = "ollama"\n\n# decay settings\n[decay]\nhalf_life_days = 30\n';
    const after = withEmbeddingsOff(before);
    const lines = after.split('\n');
    assert.ok(lines.indexOf(KEY) >= 0, 'the key is there');
    assert.ok(lines.indexOf(KEY) < lines.indexOf('[decay]'), 'before the first table');
    assert.ok(lines.indexOf(KEY) < lines.indexOf('# decay settings'), 'and before the comment that belongs to the table');
    for (const kept of ['# my config', 'llm_provider = "ollama"', '# decay settings', '[decay]', 'half_life_days = 30']) assert.ok(lines.includes(kept), `${kept} is kept`);
  });

  test('#740/AC-2 Given a file with no table at all, When embeddings are turned off, Then the key is appended', () => {
    const after = withEmbeddingsOff('data_dir = "/d"\n');
    assert.deepEqual(after.split('\n').filter(Boolean), ['data_dir = "/d"', KEY]);
  });

  test('#740/AC-2 Given an empty file, When embeddings are turned off, Then the file holds only the key', () => {
    assert.equal(withEmbeddingsOff('').trim(), KEY);
  });

  test('#740/AC-2 Given the key set to another provider, When embeddings are turned off, Then that line becomes "none" and its comment stays', () => {
    const before = 'embedding_provider = "openai"  # was remote\nother = 1\n[x]\nembedding_provider = "inside-a-table"\n';
    const after = withEmbeddingsOff(before);
    const lines = after.split('\n');
    assert.equal(lines[0], `${KEY}  # was remote`);
    assert.equal(lines[1], 'other = 1');
    assert.ok(lines.includes('embedding_provider = "inside-a-table"'), 'the same name inside a table is another key and stays');
    assert.equal(lines.filter((l) => l.startsWith('embedding_provider')).length, 2);
  });

  test('#740/AC-2 Given the key only in a comment, When embeddings are turned off, Then the comment stays and a real key is added', () => {
    const before = '#   embedding_provider = "none"           # opt out\n[decay]\n';
    const after = withEmbeddingsOff(before);
    assert.ok(after.includes('#   embedding_provider = "none"           # opt out'));
    assert.ok(after.split('\n').includes(KEY));
  });

  test('#740/AC-2 Given a file that already has "none", When embeddings are turned off again, Then nothing changes', () => {
    const once = withEmbeddingsOff('a = 1\n[t]\nb = 2\n');
    assert.equal(withEmbeddingsOff(once), once);
  });

  test('#740/AC-2 Given a table header inside a multi-line string, When embeddings are turned off, Then it is not taken for the first table', () => {
    const before = 'note = """\n[not-a-table]\n"""\n[real]\nx = 1\n';
    const lines = withEmbeddingsOff(before).split('\n');
    const at = lines.indexOf(KEY);
    assert.ok(at > 2 && at < lines.indexOf('[real]'), 'after the string, before the real table');
  });
});
