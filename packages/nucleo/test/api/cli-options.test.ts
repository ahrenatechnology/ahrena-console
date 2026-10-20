// The API command line options (src/api/cli-options.ts): the English names, the old Portuguese ones
// still accepted until phase 6 of #173 (src/owner/start.ts passes `--porta` and `--pai`), and the new
// one winning when both are given.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { HELP, parseApiOptions } from '../../src/api/cli-options.ts';

const CLI = fileURLToPath(new URL('../../src/api/cli.ts', import.meta.url));

describe('API command line options (#173)', () => {
  test('the defaults', () => {
    assert.deepEqual(parseApiOptions([]), {
      port: undefined,
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
      help: false,
    });
  });

  test('the new names and the old ones give the same options', () => {
    const fresh = parseApiOptions(['--port', '4799', '--db', '/tmp/x.sqlite', '--projects', '/p', '--scan-interval', '5', '--no-history', '--no-desktop', '--no-github', '--demo', '--scenario', 'p4', '--parent', '123', '--replace', '--no-lock', '--no-telemetry', '--machines', '/m.json']);
    const old = parseApiOptions(['--porta', '4799', '--banco', '/tmp/x.sqlite', '--projetos', '/p', '--varredura', '5', '--sem-historico', '--sem-desktop', '--sem-github', '--demo', '--cenario', 'p4', '--pai', '123', '--substituir', '--sem-trava', '--no-telemetry', '--machines', '/m.json']);
    assert.deepEqual(old, fresh);
    assert.deepEqual(fresh, {
      port: '4799',
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
      help: false,
    });
  });

  test('the new name wins over the old one, in either order', () => {
    for (const args of [
      ['--port', '1', '--porta', '2', '--db', 'new.sqlite', '--banco', 'old.sqlite', '--projects', '/new', '--projetos', '/old', '--scan-interval', '7', '--varredura', '9', '--scenario', 'p2', '--cenario', 'p3', '--parent', '11', '--pai', '22'],
      ['--porta', '2', '--port', '1', '--banco', 'old.sqlite', '--db', 'new.sqlite', '--projetos', '/old', '--projects', '/new', '--varredura', '9', '--scan-interval', '7', '--cenario', 'p3', '--scenario', 'p2', '--pai', '22', '--parent', '11'],
    ]) {
      const o = parseApiOptions(args);
      assert.deepEqual([o.port, o.db, o.projects, o.scanInterval, o.scenario, o.parent], ['1', 'new.sqlite', '/new', '7', 'p2', '11'], args.join(' '));
    }
  });

  test('the help lists the new names, hides the old ones and says they are accepted until phase 6', () => {
    for (const name of ['--port <n>', '--db <file>', '--projects <folder>', '--scan-interval <s>', '--no-history', '--no-desktop', '--no-github', '--demo', '--scenario <p1..p13>', '--parent <pid>', '--replace', '--no-lock', '--no-telemetry', '--machines <file>', '--help']) assert.ok(HELP.includes(name), name);
    assert.doesNotMatch(HELP, /^\s+--(porta|banco|projetos|varredura|sem-historico|sem-desktop|sem-github|cenario|pai|substituir|sem-trava)\b/m);
    assert.match(HELP, /The old names \(--porta, --banco, --projetos, --varredura, --sem-historico, --sem-desktop, --sem-github, --cenario, --pai, --substituir, --sem-trava\) are accepted until phase 6\./);
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--help'], { encoding: 'utf8' });
    assert.equal(out, HELP);
  });

  test('an unknown option is refused', () => {
    assert.throws(() => parseApiOptions(['--sem-nada']), /Unknown option/);
  });
});
