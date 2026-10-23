// The AWS login runner (#277, decision 0013 sections 1 and 2a) with a FAKE command (a node script in a
// temporary folder), the time unit shortened (1 "second" = 20 ms): one login per session, exit codes,
// timeout, Cancel, the reconnect.log lines, and the device-code mode's strict extraction.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { acceptVerificationUri, AwsLoginRunner, extractDeviceCode, loginArgv, type LoginLookup } from '../../src/clouds/aws-login.ts';
import { DEVICE_PAGE } from './fake-aws.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-aws-login-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const SCRIPT = join(dir, 'fake-login.mjs');
writeFileSync(
  SCRIPT,
  `const [mode, arg] = process.argv.slice(2);
console.log('LOGIN-OUTPUT-SENTINEL');
if (mode === 'exit') process.exitCode = Number(arg);
if (mode === 'sleep') setInterval(() => {}, 60_000);
if (mode === 'device') { for (const l of JSON.parse(arg)) console.log(l); setInterval(() => {}, 60_000); }
if (mode === 'device-exit') { for (const l of JSON.parse(arg)) console.log(l); setTimeout(() => process.exit(0), 100); }
`,
);

const target = (...args: string[]): (() => LoginLookup) => () => ({ kind: 'ok', target: { argv: [process.execPath, SCRIPT, ...args], timeoutSeconds: 900 } });

let n = 0;
function runner(over: Partial<ConstructorParameters<typeof AwsLoginRunner>[0]> = {}) {
  const logFile = join(dir, `reconnect-${++n}.log`);
  const logs: string[] = [];
  const changes: string[] = [];
  const succeeded: string[] = [];
  const spawns: string[] = [];
  const r = new AwsLoginRunner({ logFile, msPerSecond: 20, killGraceMs: 150, log: (m) => logs.push(m), onChange: (s) => changes.push(s), onSucceeded: (s) => succeeded.push(s), onSpawn: (s) => spawns.push(s), ...over });
  return { r, logFile, logs, changes, succeeded, spawns };
}

const waitFor = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((res) => setTimeout(res, 20));
  }
};

describe('#277 loginArgv', () => {
  test('#277 the fixed templates: --sso-session for the new format, --profile for legacy, device code adds two flags', () => {
    assert.deepEqual(loginArgv('/bin/aws', { name: 'sessao-exemplo', kind: 'sso-session' }, 'browser'), ['/bin/aws', 'sso', 'login', '--sso-session', 'sessao-exemplo']);
    assert.deepEqual(loginArgv('/bin/aws', { name: 'perfil-antigo', kind: 'legacy' }, 'browser'), ['/bin/aws', 'sso', 'login', '--profile', 'perfil-antigo']);
    assert.deepEqual(loginArgv('/bin/aws', { name: 'sessao-exemplo', kind: 'sso-session' }, 'device-code'), ['/bin/aws', 'sso', 'login', '--sso-session', 'sessao-exemplo', '--use-device-code', '--no-browser']);
  });
});

describe('#277 device-code extraction', () => {
  test('#277 accepts the AWS verification URL and the user code', () => {
    assert.deepEqual(extractDeviceCode(DEVICE_PAGE.join('\n')), { verificationUri: 'https://device.sso.regiao-exemplo-1.amazonaws.com/', userCode: 'ABCD-EFGH' });
    for (const ok of ['https://exemplo.awsapps.com/start/#/device', 'https://exemplo.signin.aws/device', 'https://oidc.regiao-exemplo-1.amazonaws.com/x']) assert.equal(acceptVerificationUri(ok), ok, ok);
  });

  test('#277 rejects a non-AWS URL, http, credentials, a port, look-alike hosts, and codes of another shape', () => {
    for (const bad of [
      'https://evil.example/device',
      'http://device.sso.regiao-exemplo-1.amazonaws.com/',
      'https://amazonaws.com.evil.example/',
      'https://evil-amazonaws.com/',
      'https://user:pw@exemplo.awsapps.com/',
      'https://exemplo.awsapps.com:8443/',
      'https://aws/',
      'javascript:alert(1)',
    ])
      assert.equal(acceptVerificationUri(bad), null, bad);
    assert.deepEqual(extractDeviceCode('Please visit https://evil.example/device\nabcd-efgh\nABCDE-FGH\n ABCD-EFGHI'), { verificationUri: null, userCode: null });
    // The code must be a line of its own; inside a sentence it is not taken.
    assert.equal(extractDeviceCode('the code is ABCD-EFGH ok').userCode, null);
  });
});

