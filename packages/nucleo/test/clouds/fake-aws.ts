// A FAKE `aws` CLI for the #277 tests: a node script named `aws` in a temporary `bin` folder, with an
// absolute shebang, driven by a `state.json` next to it, recording every call in `calls.log`. Never
// the real aws; no real account, profile, region or host (placeholders only).
//
// - `--version`: `aws-cli/<version>` (on stderr for 1.x, as v1 does).
// - `sts get-caller-identity`: `ok` (prints a placeholder identity), `expired` (the CLI's token
//   error on stderr), `error` (a network error); `stsSleepMs` delays the answer.
// - `sso login`: `ok` (writes `cacheWrite` and exits 0), `fail` (exit `failCode`), `sleep` (waits to
//   be killed), `device` (prints a device-code page like the CLI's, plus `deviceExtra` lines, then
//   waits `deviceExitMs` and exits 0, or waits to be killed).

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeAwsState {
  version: string;
  sts: 'ok' | 'expired' | 'error';
  stsSleepMs?: number;
  login: 'ok' | 'fail' | 'sleep' | 'device';
  failCode?: number;
  cacheWrite?: { path: string; content: string } | null;
  deviceLines?: string[];
  deviceExitMs?: number | null;
}

export interface FakeAws {
  root: string;
  bin: string;
  /** An empty folder: a PATH without aws. */
  emptyBin: string;
  home: string;
  configFile: string;
  cacheDir: string;
  logFile: string;
  set(state: Partial<FakeAwsState>): void;
  calls(): string[][];
  writeConfig(text: string): void;
  close(): void;
}

export const DEVICE_PAGE = [
  'Browser will not be automatically opened.',
  'Please visit the following URL:',
  '',
  'https://device.sso.regiao-exemplo-1.amazonaws.com/',
  '',
  'Then enter the code:',
  '',
  'ABCD-EFGH',
  '',
  'Alternatively, you may visit the following URL which will autofill the code upon loading:',
  'https://device.sso.regiao-exemplo-1.amazonaws.com/?user_code=ABCD-EFGH',
];

const SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const wait = () => setInterval(() => {}, 60000);
if (args[0] === '--version') {
  const banner = 'aws-cli/' + state.version + ' Python/3.11.0 Darwin/24.0.0 exe/x86_64';
  if (state.version.startsWith('1.')) console.error(banner); else console.log(banner);
} else if (args[0] === 'sts') {
  const answer = () => {
    if (state.sts === 'ok') { console.log(JSON.stringify({ UserId: 'ID-EXEMPLO', Account: '000000000000', Arn: 'arn:aws:sts::000000000000:assumed-role/papel-exemplo/STS-OUTPUT-SENTINEL' })); process.exit(0); }
    if (state.sts === 'expired') { console.error('Error when retrieving token from sso: Token has expired and refresh failed'); process.exit(255); }
    console.error('Could not connect to the endpoint URL: STS-ERROR-SENTINEL'); process.exit(255);
  };
  if (state.stsSleepMs) setTimeout(answer, state.stsSleepMs); else answer();
} else if (args[0] === 'sso' && args[1] === 'login') {
  console.log('LOGIN-OUTPUT-SENTINEL account 000000000000');
  if (state.login === 'ok') {
    if (state.cacheWrite) { fs.mkdirSync(path.dirname(state.cacheWrite.path), { recursive: true }); fs.writeFileSync(state.cacheWrite.path, state.cacheWrite.content); }
    process.exit(0);
  } else if (state.login === 'fail') {
    process.exit(state.failCode ?? 1);
  } else if (state.login === 'sleep') {
    wait();
  } else {
    for (const l of state.deviceLines ?? []) console.log(l);
    if (state.deviceExitMs) setTimeout(() => process.exit(0), state.deviceExitMs); else wait();
  }
} else {
  console.error('unknown command'); process.exit(2);
}
`;

export function fakeAws(initial: Partial<FakeAwsState> = {}): FakeAws {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-fake-aws-'));
  const bin = join(root, 'bin');
  const emptyBin = join(root, 'empty-bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(emptyBin);
  mkdirSync(join(home, '.aws', 'sso', 'cache'), { recursive: true });
  const aws = join(bin, 'aws');
  writeFileSync(aws, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(aws, 0o755);
  let state: FakeAwsState = { version: '2.30.0', sts: 'ok', login: 'ok', ...initial };
  const save = () => writeFileSync(join(bin, 'state.json'), JSON.stringify(state));
  save();
  writeFileSync(join(bin, 'calls.log'), '');
  const configFile = join(home, '.aws', 'config');
  return {
    root,
    bin,
    emptyBin,
    home,
    configFile,
    cacheDir: join(home, '.aws', 'sso', 'cache'),
    logFile: join(root, 'data', 'reconnect.log'),
    set(next) {
      state = { ...state, ...next };
      save();
    },
    calls: () =>
      readFileSync(join(bin, 'calls.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
    writeConfig: (text) => writeFileSync(configFile, text),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Appends to a file (tests that grow the config so its size changes). */
export const append = (file: string, text: string) => appendFileSync(file, text);

/** A config with one new-format session (two profiles), one legacy profile and one access-key profile. */
export const CONFIG = `[default]
region = regiao-exemplo-1

[sso-session sessao-exemplo]
sso_start_url = https://exemplo.awsapps.com/start/#/
sso_region = regiao-exemplo-1
sso_registration_scopes = sso:account:access

[profile perfil-dev]
sso_session = sessao-exemplo
sso_account_id = 111111111111
sso_role_name = PapelExemplo
region = regiao-exemplo-1

[profile perfil-dados]
sso_session = sessao-exemplo
sso_account_id = 222222222222
sso_role_name = PapelLeitura
region = regiao-exemplo-2

[profile perfil-antigo]
sso_start_url = https://antigo-exemplo.awsapps.com/start
sso_region = regiao-exemplo-1
sso_account_id = 333333333333
sso_role_name = PapelExemplo

[profile perfil-chave]
aws_access_key_id = CHAVE-DE-EXEMPLO
region = regiao-exemplo-1
`;
