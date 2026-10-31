// Authenticated local clients for existing route-contract tests. Security tests use raw HTTP.
import { request, type RequestOptions, type IncomingMessage, type ClientRequest } from 'node:http';

export const OWNER_TOKEN = 'a'.repeat(64);
const nativeFetch = globalThis.fetch;

export function ownerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${OWNER_TOKEN}`);
  return nativeFetch(input, { ...init, headers });
}

type Callback = (response: IncomingMessage) => void;
export function ownerRequest(url: string | URL, options: RequestOptions, callback: Callback): ClientRequest;
export function ownerRequest(options: RequestOptions, callback: Callback): ClientRequest;
export function ownerRequest(input: string | URL | RequestOptions, options: RequestOptions | Callback, callback?: Callback): ClientRequest {
  if (typeof input === 'string' || input instanceof URL) {
    const init = options as RequestOptions;
    return request(input, { ...init, headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...init.headers } }, callback);
  }
  return request({ ...input, headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...input.headers } }, options as Callback);
}
