// Where this machine runs (#278, decision 0013 section 5), read by the núcleo about ITSELF: once at
// boot (the first reading) and every hour, each source with a 1 s timeout, never with a credential:
//
// 1. AWS IMDSv2: `PUT /latest/api/token` (a session token for the next calls only, never kept or
//    logged), then `instance-type`, `placement/region`, `placement/availability-zone` and
//    `instance-id` under `/latest/meta-data/`;
// 2. else the SSM agent's registration file (`/var/lib/amazon/ssm/registration`): only
//    `ManagedInstanceID` and `Region`, for managed machines without instance metadata;
// 3. else the DMI (`/sys/class/dmi/id/sys_vendor` and `product_name`): the provider only.
//
// Nothing: `provider: 'unknown'`, every field `null`. Every value is checked against a strict pattern
// (`sanitizePlacement`), the same one the Mac applies to a remote's reading (remote.ts), so nothing
// but a short identifier ever reaches the screen. The metadata host and the file paths are injectable:
// tests never touch the network.
//
// `withPlacement(collector)` adds `placement` to each reading of the collector, refreshing it in the
// background once it is an hour old.

import { readFile } from 'node:fs/promises';
import { PLACEMENT_PROVIDERS, PLACEMENT_SOURCES, type Placement, type PlacementProvider, type TelemetryReading } from './model.ts';
import type { TelemetryCollector } from './ports.ts';

export const PLACEMENT_TIMEOUT_MS = 1_000;
export const PLACEMENT_REFRESH_MS = 60 * 60 * 1000;
export const DEFAULT_METADATA_BASE = 'http://169.254.169.254';
export const DEFAULT_SSM_REGISTRATION_FILE = '/var/lib/amazon/ssm/registration';
export const DEFAULT_DMI_DIR = '/sys/class/dmi/id';
const TOKEN_TTL_SECONDS = '60';

const KIND = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const REGION = /^[a-z]{2,}(-[a-z0-9]+){1,4}$/;
const ZONE = /^[a-z]{2,}(-[a-z0-9]+){1,4}[a-z]?$/;
const INSTANCE_ID = /^(i|mi)-[0-9a-f]{8,32}$/;
export const MAX_ANSWER = 4096;

export const UNKNOWN_PLACEMENT: Placement = { provider: 'unknown', kind: null, region: null, zone: null, instanceId: null, source: null, readAt: null };

/** One HTTP call to the metadata host; `null` on any failure (no answer, timeout, an HTTP error). */
export type MetadataRequest = (method: 'GET' | 'PUT', url: string, headers: Record<string, string>, timeoutMs: number) => Promise<string | null>;

export interface PlacementReaderOptions {
  metadataBase?: string;
  ssmRegistrationFile?: string;
  dmiDir?: string;
  request?: MetadataRequest;
  readText?: (path: string) => Promise<string | null>;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * `fetch` with a timeout; only a 200 with a short body counts. A body over MAX_ANSWER bytes is never
 * buffered: a larger content-length is refused before reading, and the stream is canceled once past it.
 */
export const fetchMetadata: MetadataRequest = async (method, url, headers, timeoutMs) => {
  try {
    const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    const length = Number(r.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_ANSWER) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    if (!r.body) return '';
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  }
};

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length <= 64 * 1024 ? text : null;
  } catch {
    return null;
  }
}

const clean = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && v.length <= 128 && re.test(v.trim()) ? v.trim() : null);

/** A placement that passed the patterns, or `null` when it is not a placement at all. Pure; used on both sides. */
export function sanitizePlacement(v: unknown): Placement | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (typeof p.provider !== 'string' || !(PLACEMENT_PROVIDERS as readonly string[]).includes(p.provider)) return null;
  const source = typeof p.source === 'string' && (PLACEMENT_SOURCES as readonly string[]).includes(p.source) ? (p.source as Placement['source']) : null;
  const readAt = typeof p.readAt === 'string' && p.readAt.length <= 40 && !Number.isNaN(Date.parse(p.readAt)) ? p.readAt : null;
  return {
    provider: p.provider as PlacementProvider,
    kind: clean(p.kind, KIND),
    region: clean(p.region, REGION),
    zone: clean(p.zone, ZONE),
    instanceId: clean(p.instanceId, INSTANCE_ID),
    source,
    readAt,
  };
}

/** The provider a DMI vendor and product name point to; `unknown` for anything else. */
export function providerFromDmi(vendor: string, product: string): PlacementProvider {
  const v = vendor.toLowerCase();
  const p = product.toLowerCase();
  if (/amazon/.test(v) || /amazon ec2/.test(p)) return 'aws';
  if (/google/.test(v) || /google compute engine/.test(p)) return 'gcp';
  if (/microsoft/.test(v) && /virtual machine/.test(p)) return 'azure';
  return 'unknown';
}

