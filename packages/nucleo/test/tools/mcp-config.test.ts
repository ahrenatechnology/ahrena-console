// #280 layer 3, decision 0014 section 6: the MCP server reader. What a row keeps (names, counts, the
// command's name, the pinned package, the URL's host) and what the parser drops (every value of env
// and headers, the other args, the URL's path, query and userinfo), the transports, malformed files,
// the size caps, the project cap and the symlink rule of `.mcp.json`. Temp folders only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { MAX_MCP_JSON_BYTES, packageOf, parseClaudeJson, parseMcpJson, parseServer, readMcpServers } from '../../src/tools/mcp-config.ts';

const SECRET = 'FAKE-SECRET-d41d8cd9';
const HOME = '/Users/exemplo';
const dir = mkdtempSync(join(tmpdir(), 'ahrena-mcp-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('#280 MCP parser: one server', () => {
  test('stdio: the command name, the pinned package, env names and count; no value, no other arg', () => {
    const s = parseServer('playwright', { command: '/opt/homebrew/bin/npx', args: ['-y', '@playwright/mcp@0.0.41', '--token', SECRET], env: { API_KEY: SECRET, OTHER: 'x' } }, 'user', null, HOME)!;
    assert.deepEqual(
      { ...s, key: typeof s.key },
      { key: 'string', name: 'playwright', scope: 'user', project: null, transport: 'stdio', command: 'npx', package: '@playwright/mcp', version: '0.0.41', host: null, envCount: 2, envNames: ['API_KEY', 'OTHER'], headerCount: 0, headerNames: [] },
    );
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.match(s.key, /^[0-9a-f]{12}$/);
  });

  test('http and sse: the host only (port kept), header names and count; no path, query, userinfo or value', () => {
    const h = parseServer('docs', { type: 'http', url: `https://user:${SECRET}@mcp.exemplo.dev:8443/v1/${SECRET}?key=${SECRET}#${SECRET}`, headers: { Authorization: `Bearer ${SECRET}`, 'X-Team': SECRET } }, 'user', null, HOME)!;
    assert.equal(h.transport, 'http');
    assert.equal(h.host, 'mcp.exemplo.dev:8443');
    assert.equal(h.command, null);
    assert.deepEqual([h.headerCount, h.headerNames], [2, ['Authorization', 'X-Team']]);
    assert.ok(!JSON.stringify(h).includes(SECRET));
    const s = parseServer('events', { type: 'sse', url: 'http://127.0.0.1:9/sse' }, 'user', null, HOME)!;
    assert.deepEqual([s.transport, s.host], ['sse', '127.0.0.1:9']);
    assert.equal(parseServer('bare', { url: 'https://exemplo.dev/mcp' }, 'user', null, HOME)!.transport, 'http', 'a url without type is http');
    assert.equal(parseServer('typed', { type: 'stdio', command: 'exemplo-mcp' }, 'user', null, HOME)!.transport, 'stdio');
  });

  test('what is not a server, or not a safe name, is dropped', () => {
    assert.equal(parseServer('ide', { type: 'sse-ide', url: 'http://127.0.0.1:1/sse' }, 'user', null, HOME), null);
    assert.equal(parseServer('none', {}, 'user', null, HOME), null);
    assert.equal(parseServer('str', 'npx', 'user', null, HOME), null);
    assert.equal(parseServer('bad name\n', { command: 'x' }, 'user', null, HOME), null);
    const ftp = parseServer('ftp', { type: 'http', url: `ftp://${SECRET}@exemplo.dev/` }, 'user', null, HOME)!;
    assert.equal(ftp.host, null, 'only http(s) URLs give a host');
    const bad = parseServer('bad', { type: 'http', url: `not a url ${SECRET}` }, 'user', null, HOME)!;
    assert.equal(bad.host, null);
    const odd = parseServer('odd', { command: `${SECRET} --x`, env: { [`bad name ${SECRET}`]: SECRET, OK: 1 }, headers: [SECRET] }, 'user', null, HOME)!;
    assert.equal(odd.command, null, 'a command that is not a plain executable name gives no name');
    assert.deepEqual([odd.envCount, odd.envNames], [2, ['OK']], 'a key that is not a variable name is counted, not named');
    assert.deepEqual([odd.headerCount, odd.headerNames], [0, []]);
    assert.ok(!JSON.stringify([ftp, bad, odd]).includes(SECRET));
  });

  test('the project label is the folder name, never the path', () => {
    const s = parseServer('db', { command: 'docker' }, 'project', '/Users/exemplo/Workspace/catalogo-exemplo', HOME)!;
    assert.equal(s.project, 'catalogo-exemplo');
    assert.equal(parseServer('db', { command: 'docker' }, 'local', HOME, HOME)!.project, '~');
    assert.equal(parseServer('db', { command: 'docker' }, 'local', 'C:\\Users\\exemplo\\repo', 'C:\\Users\\exemplo')!.project, 'repo');
    const a = parseServer('db', { command: 'docker' }, 'project', '/a/repo', HOME)!;
    const b = parseServer('db', { command: 'docker' }, 'project', '/b/repo', HOME)!;
    assert.notEqual(a.key, b.key, 'same name and label in two folders: two keys');
  });
});

