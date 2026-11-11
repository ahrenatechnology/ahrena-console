// `core remote-credential --port <n>` (decision 0020 section 1, #388): the command the Mac runs over the SSH
// that already entered this machine. It reads one request line from stdin, finds this user's core on that
// port, reads its lock token, asks the core for a short credential and prints the answer as ONE JSON line.
//
// The result is data, not a process exit, so tests drive it without a subprocess: `code` is the exit code,
// `stdout` is exactly what to print (empty unless 0), `stderr` is one fixed English message. No message
// ever carries the token, the key, a credential id or text from the core.
//
//   0  issued
//   10 no core of this user on that port, or its lock is not readable (foreign uid, group/other bits,
//      symlink, wrong port or pid): the core receives no request at all
//   11 the core has no such route (it is older than decision 0020: 404)
//   12 anything else (bad request on stdin, refused, no answer, bad answer)

import { request } from 'node:http';
import { listInstances, verifyInstance, type Instance } from './registry.ts';
import { readOwnerToken } from './lock-token.ts';

export const MAX_REQUEST_BYTES = 1024;
export const MAX_ANSWER_BYTES = 4096;
const ISSUE_PATH = '/api/owner/remote-credentials';
const HEX32 = /^[0-9a-f]{32}$/;

export interface RemoteCredentialRun {
  code: 0 | 10 | 11 | 12;
  stdout: string;
  stderr: string;
}

export interface RemoteCredentialOptions {
  port: number;
  /** What came on stdin. */
  input: string;
  /** The console home whose instance registry is read; default `~/.ahrena-console`. */
  home?: string;
  /** The uid that must own the lock; default this process's. Injected by tests to play a foreign owner. */
  uid?: number;
  timeoutMs?: number;
}

const FIXED = {
  10: 'no core of this user on that port, or its lock is not readable\n',
  11: 'the core does not support remote credentials\n',
  12: 'could not issue a credential\n',
} as const;

const fail = (code: 10 | 11 | 12): RemoteCredentialRun => ({ code, stdout: '', stderr: FIXED[code] });

function parseRequest(input: string): { nonce: string; revoke: string[] } | null {
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'version' && k !== 'nonce' && k !== 'revoke')) return null;
  if (o.version !== 1 || typeof o.nonce !== 'string' || !HEX32.test(o.nonce)) return null;
  const revoke = o.revoke === undefined ? [] : o.revoke;
  if (!Array.isArray(revoke) || revoke.length > 3 || !revoke.every((id) => typeof id === 'string' && HEX32.test(id))) return null;
  return { nonce: o.nonce, revoke: revoke as string[] };
}

function post(port: number, token: string, body: string, timeoutMs: number): Promise<{ status: number; text: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: { status: number; text: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(v);
    };
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: ISSUE_PATH,
        method: 'POST',
        agent: false,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) return finish(null);
          chunks.push(c);
        });
        res.on('end', () => finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => finish(null));
      },
    );
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    req.on('error', () => finish(null));
    req.end(body);
  });
}

/** The answer re-serialized from the fields the Mac reads, so nothing else the core says is relayed. */
function relay(text: string, nonce: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (a.version !== 1 || a.nonce !== nonce) return null;
  if (typeof a.credentialId !== 'string' || !HEX32.test(a.credentialId) || typeof a.generation !== 'string' || !HEX32.test(a.generation)) return null;
  if (typeof a.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.key) || typeof a.machineIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(a.machineIdentity)) return null;
  if (!num(a.uid) || !num(a.corePid) || !num(a.corePort) || !num(a.issuedAt) || !num(a.expiresAt)) return null;
  const { version, nonce: n, credentialId, key, machineIdentity, uid, corePid, corePort, generation, issuedAt, expiresAt } = a;
  return `${JSON.stringify({ version, nonce: n, credentialId, key, machineIdentity, uid, corePid, corePort, generation, issuedAt, expiresAt })}\n`;
}

export async function runRemoteCredential(o: RemoteCredentialOptions): Promise<RemoteCredentialRun> {
  const request = parseRequest(o.input);
  if (!request || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return fail(12);

  // This user's core on that port: the registry lives in this user's home, and the lock must be this uid's.
  const uid = o.uid ?? process.getuid?.();
  let token: string | null = null;
  let instance: Instance | null = null;
  for (const i of listInstances({ home: o.home, clean: false })) {
    if (i.port !== o.port) continue;
    const t = readOwnerToken(i.dataDir, o.port, i.pid, uid);
    if (t && (await verifyInstance(i))) {
      token = t;
      instance = i;
      break;
    }
  }
  if (!instance || !token) return fail(10);

  const answer = await post(o.port, token, JSON.stringify({ version: 1, nonce: request.nonce, revoke: request.revoke }), o.timeoutMs ?? 5000);
  if (!answer) return fail(12);
  if (answer.status === 404) return fail(11);
  if (answer.status !== 200) return fail(12);
  const line = relay(answer.text, request.nonce);
  return line ? { code: 0, stdout: line, stderr: '' } : fail(12);
}

/** Reads stdin up to the cap (one byte over it is enough to refuse); resolves `''` past `timeoutMs`. */
export function readRequest(stream: NodeJS.ReadableStream, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => {
      chunks.length = 0;
      resolve('');
    }, timeoutMs);
    timer.unref();
    stream.on('data', (c: Buffer | string) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += b.length;
      if (size <= MAX_REQUEST_BYTES + 1) chunks.push(b);
    });
    stream.on('end', done);
    stream.on('error', () => {
      chunks.length = 0;
      done();
    });
  });
}
