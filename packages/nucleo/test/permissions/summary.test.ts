// What the person approves, with the secrets masked (#618/AC-7). Pure.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MASK, MAX_SUMMARY_CHARS, redactSecrets, summarize } from '../../src/permissions/summary.ts';

describe('summarize (#618/AC-7)', () => {
  test('#618/AC-7: a Bash summary is the command, with a URL credential masked', () => {
    const s = summarize('Bash', { command: 'DATABASE_URL=postgres://u:pw@h/db npm run migrate' });
    assert.equal(s, `DATABASE_URL=postgres://${MASK}@h/db npm run migrate`);
    assert.equal(MASK, '••••');
  });

  test('#618/AC-7: an Edit summary names the path and a short diff', () => {
    const s = summarize('Edit', { file_path: '/w/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' });
    assert.equal(s, '/w/src/a.ts\n- const a = 1\n+ const a = 2');
  });

  test('#618/AC-7: a Write summary names the path and the start of the content', () => {
    const s = summarize('Write', { file_path: '/w/notes.md', content: 'hello' });
    assert.equal(s, '/w/notes.md\n+ hello');
  });

  test('#618/AC-7: a WebFetch summary is the URL, a token in its query masked', () => {
    assert.equal(summarize('WebFetch', { url: 'https://docs.example.dev/x?token=abc123&page=2', prompt: 'p' }), `https://docs.example.dev/x?token=${MASK}&page=2`);
  });

  test('#618/AC-7: an MCP tool summary is its name and its arguments, secrets masked', () => {
    const s = summarize('mcp__db__query', { sql: 'select 1', api_key: 'sk-live-123' });
    assert.match(s, /^mcp__db__query /);
    assert.match(s, /select 1/);
    assert.doesNotMatch(s, /sk-live-123/);
    assert.match(s, new RegExp(MASK));
  });

  test('#618/AC-7: Read, Grep and Glob summaries are their path or pattern', () => {
    assert.equal(summarize('Read', { file_path: '/w/a.ts' }), '/w/a.ts');
    assert.equal(summarize('Grep', { pattern: 'TODO', path: '/w/src' }), 'TODO in /w/src');
    assert.equal(summarize('Glob', { pattern: '**/*.ts' }), '**/*.ts');
  });

  test('#618/AC-7: an unknown tool or odd input still gets a safe, masked summary', () => {
    assert.equal(summarize('Bash', null), 'Bash');
    assert.equal(summarize('Bash', { command: 42 }), 'Bash {"command":42}');
    assert.equal(summarize('Weird', 'oops'), 'Weird');
    assert.match(summarize('Weird', { password: 'hunter2' }), new RegExp(`"password":${MASK}`));
  });

  test('#618/AC-7: a long summary is cut, and the secret is masked before the cut', () => {
    const s = summarize('Bash', { command: `${'x'.repeat(MAX_SUMMARY_CHARS - 10)} --token abcdefghijklmnop ${'y'.repeat(500)}` });
    assert.ok([...s].length <= MAX_SUMMARY_CHARS);
    assert.ok(s.endsWith('…'));
    assert.doesNotMatch(s, /abcdefghijklmnop/);
  });
});

describe('redactSecrets (#618/AC-7)', () => {
  const masked = (text: string) => redactSecrets(text);
  test('#618/AC-7: NAME_TOKEN, NAME_KEY and NAME_SECRET variables', () => {
    assert.equal(masked('GITHUB_TOKEN=ghp_abc npm publish'), `GITHUB_TOKEN=${MASK} npm publish`);
    assert.equal(masked('AWS_SECRET_ACCESS_KEY=abc/def+ghi aws s3 ls'), `AWS_SECRET_ACCESS_KEY=${MASK} aws s3 ls`);
    assert.equal(masked('STRIPE_KEY="sk test 1" node x.js'), `STRIPE_KEY=${MASK} node x.js`);
  });
  test('#618/AC-7: password=, passwd: and JSON "password" fields', () => {
    assert.equal(masked('curl -d password=hunter2 https://h'), `curl -d password=${MASK} https://h`);
    assert.equal(masked('{"password": "hunter2", "user": "u"}'), `{"password": ${MASK}, "user": "u"}`);
  });
  test('#618/AC-7: Authorization and Bearer headers', () => {
    assert.equal(masked('curl -H "Authorization: Bearer abc.def.ghi" https://h'), `curl -H "Authorization: Bearer ${MASK}" https://h`);
    assert.equal(masked('Authorization: Basic dTpw'), `Authorization: Basic ${MASK}`);
    assert.equal(masked('echo Bearer abc123'), `echo Bearer ${MASK}`);
  });
  test('#618/AC-7: flags that carry a secret in the next word, and -pSECRET', () => {
    assert.equal(masked('tool --token abc123 --env local'), `tool --token ${MASK} --env local`);
    assert.equal(masked('mysql -psecret db'), `mysql -p${MASK} db`);
    assert.equal(masked('mkdir -p dir'), 'mkdir -p dir');
  });
  test('#618/AC-7: URLs with credentials, token-only URLs included', () => {
    assert.equal(masked('git clone https://user:pw@host/r.git'), `git clone https://${MASK}@host/r.git`);
    assert.equal(masked('git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@host/r.git'), `git clone https://${MASK}@host/r.git`);
  });
  test('#618/AC-7: well-known token shapes and private key blocks', () => {
    assert.equal(masked('x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y'), `x ${MASK} y`);
    assert.equal(masked('k AKIAABCDEFGHIJKLMNOP z'), `k ${MASK} z`);
    assert.equal(masked('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'), MASK);
    assert.equal(masked('t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln z'), `t ${MASK} z`);
  });
  test('#618/AC-7: plain text is left alone', () => {
    const plain = 'npm run migrate -- --env local && git status';
    assert.equal(masked(plain), plain);
  });
  test('#618/AC-7: a header with an opaque value, a quoted header and an escaped quote are masked', () => {
    assert.equal(masked('{"headers":{"Authorization":"opaque-token-value-123"}}'), `{"headers":{"Authorization":"${MASK}"}}`);
    assert.doesNotMatch(masked('Authorization: "opaque123456"'), /opaque123456/);
    const escaped = masked('{"password":"pa\\"ss-tail-secret"}');
    assert.doesNotMatch(escaped, /tail-secret/);
  });
  test('#618/AC-7: a 64 KiB adversarial input is masked in linear time', () => {
    const size = 64 * 1024;
    const inputs = ['a.key'.repeat(size / 5), 'token_'.repeat(Math.floor(size / 6)), 'a'.repeat(size), '-p'.repeat(size / 2), ' --key'.repeat(Math.floor(size / 6)), 'password='.repeat(Math.floor(size / 9)), `"${'\\"'.repeat(size / 2)}`, '-----BEGIN PRIVATE KEY-----'.repeat(Math.floor(size / 27))];
    for (const text of inputs) {
      const start = performance.now();
      redactSecrets(text);
      summarize('Bash', { command: text });
      const ms = performance.now() - start;
      assert.ok(ms < 1000, `${ms.toFixed(0)} ms for ${text.slice(0, 12)}`);
    }
  });
  test('#618/AC-7: a secret near the pre-cut ceiling does not leave half of it in the summary', () => {
    const s = summarize('Bash', { command: `${'x'.repeat(MAX_SUMMARY_CHARS * 8 - 20)} --token abcdefghijklmnop` });
    assert.doesNotMatch(s, /abcdefg/);
  });
});