describe('#277 the login runner', () => {
  test('#277 exit 0: succeeded, the change is published, onSucceeded runs; the output only in reconnect.log', async () => {
    const { r, logFile, logs, changes, succeeded } = runner();
    const s = r.start('sessao-exemplo', 'browser', 'ui', target('exit', '0'));
    assert.equal(s.kind, 'started');
    if ('status' in s) assert.equal(s.status.state, 'running');
    await r.exited('sessao-exemplo');
    const st = r.status('sessao-exemplo');
    assert.equal(st.state, 'succeeded');
    assert.equal(st.exitCode, 0);
    assert.equal(st.mode, 'browser');
    assert.equal(st.startedBy, 'ui');
    assert.equal(st.timeoutSeconds, 900);
    assert.equal(st.logFile, logFile);
    assert.deepEqual(succeeded, ['sessao-exemplo']);
    assert.ok(changes.length >= 2);
    const lines = readFileSync(logFile, 'utf8').split('\n');
    assert.match(lines[0]!, /^\S+Z aws:sessao-exemplo login browser \(ui\)$/);
    assert.ok(lines.includes('LOGIN-OUTPUT-SENTINEL'));
    assert.match(lines.at(-2)!, /^\S+Z aws:sessao-exemplo end succeeded exit 0 after \d+ s$/);
    assert.doesNotMatch(JSON.stringify(st) + logs.join('\n'), /LOGIN-OUTPUT-SENTINEL/);
  });

  test('#277 a non-zero exit is failed with its code', async () => {
    const { r, succeeded } = runner();
    r.start('sessao-exemplo', 'browser', 'local', target('exit', '3'));
    await r.exited('sessao-exemplo');
    assert.equal(r.status('sessao-exemplo').state, 'failed');
    assert.equal(r.status('sessao-exemplo').exitCode, 3);
    assert.deepEqual(succeeded, []);
  });

  test('#277 one login per session: a second start gets the one running and spawns nothing; another session runs alongside', async () => {
    const { r, spawns } = runner();
    assert.equal(r.start('sessao-exemplo', 'browser', 'ui', target('sleep')).kind, 'started');
    const again = r.start('sessao-exemplo', 'device-code', 'local', target('sleep'));
    assert.equal(again.kind, 'already-running');
    if ('status' in again) assert.equal(again.status.mode, 'browser');
    assert.equal(r.start('outra-sessao', 'browser', 'ui', target('sleep')).kind, 'started');
    assert.deepEqual(spawns, ['sessao-exemplo', 'outra-sessao']);
    r.cancel('sessao-exemplo');
    r.cancel('outra-sessao');
    await r.exited('sessao-exemplo');
    await r.exited('outra-sessao');
  });

  test('#277 a refused lookup spawns nothing', () => {
    const { r, spawns } = runner();
    assert.deepEqual(r.start('sessao-exemplo', 'browser', 'ui', () => ({ kind: 'refused', reason: 'cli-missing' })), { kind: 'refused', reason: 'cli-missing' });
    assert.deepEqual(spawns, []);
    assert.equal(r.status('sessao-exemplo').state, 'idle');
  });

  test('#277 the timeout ends the process group: timed-out', async () => {
    const { r, logFile } = runner();
    r.start('sessao-exemplo', 'browser', 'ui', () => ({ kind: 'ok', target: { argv: [process.execPath, SCRIPT, 'sleep'], timeoutSeconds: 5 } }));
    await r.exited('sessao-exemplo');
    assert.equal(r.status('sessao-exemplo').state, 'timed-out');
    assert.match(readFileSync(logFile, 'utf8'), /aws:sessao-exemplo end timed-out exit none/);
  });

  test('#277 Cancel: canceled at once, the process ends; Cancel with nothing running is not-running', async () => {
    const { r } = runner();
    assert.deepEqual(r.cancel('sessao-exemplo'), { kind: 'not-running' });
    r.start('sessao-exemplo', 'browser', 'ui', target('sleep'));
    const c = r.cancel('sessao-exemplo');
    assert.equal(c.kind, 'canceled');
    if (c.kind === 'canceled') assert.equal(c.status.state, 'canceled');
    await r.exited('sessao-exemplo');
    assert.equal(r.status('sessao-exemplo').state, 'canceled');
  });

  test('#277 device code: the URI and code appear in the status while it waits, every byte goes to the log, the code leaves with the run', async () => {
    const { r, logFile, logs } = runner();
    r.start('sessao-exemplo', 'device-code', 'local', target('device', JSON.stringify([...DEVICE_PAGE, 'ACCOUNT-SENTINEL 000000000000'])));
    await waitFor(() => r.status('sessao-exemplo').deviceCode !== null);
    const dc = r.status('sessao-exemplo').deviceCode!;
    assert.equal(dc.verificationUri, 'https://device.sso.regiao-exemplo-1.amazonaws.com/');
    assert.equal(dc.userCode, 'ABCD-EFGH');
    assert.ok(Date.parse(dc.expiresAt) > Date.now());
    assert.doesNotMatch(JSON.stringify(r.status('sessao-exemplo')) + logs.join('\n'), /SENTINEL|Please visit/);
    r.cancel('sessao-exemplo');
    await r.exited('sessao-exemplo');
    assert.equal(r.status('sessao-exemplo').deviceCode, null);
    const log = readFileSync(logFile, 'utf8');
    for (const l of [...DEVICE_PAGE.filter(Boolean), 'ACCOUNT-SENTINEL 000000000000', 'LOGIN-OUTPUT-SENTINEL']) assert.ok(log.includes(l), l);
    assert.match(log, /aws:sessao-exemplo login device-code \(local\)/);
    assert.match(log, /aws:sessao-exemplo end canceled/);
  });

  test('#277 device code with a non-AWS URL: no deviceCode is ever exposed', async () => {
    const { r } = runner();
    r.start('sessao-exemplo', 'device-code', 'local', target('device-exit', JSON.stringify(['Please visit:', 'https://evil.example/device', 'Then enter the code:', 'ABCD-EFGH'])));
    let seen = false;
    const poll = setInterval(() => (seen ||= r.status('sessao-exemplo').deviceCode !== null), 5);
    await r.exited('sessao-exemplo');
    clearInterval(poll);
    assert.equal(seen, false);
    assert.equal(r.status('sessao-exemplo').state, 'succeeded');
  });

  test('#277 a command that does not exist: failed, exit code null', async () => {
    const { r } = runner();
    r.start('sessao-exemplo', 'browser', 'ui', () => ({ kind: 'ok', target: { argv: [join(dir, 'nao-existe')] } }));
    await r.exited('sessao-exemplo');
    assert.equal(r.status('sessao-exemplo').state, 'failed');
    assert.equal(r.status('sessao-exemplo').exitCode, null);
  });
});