describe('#280 MCP parser: the package pinned in the args', () => {
  test('scoped and unscoped with a version; scoped without one; nothing else', () => {
    assert.deepEqual(packageOf(['-y', '@playwright/mcp@0.0.41']), { package: '@playwright/mcp', version: '0.0.41' });
    assert.deepEqual(packageOf(['exemplo-mcp@1.2.3', '--port', '3']), { package: 'exemplo-mcp', version: '1.2.3' });
    assert.deepEqual(packageOf(['@playwright/mcp@latest']), { package: '@playwright/mcp', version: null });
    assert.deepEqual(packageOf(['@playwright/mcp']), { package: '@playwright/mcp', version: null });
    assert.deepEqual(packageOf(['-y', 'exemplo-mcp']), { package: null, version: null }, 'an unscoped bare word could be anything');
    assert.deepEqual(packageOf([`${SECRET}@1.0.0`]), { package: null, version: null }, 'npm names are lower case');
    assert.deepEqual(packageOf(['exemplo@1.2.3-beta.1']), { package: 'exemplo', version: null }, 'a prerelease is not a version the catalog pins');
    assert.deepEqual(packageOf([42, null, 'x@1']), { package: 'x', version: '1' });
  });
});

describe('#280 MCP parser: the files', () => {
  test('~/.claude.json: user scope and each project\'s local scope; a project cap', () => {
    const text = JSON.stringify({
      oauthAccount: { emailAddress: 'exemplo@exemplo.dev' },
      mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.41'] } },
      projects: {
        '/Users/exemplo/a': { mcpServers: { one: { command: 'one' } } },
        '/Users/exemplo/b': { mcpServers: {} },
        '/Users/exemplo/c': { mcpServers: { two: { command: 'two' }, three: { type: 'http', url: 'https://exemplo.dev' } } },
        '/Users/exemplo/d': { mcpServers: { four: { command: 'four' } } },
      },
    });
    const all = parseClaudeJson(text, { home: HOME });
    assert.deepEqual(all.map((s) => [s.scope, s.project, s.name]), [['user', null, 'playwright'], ['local', 'a', 'one'], ['local', 'c', 'two'], ['local', 'c', 'three'], ['local', 'd', 'four']]);
    const capped = parseClaudeJson(text, { home: HOME, maxProjects: 2 });
    assert.deepEqual(capped.map((s) => s.name), ['playwright', 'one', 'two', 'three'], 'two projects with servers, empty ones not counted');
  });

  test('.mcp.json: project scope; malformed files give nothing', () => {
    assert.deepEqual(parseMcpJson(JSON.stringify({ mcpServers: { db: { command: 'docker', env: { PGPASSWORD: SECRET } } } }), '/w/repo', HOME).map((s) => [s.scope, s.project, s.name, s.envNames]), [['project', 'repo', 'db', ['PGPASSWORD']]]);
    for (const bad of ['', '{', 'null', '[]', '"x"', JSON.stringify({ mcpServers: [1] }), JSON.stringify({ mcpServers: 'x' })]) {
      assert.deepEqual(parseMcpJson(bad, '/w/repo', HOME), [], bad);
      assert.deepEqual(parseClaudeJson(bad, { home: HOME }), [], bad);
    }
    assert.deepEqual(parseClaudeJson(JSON.stringify({ projects: { '/x': 1, '/y': { mcpServers: 2 } } }), { home: HOME }), []);
  });

  test('a cap on servers per file', () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`s${i}`, { command: 'x' }]));
    assert.equal(parseMcpJson(JSON.stringify({ mcpServers: many }), '/w/repo', HOME).length, 100);
  });
});

