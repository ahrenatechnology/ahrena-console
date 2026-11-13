// A FAKE `ssh <host> node --input-type=module - …` for the Update button's tests (issue 462, decision 0022, test
// plan): no network, no real machine. Run as `node fake-update-ssh.mjs <scenario.json> <the rest of the argv>`.
// The scenario (rewritten by the test between steps) says what to do:
//
//   { "record": "<file>", "steps": [ { "out": "<text to stdout>" } | { "sleep": ms } | { "big": bytes } ], "exit": n,
//     "noRead": true, "real": true }
//
// Every run appends `{ argv, script, pid }` to `record`: the argv after the scenario path and the stdin it read
// (the app's script), so a test proves exactly what crossed argv and stdin. With `real`, the stdin is run as the
// update script itself (`node --input-type=module - …`) and its exit code is passed through, as ssh does.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const argv = process.argv.slice(3);
let script = '';
const finish = async () => {
  appendFileSync(scenario.record, `${JSON.stringify({ argv, script, pid: process.pid })}\n`);
  if (scenario.real) {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-', ...argv.filter((a) => a !== '--input-type=module' && a !== '-' && !a.startsWith('--disable-warning'))], { stdio: ['pipe', 'inherit', 'ignore'] });
    child.stdin.end(script);
    child.on('close', (code) => process.exit(code ?? 255));
    return;
  }
  for (const step of scenario.steps ?? []) {
    if (step.out !== undefined) process.stdout.write(step.out);
    else if (step.big) process.stdout.write('x'.repeat(step.big));
    else if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
  }
  process.exit(scenario.exit ?? 0);
};
if (scenario.noRead) void finish();
else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (script += c));
  process.stdin.on('end', () => void finish());
}