/** Reads the placement now, from the first source that answers. Never rejects. */
export async function readPlacement(o: PlacementReaderOptions = {}): Promise<Placement> {
  const base = (o.metadataBase ?? DEFAULT_METADATA_BASE).replace(/\/$/, '');
  const request = o.request ?? fetchMetadata;
  const readText = o.readText ?? readSmallFile;
  const timeout = o.timeoutMs ?? PLACEMENT_TIMEOUT_MS;
  const readAt = new Date((o.now ?? Date.now)()).toISOString();

  // 1. AWS IMDSv2. The token lives only in this function.
  const token = await request('PUT', `${base}/latest/api/token`, { 'X-aws-ec2-metadata-token-ttl-seconds': TOKEN_TTL_SECONDS }, timeout).catch(() => null);
  if (token && /^[A-Za-z0-9_=+/-]{1,512}$/.test(token.trim())) {
    const h = { 'X-aws-ec2-metadata-token': token.trim() };
    const get = (path: string) => request('GET', `${base}/latest/meta-data/${path}`, h, timeout).catch(() => null);
    const [kind, region, zone, instanceId] = await Promise.all([get('instance-type'), get('placement/region'), get('placement/availability-zone'), get('instance-id')]);
    const p = sanitizePlacement({ provider: 'aws', kind, region, zone, instanceId, source: 'instance-metadata', readAt });
    if (p && (p.kind || p.region || p.instanceId)) return p;
  }

  // 2. The SSM agent's registration: only these two keys are read; the rest is dropped here.
  const reg = await readText(o.ssmRegistrationFile ?? DEFAULT_SSM_REGISTRATION_FILE).catch(() => null);
  if (reg) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(reg);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { ManagedInstanceID, Region } = parsed as Record<string, unknown>;
      const p = sanitizePlacement({ provider: 'aws', kind: 'managed-instance', region: Region, zone: null, instanceId: ManagedInstanceID, source: 'ssm-registration', readAt });
      if (p && (p.instanceId || p.region)) return p;
    }
  }

  // 3. The DMI: the provider only.
  const dmi = (o.dmiDir ?? DEFAULT_DMI_DIR).replace(/\/$/, '');
  const [vendor, product] = await Promise.all([readText(`${dmi}/sys_vendor`).catch(() => null), readText(`${dmi}/product_name`).catch(() => null)]);
  if (vendor || product) {
    const provider = providerFromDmi((vendor ?? '').slice(0, 128), (product ?? '').slice(0, 128));
    if (provider !== 'unknown') return { ...UNKNOWN_PLACEMENT, provider, source: 'dmi', readAt };
  }
  return { ...UNKNOWN_PLACEMENT, readAt };
}

export interface PlacementProbeOptions extends PlacementReaderOptions {
  refreshMs?: number;
  log?: (message: string) => void;
}

/** The placement, read on the first `get()` and again once it is `refreshMs` old (in the background). */
export class PlacementProbe {
  private readonly o: PlacementProbeOptions;
  private value: Placement | null = null;
  private readAtMs = 0;
  private inFlight: Promise<Placement> | null = null;

  constructor(options: PlacementProbeOptions = {}) {
    this.o = options;
  }

  current(): Placement | null {
    return this.value;
  }

  /** The first call waits for the read (a few 1 s timeouts at most); later ones never wait. */
  async get(): Promise<Placement> {
    const now = (this.o.now ?? Date.now)();
    if (this.value && now - this.readAtMs < (this.o.refreshMs ?? PLACEMENT_REFRESH_MS)) return this.value;
    const p = this.refresh();
    return this.value ?? p;
  }

  refresh(): Promise<Placement> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = readPlacement(this.o)
      .then((p) => {
        const before = this.value;
        this.value = p;
        this.readAtMs = (this.o.now ?? Date.now)();
        if (!before || before.provider !== p.provider || before.source !== p.source) this.o.log?.(`placement: ${p.provider}${p.source ? ` (from ${p.source})` : ''}`);
        return p;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/** The collector's readings with `placement` (#278). */
export function withPlacement(collector: TelemetryCollector, probe: PlacementProbe = new PlacementProbe()): TelemetryCollector {
  return {
    async collect(): Promise<TelemetryReading> {
      const [reading, placement] = await Promise.all([collector.collect(), probe.get().catch(() => null)]);
      return placement ? { ...reading, placement } : reading;
    },
    ...(collector.terminals ? { terminals: () => collector.terminals!() } : {}),
  };
}
