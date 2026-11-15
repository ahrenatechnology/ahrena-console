// A child spawned after the reopen sees neither the original descriptor nor the new one (#619, review finding SEC-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const module = fileURLToPath(new URL('./close-on-exec-fd.ts', import.meta.url));

/* `/dev/fd/<n>` of a socket opens as a duplicate of it on macOS only; on Linux it is ENXIO. (#619) */
const MACOS_ONLY = { skip: process.platform !== 'darwin' ? 'reopening a socket through /dev/fd works on macOS only' : false };
const NOT_MACOS = { skip: process.platform === 'darwin' ? 'the macOS tests above cover this platform' : false };

/** A grandchild that reports which of the given descriptor numbers it holds: a shell opens none of its own, so a hit is inherited. (#619) */
const GRANDCHILD = 'for n in "$@"; do if { true <&$n; } 2>/dev/null; then echo $n; fi; done';

/** Runs a node child that holds a socket at fd 3, reopens it, then spawns a grandchild; returns what the grandchild saw. (#619) */
function visibleToGrandchild(): { original: number; replacement: number | null; seen: number[] } {
  const code = `
    import { spawnSync } from 'node:child_process';
    import { reopenCloseOnExec } from ${JSON.stringify(module)};
    const replacement = reopenCloseOnExec(3);
    const list = [3, ...(replacement === null ? [] : [replacement])];
    const g = spawnSync('/bin/sh', ['-c', ${JSON.stringify(GRANDCHILD)}, 'probe', ...list.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    console.log(String(replacement));
    process.stdout.write(g.stdout);
  `;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
  assert.equal(r.status, 0);
  const [first = '', ...rest] = r.stdout.trim().split('\n');
  return { original: 3, replacement: first === 'null' ? null : Number(first), seen: rest.filter(Boolean).map(Number) };
}

test('after the reopen a descendant sees neither the original nor the new descriptor', MACOS_ONLY, () => {
  const r = visibleToGrandchild();
  assert.equal(typeof r.replacement, 'number');
  assert.notEqual(r.replacement, 3);
  assert.deepEqual(r.seen, []);
});

test('the new descriptor is the same socket: a peer that writes is read through it', MACOS_ONLY, async () => {
  const code = `
    import { Socket } from 'node:net';
    import { reopenCloseOnExec } from ${JSON.stringify(module)};
    const fd = reopenCloseOnExec(3);
    const s = new Socket({ fd, readable: true, writable: false });
    s.setEncoding('utf8').on('data', (d) => { console.log('got:' + d.trim()); process.exit(0); });
  `;
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
  (p.stdio[3] as import('node:net').Socket).write('hello\n');
  let out = '';
  p.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
  await new Promise((r) => p.on('exit', r));
  assert.equal(out.trim(), 'got:hello');
});

test('a descriptor that cannot be reopened is reported as none and left closed', () => {
  const code = `
    import { fstatSync } from 'node:fs';
    import { reopenCloseOnExec } from ${JSON.stringify(module)};
    const r = reopenCloseOnExec(200);
    let open = true; try { fstatSync(200); } catch { open = false; }
    console.log(JSON.stringify({ r, open }));
  `;
  // No descriptor 200 exists in the child, so there is nothing to reopen. (#619)
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  assert.deepEqual(JSON.parse(r.stdout.trim()), { r: null, open: false });
});

test('where a socket cannot be reopened the answer is none and the original is closed too (#619)', NOT_MACOS, () => {
  const code = `
    import { fstatSync } from 'node:fs';
    import { reopenCloseOnExec } from ${JSON.stringify(module)};
    const r = reopenCloseOnExec(3);
    let open = true; try { fstatSync(3); } catch { open = false; }
    console.log(JSON.stringify({ r, open }));
  `;
  // The child holds a socket at fd 3 (the parent's end of a socketpair), as the app hands it to the owner. (#619)
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
  assert.deepEqual(JSON.parse(r.stdout.trim()), { r: null, open: false });
});
