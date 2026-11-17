import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { INSTANCE_CLIENTS_DIR_NAME, liveInstanceClients, registerInstanceClient, removeInstanceClients } from './instance-clients.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-instance-clients-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => p.once('exit', r));
  return p.pid!;
}

describe('instance clients', () => {
  test('a registered live pid is listed; a dead one leaves the folder', async () => {
    const dead = await deadPid();
    registerInstanceClient(process.pid, 'app-4242', { home });
    registerInstanceClient(dead, 'app-4242', { home });
    assert.deepEqual(liveInstanceClients('app-4242', { home }), [process.pid]);
    assert.deepEqual(readdirSync(join(home, INSTANCE_CLIENTS_DIR_NAME, 'app-4242')), [String(process.pid)]);
  });

  test('clients belong to one instance id', () => {
    registerInstanceClient(process.pid, 'app-4242', { home });
    assert.deepEqual(liveInstanceClients('app-5151', { home }), []);
  });

  test('the folder is 0700 and the file 0600', () => {
    registerInstanceClient(process.pid, 'dev-7', { home });
    const dir = join(home, INSTANCE_CLIENTS_DIR_NAME, 'dev-7');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, String(process.pid))).mode & 0o777, 0o600);
  });

  test('removing the instance takes its folder', () => {
    registerInstanceClient(process.pid, 'dev-7', { home });
    removeInstanceClients('dev-7', { home });
    assert.equal(existsSync(join(home, INSTANCE_CLIENTS_DIR_NAME, 'dev-7')), false);
  });

  test('refuses an id that is not an instance id (never a path)', () => {
    for (const id of ['../x', 'app-0', 'other-1', 'app-1/..']) assert.throws(() => registerInstanceClient(process.pid, id, { home }), /not an instance id/);
  });
});
