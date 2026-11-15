// A real socketpair: node's `pipe` stdio entry is one, so the child reads its fd 3 through the adapter and the parent writes. (#619)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const A = 'c3'.repeat(32);
const adapter = fileURLToPath(new URL('./window-channel-fd.ts', import.meta.url));
const holderFile = fileURLToPath(new URL('../window-credential.ts', import.meta.url));

function child(verdict: string): ReturnType<typeof spawn> {
  const code = `
    import { openWindowChannel } from ${JSON.stringify(adapter)};
    import { createWindowCredentialHolder } from ${JSON.stringify(holderFile)};
    const holder = createWindowCredentialHolder();
    const ch = openWindowChannel({ fd: 3, holder, log: (m) => console.log('log:' + m), verifier: { verify: async () => ${JSON.stringify(verdict)} } });
    process.stdin.on('data', () => console.log('current:' + (holder.current() === ${JSON.stringify(A)} ? 'set' : String(holder.current())))); 
    ch.done.then(() => console.log('closed:' + String(holder.current())));
  `;
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
}

function lines(p: ReturnType<typeof spawn>): { next: (prefix: string) => Promise<string> } {
  let buf = '';
  const waiting: Array<() => void> = [];
  p.stdout?.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    waiting.splice(0).forEach((w) => w());
  });
  return {
    next: async (prefix) => {
      for (;;) {
        const hit = buf.split('\n').find((l) => l.startsWith(prefix));
        if (hit !== undefined) return hit;
        await new Promise<void>((r) => waiting.push(r));
      }
    },
  };
}

test('a credential written to the inherited socket is accepted from a matching peer and revoked at EOF', async () => {
  const p = child('match');
  const out = lines(p);
  const chan = p.stdio[3] as import('node:net').Socket;
  chan.write(`${A}\n`);
  await new Promise((r) => setTimeout(r, 300));
  p.stdin?.write('x');
  assert.equal(await out.next('current:'), 'current:set');
  chan.end();
  assert.equal(await out.next('closed:'), 'closed:null');
  p.stdin?.end();
  p.kill();
});

test('a peer that does not match is refused on the inherited socket', async () => {
  const p = child('mismatch');
  const out = lines(p);
  (p.stdio[3] as import('node:net').Socket).write(`${A}\n`);
  assert.equal(await out.next('log:'), 'log:window channel refused peer=mismatch');
  assert.equal(await out.next('closed:'), 'closed:null');
  p.kill();
});

test('a descriptor that is not open leaves no credential', async () => {
  const { openWindowChannel } = await import('./window-channel-fd.ts');
  const { createWindowCredentialHolder } = await import('../window-credential.ts');
  const logs: string[] = [];
  const holder = createWindowCredentialHolder();
  const ch = openWindowChannel({ fd: 987, holder, log: (m) => logs.push(m), verifier: { verify: async () => 'match' } });
  await ch.done;
  assert.equal(holder.current(), null);
});
