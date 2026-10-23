// #280 layer 3: the output of `claude mcp list` read by server name (connected, failed, needs
// authentication); the command and URL in the middle of each line are never kept.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseMcpList } from '../../src/tools/mcp-status.ts';

import { MCP_LIST_OUTPUT, SECRET } from './mcp-fixtures.ts';

describe('#280 claude mcp list', () => {
  test('reads the state by server name; nothing else of the line is kept', () => {
    const m = parseMcpList(MCP_LIST_OUTPUT);
    assert.deepEqual([...m], [
      ['playwright', 'connected'],
      ['docs', 'needs-login'],
      ['db', 'failed'],
      ['plugin:data:exemplo', 'connected'],
      ['odd', 'unknown'],
    ]);
    assert.ok(!JSON.stringify([...m]).includes(SECRET));
  });

  test('empty or unrelated output: no state', () => {
    assert.equal(parseMcpList('').size, 0);
    assert.equal(parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.\n').size, 0);
  });
});
