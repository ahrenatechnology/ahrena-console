// Fixtures of the MCP tests (#280 layer 3): a fake secret, Claude Code's config files holding it in
// every place a secret can hide, and an output of `claude mcp list` that repeats it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET = 'FAKE-SECRET-d41d8cd9';

export const MCP_LIST_OUTPUT = [
  'Checking MCP server health...',
  '',
  `playwright: npx -y @playwright/mcp@0.0.41 --token ${SECRET} - ✓ Connected`,
  `docs: https://mcp.exemplo.dev/mcp?key=${SECRET} (HTTP) - ⚠ Needs authentication`,
  `db: docker run -e PGPASSWORD=${SECRET} exemplo - ✗ Failed to connect`,
  'plugin:data:exemplo: https://exemplo.dev/mcp (HTTP) - ✓ Connected',
  'odd: x - something new',
  'not a server line',
].join('\n');

/**
 * A temp HOME with `.claude.json` and a project with `.mcp.json`, the secret as an env value, an
 * Authorization header value, URL userinfo, a query param and a non-package arg.
 * `playwright` (user scope, no env, no headers) is pinned at `playwrightVersion`.
 */
export function writeMcpConfig(root: string, o: { playwrightVersion?: string } = {}): { home: string; project: string } {
  const home = join(root, 'home');
  const project = join(root, 'Workspace', 'catalogo-exemplo');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'ahrena-console': { type: 'stdio', command: 'node', args: ['--disable-warning=ExperimentalWarning', '/Users/exemplo/ahrena-console/packages/nucleo/src/mcp/cli.ts'], env: {} },
        playwright: { type: 'stdio', command: 'npx', args: ['-y', `@playwright/mcp@${o.playwrightVersion ?? '0.0.41'}`] },
        docs: { type: 'http', url: `https://user:${SECRET}@mcp.exemplo.dev/mcp/${SECRET}?key=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
        tracker: { command: '/usr/local/bin/exemplo-tracker', args: ['--api-key', SECRET, SECRET], env: { TRACKER_TOKEN: SECRET } },
      },
      projects: {
        [project]: { mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.40', SECRET] } } },
      },
    }),
  );
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'docker', args: ['run', '-e', `PGPASSWORD=${SECRET}`, 'exemplo'], env: { PGHOST: 'localhost', PGPASSWORD: SECRET } } } }));
  return { home, project };
}
