import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createWindowCredentialHolder } from './window-credential.ts';
import { parseWindowChannelFd, readWindowChannel, type PeerVerdict, type PeerVerifier } from './window-channel.ts';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);

function setup(verdicts: PeerVerdict | PeerVerdict[] | (() => Promise<PeerVerdict>) = 'match') {
  const stream = new PassThrough();
  const holder = createWindowCredentialHolder();
  const logs: string[] = [];
  const seen: number[] = [];
  let i = 0;
  const verifier: PeerVerifier = {
    verify: async (fd) => {
      seen.push(fd);
      if (typeof verdicts === 'function') return verdicts();
      if (typeof verdicts === 'string' || !Array.isArray(verdicts)) return verdicts;
      return verdicts[Math.min(i++, verdicts.length - 1)] as PeerVerdict;
    },
  };
  const reader = readWindowChannel({ fd: 3, stream, verifier, holder, log: (m) => logs.push(m) });
  return { stream, holder, logs, seen, reader };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test('a valid line from a matching peer becomes the credential', async () => {
  const { stream, holder, seen } = setup('match');
  stream.write(`${A}\n`);
  await tick();
  await tick();
  assert.equal(holder.current(), A);
  assert.deepEqual(seen, [3]);
});

test('a line split across chunks is read as one', async () => {
  const { stream, holder } = setup('match');
  stream.write(A.slice(0, 10));
  await tick();
  stream.write(`${A.slice(10)}\n`);
  await tick();
  await tick();
  assert.equal(holder.current(), A);
});

test('a new line rotates the credential and the old one is gone', async () => {
  const { stream, holder } = setup('match');
  stream.write(`${A}\n`);
  await tick();
  await tick();
  stream.write(`${B}\n`);
  await tick();
  await tick();
  assert.equal(holder.current(), B);
});

test('two lines in one chunk end with the last one', async () => {
  const { stream, holder } = setup('match');
  stream.write(`${A}\n${B}\n`);
  await tick();
  await tick();
  await tick();
  assert.equal(holder.current(), B);
});

test('a peer that mismatches gets no credential and the channel is closed', async () => {
  const { stream, holder, logs, reader } = setup('mismatch');
  stream.write(`${A}\n`);
  await reader.done;
  assert.equal(holder.current(), null);
  assert.ok(stream.destroyed);
  assert.ok(logs.some((l) => l === 'window channel refused peer=mismatch'));
});

test('a verifier that is unavailable gets no credential and the channel is closed', async () => {
  const { stream, holder, logs, reader } = setup({ unavailable: 'exit' });
  stream.write(`${A}\n`);
  await reader.done;
  assert.equal(holder.current(), null);
  assert.ok(stream.destroyed);
  assert.ok(logs.includes('window channel refused peer=unavailable reason=exit'));
});

test('every closed cause of unavailable is logged as its code and nothing else (#619)', async () => {
  for (const reason of ['spawn', 'timeout', 'signal', 'exit', 'platform'] as const) {
    const { stream, logs, reader } = setup({ unavailable: reason });
    stream.write(`${A}\n`);
    await reader.done;
    assert.ok(logs.includes(`window channel refused peer=unavailable reason=${reason}`));
  }
});

test('a verifier that throws counts as unavailable', async () => {
  const { stream, holder, logs, reader } = setup(async () => {
    throw new Error('native failure with details');
  });
  stream.write(`${A}\n`);
  await reader.done;
  assert.equal(holder.current(), null);
  assert.ok(logs.includes('window channel refused peer=unavailable reason=spawn'));
  assert.ok(!logs.join('\n').includes('native failure'));
});

test('rotation to a mismatching peer revokes the previous credential', async () => {
  const { stream, holder, reader } = setup(['match', 'mismatch']);
  stream.write(`${A}\n`);
  await tick();
  await tick();
  assert.equal(holder.current(), A);
  stream.write(`${B}\n`);
  await reader.done;
  assert.equal(holder.current(), null);
});

for (const [name, bad] of [
  ['uppercase hex', `${A.toUpperCase()}\n`],
  ['too short', `${A.slice(1)}\n`],
  ['too long', `${A}0\n`],
  ['non hex', `${'z'.repeat(64)}\n`],
  ['carriage return', `${A}\r\n`],
  ['empty line', '\n'],
] as const) {
  test(`an invalid line (${name}) revokes the credential and closes the channel`, async () => {
    const { stream, holder, logs, reader } = setup('match');
    stream.write(`${A}\n`);
    await tick();
    await tick();
    assert.equal(holder.current(), A);
    stream.write(bad);
    await reader.done;
    assert.equal(holder.current(), null);
    assert.ok(stream.destroyed);
    assert.ok(logs.includes('window channel revoked reason=invalid_line'));
  });
}

test('more than 65 bytes with no newline revokes and closes', async () => {
  const { stream, holder, logs, reader } = setup('match');
  stream.write('a'.repeat(70));
  await reader.done;
  assert.equal(holder.current(), null);
  assert.ok(stream.destroyed);
  assert.ok(logs.includes('window channel revoked reason=invalid_line'));
});

test('end of the stream revokes the credential', async () => {
  const { stream, holder, logs, reader } = setup('match');
  stream.write(`${A}\n`);
  await tick();
  await tick();
  stream.end();
  await reader.done;
  assert.equal(holder.current(), null);
  assert.ok(logs.includes('window channel revoked reason=eof'));
});

test('a stream error revokes the credential without its text in the log', async () => {
  const { stream, holder, logs, reader } = setup('match');
  stream.write(`${A}\n`);
  await tick();
  await tick();
  stream.destroy(new Error('ECONNRESET secret-detail'));
  await reader.done;
  assert.equal(holder.current(), null);
  assert.ok(logs.includes('window channel revoked reason=error'));
  assert.ok(!logs.join('\n').includes('secret-detail'));
});

test('a verdict that arrives after the channel closed sets nothing', async () => {
  let release: (v: PeerVerdict) => void = () => {};
  const { stream, holder, reader } = setup(() => new Promise<PeerVerdict>((r) => (release = r)));
  stream.write(`${A}\n`);
  await tick();
  stream.end();
  await tick();
  release('match');
  await reader.done;
  assert.equal(holder.current(), null);
});

test('the value is never logged', async () => {
  const { stream, logs, reader } = setup('mismatch');
  stream.write(`${A}\n`);
  await reader.done;
  assert.ok(!logs.join('\n').includes(A));
});

test('the channel option is a small integer of 3 or more', () => {
  assert.equal(parseWindowChannelFd(undefined), undefined);
  assert.equal(parseWindowChannelFd('3'), 3);
  assert.equal(parseWindowChannelFd('17'), 17);
  for (const bad of ['', '2', '0', '-1', '3.5', 'abc', '03', '3 ', '1e1', '1000000', `${A}`]) {
    assert.throws(() => parseWindowChannelFd(bad), /--window-channel/, bad);
  }
});

test('an accepted line logs the closed code and never the value (#619)', async () => {
  const { stream, logs } = setup('match');
  stream.write(`${A}\n`);
  await tick();
  await tick();
  assert.ok(logs.includes('window channel accepted'));
  assert.ok(logs.every((m) => !m.includes(A)));
});

test('a line queued behind a refusal never reaches the verifier: the channel is closed first (#619)', async () => {
  const { stream, seen } = setup('mismatch');
  stream.write(`${A}\n${B}\n`);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(seen, [3]);
});
