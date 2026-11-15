// The server the contract tests drive (#662): the demo server of the API tests with every optional
// route turned on, each by a stand-in that answers `200 {}`. A route the server does not serve falls
// through to the router's unknown-route answer; a stand-in only has to be reached to prove the route
// is wired, so its answer carries no meaning and no test reads it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiOptions } from '../../src/api/index.ts';
import { GithubConnection } from '../../src/github/connection/connection.ts';
import { send } from '../../src/ingest/hooks/receiver.ts';
import { serverWithoutCore } from '../../src/mcp/index.ts';
import { MemoryInstallationSettings } from '../../src/settings/installation-settings.ts';
import { OWNER_TOKEN, ownerFetch } from '../owner-http.ts';
import { startDemoApi, type DemoApi } from './demo-api.ts';

export interface ContractProbeServer {
  /** The base address, `http://127.0.0.1:<port>`. */
  url: string;
  /** A request with the owner's bearer, as the core's own clients make it. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

const answer = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => send(res, 200, {});
const answerRead = async (res: ServerResponse): Promise<void> => send(res, 200, {});

/** GitHub switched off: the connection answers its status and refuses every action, and nothing leaves the process. */
const connection = new GithubConnection({ vault: null, settings: new MemoryInstallationSettings(), off: true });

/** The options the demo server leaves out, each turned on by a stand-in. */
const stands: Partial<ApiOptions> = {
  mcp: serverWithoutCore('the contract probe'),
  agentInstructions: answerRead,
  decisions: answerRead,
  frameworkInstall: answer,
  agentConfig: answer,
  clouds: answer,
  appUpdate: answer,
  machineConnection: answer,
  coreUpdate: answer,
  messaging: answer,
  orders: answer,
  transcription: answer,
  docker: { route: answer, acceptNoOrigin: () => false },
  ports: { handle: answer, acceptNoOrigin: () => false },
  ownerProofRetry: async () => null,
  devConsole: { overview: async () => ({ generatedAt: '2026-11-14T12:00:00.000Z', readAt: null, stale: false, staleReason: null, contexts: [], mergeQueue: [] }), view: async () => null },
  githubSync: { status: () => ({ active: false, pausedUntil: null, steps: [] }) },
  connection,
};

export async function startContractProbeServer(): Promise<ContractProbeServer> {
  const demo: DemoApi = await startDemoApi({ extra: stands });
  return {
    url: demo.api.url,
    fetch: (path, init) => ownerFetch(`${demo.api.url}${path}`, init),
    close: demo.close,
  };
}

export { OWNER_TOKEN };
