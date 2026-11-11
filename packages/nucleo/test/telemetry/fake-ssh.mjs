// A FAKE `ssh ahrena-tunnel … remote-credential` for the #388 tests (decision 0020, test plan): no network
// beyond loopback, no real machine. Run as `node fake-ssh.mjs <script.json>`; the script (rewritten by the
// test between steps) says what to do:
//
//   { "record": "<file>", "mode": "issue" | "exit" | "slow" | "garbage" | "big" | "other-nonce",
//     "url": "<fake core>", "bearer": "<the fake core's owner token>", "override": { …fields… }, "code": n,
//     "stderr": "<text written to stderr>" }
//
// Every run appends `{ argv, stdin, stdout }` to `record`, so a test can prove what crossed argv and stdin
// (and read back the credential it printed, to play an attacker who has it).
// `issue` posts the stdin request to the fake core's issue route with ITS owner bearer, as the remote CLI
// does, and prints the answer as one line (with `override` merged in); the others play a broken command.
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';

const script = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', async () => {
  const record = (stdout) => appendFileSync(script.record, `${JSON.stringify({ argv: process.argv.slice(2), stdin, stdout })}\n`);
  if (script.stderr) process.stderr.write(script.stderr);
  switch (script.mode) {
    case 'exit':
      record('');
      process.exit(script.code ?? 2);
      break;
    case 'slow':
      record('');
      setTimeout(() => process.exit(0), 60_000);
      break;
    case 'garbage':
      record('not a credential\n');
      process.stdout.write('not a credential\n');
      break;
    case 'big':
      record('');
      process.stdout.write('x'.repeat(5000));
      break;
    default: {
      const answer = await issue(script.url, script.bearer, stdin.trim());
      if (!answer) {
        record('');
        process.exit(12);
      }
      const out = { ...answer, ...(script.override ?? {}) };
      if (script.mode === 'other-nonce') out.nonce = 'f'.repeat(32);
      record(`${JSON.stringify(out)}\n`);
      process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  }
});

function issue(url, bearer, body) {
  return new Promise((resolve) => {
    const u = new URL('/api/owner/remote-credentials', url);
    const req = request(
      u,
      { method: 'POST', agent: false, headers: { host: u.host, authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(text) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.end(body);
  });
}
