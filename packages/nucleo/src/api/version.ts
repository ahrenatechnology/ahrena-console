// The core's version, in `/api/overview`, the panel's footer, the instance registry and the MCP
// `serverInfo`. It is this package's `version`, which follows the desktop app's (issue #261): the
// release bumps both, and the app's `cargo test` checks they match.
import { readFileSync } from 'node:fs';

export const API_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** @deprecated phase 6: src/owner still imports it */
export const VERSAO_DA_API = API_VERSION;
