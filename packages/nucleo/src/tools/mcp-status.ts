// The state of each MCP server (#280, decision 0014 section 6), from `claude mcp list`, run only when
// the person asks (Verificar conexões, `POST /api/tools/mcp/checks`): the command starts every stdio
// server, so a GET never runs it.
//
// The output has one line per server: `<name>: <command or URL> - <status>`. Only the name and the
// status are read; the middle (the command with its args, the URL with its query) is never kept,
// logged or returned. Lines that do not look like a server are ignored.

export type McpState = 'connected' | 'failed' | 'needs-login' | 'unknown';

export const MCP_LIST_TIMEOUT_MS = 60_000;

const LINE = /^([^\s:][^\s]{0,127}?):\s.*\s-\s(.{1,200}?)\s*$/;

function stateOf(status: string): McpState {
  const s = status.toLowerCase();
  if (/needs? auth|authenticat|login|log in|sign in/.test(s)) return 'needs-login';
  if (/✗|fail|error|disconnected|not connected|timed? ?out/.test(s)) return 'failed';
  if (/✓|connected/.test(s)) return 'connected';
  return 'unknown';
}

/** Server name → state, from the output of `claude mcp list`. */
export function parseMcpList(stdout: string): Map<string, McpState> {
  const out = new Map<string, McpState>();
  for (const raw of stdout.split(/\r?\n/)) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    out.set(m[1]!, stateOf(m[2]!));
  }
  return out;
}
