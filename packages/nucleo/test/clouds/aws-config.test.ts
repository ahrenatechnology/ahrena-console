// The ~/.aws/config parser and the SSO cache reader (#277, decision 0013 sections 2 and 3), with
// placeholder names only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { awsConfigPath, parseAwsConfig } from '../../src/clouds/aws-config.ts';
import { readSsoExpiresAt, ssoCacheFileName } from '../../src/clouds/aws-sso-cache.ts';
import { CONFIG } from './fake-aws.ts';

const ok = (text: string) => {
  const r = parseAwsConfig(text);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return r.config;
};

describe('#277 parseAwsConfig', () => {
  test('#277 new format: profiles grouped by sso-session, with account, role and region; host only of the start URL', () => {
    const c = ok(CONFIG);
    const s = c.sessions.find((x) => x.name === 'sessao-exemplo')!;
    assert.equal(s.kind, 'sso-session');
    assert.equal(s.startUrlHost, 'exemplo.awsapps.com');
    assert.equal(s.region, 'regiao-exemplo-1');
    assert.equal(s.loginSupported, true);
    assert.deepEqual(s.profiles, [
      { name: 'perfil-dev', accountId: '111111111111', roleName: 'PapelExemplo', region: 'regiao-exemplo-1' },
      { name: 'perfil-dados', accountId: '222222222222', roleName: 'PapelLeitura', region: 'regiao-exemplo-2' },
    ]);
  });

  test('#277 legacy format: a profile with sso_start_url is a session of its own, named after it', () => {
    const c = ok(CONFIG);
    const s = c.sessions.find((x) => x.name === 'perfil-antigo')!;
    assert.equal(s.kind, 'legacy');
    assert.equal(s.startUrlHost, 'antigo-exemplo.awsapps.com');
    assert.equal(s.loginSupported, true);
    assert.deepEqual(s.profiles, [{ name: 'perfil-antigo', accountId: '333333333333', roleName: 'PapelExemplo', region: null }]);
    assert.deepEqual(
      c.sessions.map((x) => x.name),
      ['sessao-exemplo', 'perfil-antigo'],
    );
  });

  test('#277 profiles without SSO, and one naming a missing sso-session, are out of scope', () => {
    const c = ok(`${CONFIG}\n[profile perfil-orfao]\nsso_session = nao-existe\n`);
    assert.deepEqual(c.outOfScope, [
      { name: 'default', reason: 'no-sso' },
      { name: 'perfil-chave', reason: 'no-sso' },
      { name: 'perfil-orfao', reason: 'missing-sso-session' },
    ]);
  });

  test('#277 a name that cannot go on the command line is listed with loginSupported false', () => {
    const c = ok(`[sso-session sessao com espaco]\nsso_start_url = https://exemplo.awsapps.com/start\n[profile perfil$x]\nsso_start_url = https://exemplo.awsapps.com/start\n[sso-session ${'a'.repeat(65)}]\nsso_start_url = https://exemplo.awsapps.com/start\n`);
    assert.deepEqual(
      c.sessions.map((s) => [s.name, s.loginSupported]),
      [
        ['sessao com espaco', false],
        ['a'.repeat(65), false],
        ['perfil$x', false],
      ],
    );
  });

  test('#277 a legacy profile named like an sso-session is not supported (the route could not tell them apart)', () => {
    const c = ok(`[sso-session igual]\nsso_start_url = https://exemplo.awsapps.com/start\n[profile igual]\nsso_start_url = https://exemplo.awsapps.com/start\n`);
    assert.deepEqual(
      c.sessions.map((s) => [s.kind, s.loginSupported]),
      [
        ['sso-session', true],
        ['legacy', false],
      ],
    );
  });

  test('#277 comments, blank lines and indented sub-keys are accepted', () => {
    const c = ok(`# comentario\n; outro\n[profile perfil-dev]\nsso_session = s1\ns3 =\n  max_concurrent_requests = 20\n[sso-session s1]\nsso_start_url = https://exemplo.awsapps.com/start\n`);
    assert.equal(c.sessions[0]!.profiles[0]!.name, 'perfil-dev');
  });

  test('#277 a parse error reports its line number', () => {
    for (const [text, line] of [
      ['[profile perfil-dev]\nsso_session = s1\nesta linha nao tem igual\n', 3],
      ['chave = fora\n', 1],
      ['[profile perfil-dev\n', 1],
      ['\n\n[]\n', 3],
    ] as const) {
      const r = parseAwsConfig(text);
      assert.equal(r.ok, false, text);
      if (!r.ok) assert.equal(r.line, line, text);
    }
  });

  test('#277 AWS_CONFIG_FILE wins over ~/.aws/config', () => {
    assert.equal(awsConfigPath({}, '/casa'), '/casa/.aws/config');
    assert.equal(awsConfigPath({ AWS_CONFIG_FILE: '/outro/config' }, '/casa'), '/outro/config');
    assert.equal(awsConfigPath({ AWS_CONFIG_FILE: '~/cfg' }, '/casa'), '/casa/cfg');
  });
});

