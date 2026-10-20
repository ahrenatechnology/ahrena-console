// O módulo puro da configuração de um agente (src/agent-config/parse.ts): o que o Agent Config (#63)
// e a aba Instruções (#183) leem do mesmo jeito, sem disco.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ENABLED_MARK,
  enabledPluginKeys,
  hooksOf,
  marketplacesOf,
  mcpServersOf,
  parseJsonObject,
  parseJsonShape,
  pluginsOf,
  readFrontmatter,
  readFrontmatterLists,
} from '../../src/agent-config/parse.ts';

describe('agent-config/parse', () => {
  test('hooksOf: event, count and matchers; never the command; odd shapes count 0', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'rm -rf /tmp/x' }, { type: 'command', command: 'echo 2' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'echo 3' }] },
          { matcher: 42 },
        ],
        Stop: 'x',
      },
    };
    const hooks = hooksOf(settings);
    assert.deepEqual(hooks, [
      { event: 'PreToolUse', count: 3, matchers: ['Bash'] },
      { event: 'Stop', count: 0, matchers: [] },
    ]);
    assert.ok(!JSON.stringify(hooks).includes('rm -rf'));
    assert.deepEqual(hooksOf(undefined), []);
    assert.deepEqual(hooksOf({ hooks: [] }), []);
  });

  test('pluginsOf: only true entries, with the marketplace; enabledPluginKeys takes the value-free mark', () => {
    assert.deepEqual(pluginsOf({ enabledPlugins: { 'a@m': true, 'b@m': false, loose: true, 'c@': true } }), [
      { name: 'a', marketplace: 'm' },
      { name: 'loose', marketplace: null },
      { name: 'c', marketplace: null },
    ]);
    const shape = parseJsonShape('{"enabledPlugins":{"a@m":true,"b@m":false},"env":{"TOKEN":"abc"}}');
    assert.deepEqual(enabledPluginKeys(shape, ENABLED_MARK), ['a@m']);
    assert.ok(!JSON.stringify(shape).includes('abc'), 'the shape parse keeps no value');
  });

  test('marketplaces, MCP servers and JSON parsing', () => {
    assert.deepEqual(marketplacesOf({ extraKnownMarketplaces: { team: {}, other: {} } }), ['team', 'other']);
    assert.deepEqual(mcpServersOf({ mcpServers: { a: { command: 'x' }, b: {} } }), ['a', 'b']);
    assert.deepEqual(mcpServersOf(undefined), []);
    assert.equal(parseJsonObject('{ broken'), undefined);
    assert.equal(parseJsonObject('[1]'), undefined);
    assert.equal(parseJsonShape('nope'), null);
  });

  test('frontmatter: text fields, and the lists readFrontmatter ignores', () => {
    const text = '---\nname: release\ndescription: "Publica: a versão"\npaths:\n  - "src/**"\n  - test/**\nglobs: [a/*, "b/*"]\nsingle: lib/**\n---\nbody\n';
    assert.deepEqual(readFrontmatter(text).name, 'release');
    assert.deepEqual(readFrontmatter(text).description, 'Publica: a versão');
    const lists = readFrontmatterLists(text);
    assert.deepEqual(lists.paths, ['src/**', 'test/**']);
    assert.deepEqual(lists.globs, ['a/*', 'b/*']);
    assert.deepEqual(lists.single, ['lib/**']);
    assert.deepEqual(readFrontmatterLists('no frontmatter'), {});
  });
});