describe('#280 MCP reader: from disk', () => {
  test('reads ~/.claude.json and each project\'s .mcp.json; dedupes; a missing file is no error', async () => {
    const home = join(dir, 'home-1');
    const repo = join(dir, 'repo-1');
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } }, projects: { [repo]: { mcpServers: { b: { command: 'b' } } } } }));
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { c: { command: 'c' } } }));
    const logs: string[] = [];
    const servers = await readMcpServers({ home, claudeJsonPath: join(home, '.claude.json'), projects: [repo, repo, join(dir, 'nowhere')], log: (m) => logs.push(m) });
    assert.deepEqual(servers.map((s) => [s.scope, s.project, s.name]), [['user', null, 'a'], ['local', 'repo-1', 'b'], ['project', 'repo-1', 'c']]);
    assert.deepEqual(logs, []);
    assert.deepEqual(await readMcpServers({ home, claudeJsonPath: join(home, 'missing.json'), projects: [] }), []);
  });

  test('size caps: an oversized file is skipped with a log line that names no value', async () => {
    const home = join(dir, 'home-2');
    const repo = join(dir, 'repo-2');
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a', env: { K: SECRET } } }, pad: 'x'.repeat(2000) }));
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { c: { command: 'c' } }, pad: 'x'.repeat(MAX_MCP_JSON_BYTES) }));
    const logs: string[] = [];
    const servers = await readMcpServers({ home, claudeJsonPath: join(home, '.claude.json'), projects: [repo], maxClaudeJsonBytes: 1000, log: (m) => logs.push(m) });
    assert.deepEqual(servers, []);
    assert.equal(logs.length, 2);
    assert.ok(logs.every((l) => !l.includes(SECRET)));
  });

  test('malformed JSON: skipped, logged without content', async () => {
    const home = join(dir, 'home-3');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.claude.json'), `{"mcpServers": {"a": {"env": {"K": "${SECRET}"`);
    const logs: string[] = [];
    assert.deepEqual(await readMcpServers({ home, claudeJsonPath: join(home, '.claude.json'), projects: [], log: (m) => logs.push(m) }), []);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes(SECRET));
  });

  test('.mcp.json: a symlink that leaves the project is not followed; one inside it is', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'servers.json'), JSON.stringify({ mcpServers: { escaped: { command: 'x' } } }));
    const repo = join(dir, 'repo-link');
    mkdirSync(join(repo, 'config'), { recursive: true });
    symlinkSync(join(outside, 'servers.json'), join(repo, '.mcp.json'));
    const logs: string[] = [];
    assert.deepEqual(await readMcpServers({ home: dir, claudeJsonPath: join(dir, 'none.json'), projects: [repo], log: (m) => logs.push(m) }), []);
    assert.equal(logs.length, 1);

    const inside = join(dir, 'repo-link-inside');
    mkdirSync(join(inside, 'config'), { recursive: true });
    writeFileSync(join(inside, 'config', 'mcp.json'), JSON.stringify({ mcpServers: { kept: { command: 'x' } } }));
    symlinkSync(join(inside, 'config', 'mcp.json'), join(inside, '.mcp.json'));
    assert.deepEqual((await readMcpServers({ home: dir, claudeJsonPath: join(dir, 'none.json'), projects: [inside] })).map((s) => s.name), ['kept']);
  });

  test('a directory named .mcp.json, and the project cap', async () => {
    const repos = Array.from({ length: 5 }, (_, i) => join(dir, `cap-${i}`));
    for (const r of repos) {
      mkdirSync(r, { recursive: true });
      writeFileSync(join(r, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'x' } } }));
    }
    const weird = join(dir, 'weird');
    mkdirSync(join(weird, '.mcp.json'), { recursive: true });
    assert.equal((await readMcpServers({ home: dir, claudeJsonPath: join(dir, 'none.json'), projects: [weird, ...repos], maxProjects: 3 })).length, 2, 'the cap is on the projects looked at');
  });
});