describe('#277 readSsoExpiresAt (variant A)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrena-sso-cache-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const SENTINEL = 'TOKEN-SENTINEL-6f1d2e';

  test('#277 the file is sha1 of the sso-session name, or of the start URL for legacy; only expiresAt comes back', async () => {
    const name = ssoCacheFileName({ kind: 'sso-session', name: 'sessao-exemplo', startUrl: null })!;
    assert.equal(name, `${createHash('sha1').update('sessao-exemplo').digest('hex')}.json`);
    assert.equal(ssoCacheFileName({ kind: 'legacy', name: 'x', startUrl: 'https://antigo-exemplo.awsapps.com/start' }), `${createHash('sha1').update('https://antigo-exemplo.awsapps.com/start').digest('hex')}.json`);
    writeFileSync(join(dir, name), JSON.stringify({ startUrl: 'https://exemplo.awsapps.com/start', region: 'regiao-exemplo-1', accessToken: SENTINEL, refreshToken: SENTINEL, clientSecret: SENTINEL, expiresAt: '2026-10-22T20:00:00Z' }));
    const got = await readSsoExpiresAt(dir, { kind: 'sso-session', name: 'sessao-exemplo', startUrl: null });
    assert.equal(got, '2026-10-22T20:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(got), new RegExp(SENTINEL));

    const legacy = ssoCacheFileName({ kind: 'legacy', name: 'perfil-antigo', startUrl: 'https://antigo-exemplo.awsapps.com/start' })!;
    assert.notEqual(legacy, name);
    writeFileSync(join(dir, legacy), JSON.stringify({ accessToken: SENTINEL, expiresAt: '2026-10-22T21:00:00UTC' }));
    assert.equal(await readSsoExpiresAt(dir, { kind: 'legacy', name: 'perfil-antigo', startUrl: 'https://antigo-exemplo.awsapps.com/start' }), '2026-10-22T21:00:00.000Z');
  });

  test('#277 no file, a broken file, no expiresAt or a file too large: null', async () => {
    assert.equal(await readSsoExpiresAt(dir, { kind: 'sso-session', name: 'nao-existe', startUrl: null }), null);
    const key = { kind: 'sso-session' as const, name: 'quebrado', startUrl: null };
    writeFileSync(join(dir, ssoCacheFileName(key)!), `{ "accessToken": "${SENTINEL}", `);
    assert.equal(await readSsoExpiresAt(dir, key), null);
    writeFileSync(join(dir, ssoCacheFileName(key)!), JSON.stringify({ accessToken: SENTINEL }));
    assert.equal(await readSsoExpiresAt(dir, key), null);
    writeFileSync(join(dir, ssoCacheFileName(key)!), JSON.stringify({ accessToken: 'x'.repeat(70_000), expiresAt: '2026-10-22T20:00:00Z' }));
    assert.equal(await readSsoExpiresAt(dir, key), null);
    assert.equal(await readSsoExpiresAt(dir, { kind: 'legacy', name: 'sem-url', startUrl: null }), null);
  });
});
