// Fake `security` (macOS) and `secret-tool` (Linux) for the vault adapters' tests (#241/AC-3). Each is a
// small Node script written into a temp dir, run by its absolute path: the real /usr/bin/security and
// the real secret-tool never run. The script keeps the "keychain" in a JSON file next to it and records
// every call (argv and stdin) so a test can check the secret came on stdin and never in argv.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeToolCall {
  argv: string[];
  stdin: string;
}

export interface FakeTool {
  /** The executable's absolute path, to inject as the adapter's `bin`. */
  bin: string;
  dir: string;
  /** Every call, in order. */
  calls(): FakeToolCall[];
  /** The stored items, `service|account` → secret. */
  items(): Record<string, string>;
  seed(items: Record<string, string>): void;
  /** Every next call exits with this code and no output (`null` back to normal). */
  failWith(code: number | null): void;
  cleanup(): void;
}

const COMMON = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const store = path.join(dir, 'items.json');
const read = () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {});
const write = (x) => fs.writeFileSync(store, JSON.stringify(x));
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, stdin }) + '\n');
  const mode = path.join(dir, 'fail.json');
  if (fs.existsSync(mode)) process.exit(JSON.parse(fs.readFileSync(mode, 'utf8')).code);
  main(stdin);
});
const opt = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
`;

// `security`: `-i` reads commands from stdin (only add-generic-password is understood);
// find-generic-password exits 44 when the item does not exist, as the real one does.
const SECURITY = String.raw`
function tokens(line) {
  const out = []; const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g; let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
function main(stdin) {
  const items = read();
  const [cmd, ...rest] = argv;
  if (cmd === '-i') {
    for (const line of stdin.split('\n').filter(Boolean)) {
      const [c, ...args] = tokens(line);
      if (c !== 'add-generic-password') { process.stderr.write('unknown command\n'); continue; }
      items[opt(args, '-s') + '|' + opt(args, '-a')] = opt(args, '-w');
    }
    write(items);
    process.exit(0);
  }
  if (cmd === 'find-generic-password') {
    const k = opt(rest, '-s') + '|' + opt(rest, '-a');
    if (!(k in items)) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'); process.exit(44); }
    if (rest.includes('-w')) process.stdout.write(items[k] + '\n');
    else process.stdout.write('keychain: "/fake/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="' + opt(rest, '-a') + '"\n');
    process.exit(0);
  }
  if (cmd === 'delete-generic-password') {
    const k = opt(rest, '-s') + '|' + opt(rest, '-a');
    if (!(k in items)) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'); process.exit(44); }
    delete items[k]; write(items);
    process.stdout.write('password has been deleted.\n');
    process.exit(0);
  }
  if (cmd === 'dump-keychain') {
    if (rest.includes('-d')) process.exit(99);
    let out = '';
    for (const k of Object.keys(items)) {
      const [svc, acct] = k.split('|');
      out += 'keychain: "/fake/login.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n';
      out += '    0x00000007 <blob>="' + svc + '"\n    0x00000008 <blob>=<NULL>\n';
      out += '    "acct"<blob>="' + acct + '"\n    "cdat"<timedate>=0x32303236313032313030303030305A00  "20261021000000Z\\000"\n';
      out += '    "svce"<blob>="' + svc + '"\n    "type"<uint32>=<NULL>\n';
    }
    process.stdout.write(out);
    process.exit(0);
  }
  process.exit(2);
}
`;

// `secret-tool`: store reads the secret from stdin; lookup prints it without a newline and exits 1
// when missing; search --all prints label/secret on stdout and the attributes on stderr.
const SECRET_TOOL = String.raw`
function attrs(args) { const o = {}; for (let i = 0; i + 1 < args.length; i += 2) o[args[i]] = args[i + 1]; return o; }
function main(stdin) {
  const items = read();
  const [cmd, ...rest] = argv;
  if (cmd === 'store') {
    const a = attrs(rest.filter((x) => !x.startsWith('--label=')));
    items[a.service + '|' + a.account] = stdin;
    write(items);
    process.exit(0);
  }
  if (cmd === 'lookup') {
    const a = attrs(rest); const k = a.service + '|' + a.account;
    if (!(k in items)) process.exit(1);
    process.stdout.write(items[k]);
    process.exit(0);
  }
  if (cmd === 'clear') {
    const a = attrs(rest); delete items[a.service + '|' + a.account]; write(items);
    process.exit(0);
  }
  if (cmd === 'search') {
    const a = attrs(rest.filter((x) => x !== '--all'));
    let n = 0;
    for (const k of Object.keys(items)) {
      const [svc, acct] = k.split('|');
      if (svc !== a.service) continue;
      process.stdout.write('[/org/freedesktop/secrets/collection/login/' + (++n) + ']\nlabel = Ahrena Console (GitHub)\nsecret = ' + items[k] + '\ncreated = 2026-10-21 00:00:00\nmodified = 2026-10-21 00:00:00\nschema = org.freedesktop.Secret.Generic\n');
      process.stderr.write('attribute.account = ' + acct + '\nattribute.service = ' + svc + '\n');
    }
    process.exit(0);
  }
  process.exit(2);
}
`;

function createFakeTool(name: string, body: string): FakeTool {
  const dir = mkdtempSync(join(tmpdir(), `fake-${name}-`));
  const bin = join(dir, name);
  writeFileSync(bin, `#!${process.execPath}\n${COMMON}\n${body}\n`);
  chmodSync(bin, 0o755);
  const store = join(dir, 'items.json');
  return {
    bin,
    dir,
    calls: () => {
      const f = join(dir, 'calls.jsonl');
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeToolCall) : [];
    },
    items: () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {}),
    seed: (items) => writeFileSync(store, JSON.stringify(items)),
    failWith: (code) => {
      const f = join(dir, 'fail.json');
      if (code === null) rmSync(f, { force: true });
      else writeFileSync(f, JSON.stringify({ code }));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const createFakeSecurity = () => createFakeTool('security', SECURITY);
export const createFakeSecretTool = () => createFakeTool('secret-tool', SECRET_TOOL);
