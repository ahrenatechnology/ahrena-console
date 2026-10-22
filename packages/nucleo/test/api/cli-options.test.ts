// The API command line options (src/api/cli-options.ts): the English names; the old Portuguese ones
// left in phase 6 of #173 and are refused like any unknown option.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { HELP, parseApiOptions } from '../../src/api/cli-options.ts';
import { DEMO_GITHUB_STATES } from '../../src/simulator/demo-github-connection.ts';

const CLI = fileURLToPath(new URL('../../src/api/cli.ts', import.meta.url));

describe('API command line options (#173)', () => {
  test('the defaults', () => {
    assert.deepEqual(parseApiOptions([]), {
      port: undefined,
      installation: undefined,
      dataDir: undefined,
      db: undefined,
      projects: undefined,
      scanInterval: '30',
      noHistory: false,
      noDesktop: false,
      noGithub: false,
      demo: false,
      scenario: 'p1',
      parent: undefined,
      replace: false,
      noLock: false,
      noTelemetry: false,
      machines: undefined,
      demoGithub: undefined,
      demoProject: undefined,
      help: false,
    });
  });

  test('every English name', () => {
    const fresh = parseApiOptions(['--port', '4799', '--db', '/tmp/x.sqlite', '--projects', '/p', '--scan-interval', '5', '--no-history', '--no-desktop', '--no-github', '--demo', '--scenario', 'p4', '--parent', '123', '--replace', '--no-lock', '--no-telemetry', '--machines', '/m.json', '--demo-github', 'pending', '--demo-project', 'none']);
    assert.deepEqual(fresh, {
      port: '4799',
      installation: undefined,
      dataDir: undefined,
      db: '/tmp/x.sqlite',
      projects: '/p',
      scanInterval: '5',
      noHistory: true,
      noDesktop: true,
      noGithub: true,
      demo: true,
      scenario: 'p4',
      parent: '123',
      replace: true,
      noLock: true,
      noTelemetry: true,
      machines: '/m.json',
      demoGithub: 'pending',
      demoProject: 'none',
      help: false,
    });
  });

  test('the old Portuguese names are refused (#173, phase 6)', () => {
    for (const old of ['--porta', '--banco', '--projetos', '--varredura', '--sem-historico', '--sem-desktop', '--sem-github', '--cenario', '--pai', '--substituir', '--sem-trava']) {
      assert.throws(() => parseApiOptions([old, '1']), /Unknown option/, old);
    }
  });

  test('#221: --installation and --data-dir', () => {
    const o = parseApiOptions(['--installation', 'app', '--data-dir', '/data/app']);
    assert.equal(o.installation, 'app');
    assert.equal(o.dataDir, '/data/app');
  });

  test('the help lists the English names and none of the old ones', () => {
    for (const name of ['--port <n>', '--installation <i>', '--data-dir <folder>', '--db <file>', '--projects <folder>', '--scan-interval <s>', '--no-history', '--no-desktop', '--no-github', '--demo', '--scenario <p1..p13>', '--parent <pid>', '--replace', '--no-lock', '--no-telemetry', '--machines <file>', '--demo-github <state>', '--demo-project <p>', '--help']) assert.ok(HELP.includes(name), name);
    assert.doesNotMatch(HELP, /^\s+--(porta|banco|projetos|varredura|sem-historico|sem-desktop|sem-github|cenario|pai|substituir|sem-trava)\b/m);
    assert.doesNotMatch(HELP, /old names|--porta|--sem-/);
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--help'], { encoding: 'utf8' });
    assert.equal(out, HELP);
  });

  test('#241: the help lists every --demo-github state and says the demo never reaches the real GitHub or Keychain', () => {
    for (const state of DEMO_GITHUB_STATES) assert.ok(HELP.includes(state), state);
    assert.match(HELP, /AHRENA_CONSOLE_GITHUB_CLIENT_ID/);
    assert.match(HELP, /AHRENA_CONSOLE_GITHUB_SOURCE=gh/);
    assert.match(HELP, /AHRENA_CONSOLE_PROJECT/);
    assert.match(HELP, /AHRENA_CONSOLE_VAULT=keychain\|secret-service\|memory\|none/);
    assert.doesNotMatch(HELP, /with the \`gh\` token/);
  });

  test('an unknown option is refused', () => {
    assert.throws(() => parseApiOptions(['--sem-nada']), /Unknown option/);
  });
});
