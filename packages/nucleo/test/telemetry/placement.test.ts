// Where the machine runs (#278, decision 0013 section 5): each source with injected fakes (the metadata
// requests and the files), in their order, the 1 s timeout passed to each call, the patterns every
// value must pass, and the Mac carrying a remote's placement through its stored reading. No network:
// the request function is a fake. Placeholders only (no real instance id, region or host).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PlacementProbe, providerFromDmi, readPlacement, sanitizePlacement, withPlacement, type MetadataRequest } from '../../src/telemetry/placement.ts';
import { storableReading } from '../../src/telemetry/remote.ts';
import { reading, T0 } from './reading.ts';

const INSTANCE = 'i-0123456789abcdef0';
const MANAGED = 'mi-0abcdef0123456789';

function imds(answers: Record<string, string> | null) {
  const calls: { method: string; url: string; headers: Record<string, string>; timeoutMs: number }[] = [];
  const request: MetadataRequest = async (method, url, headers, timeoutMs) => {
    calls.push({ method, url, headers, timeoutMs });
    if (!answers) return null;
    if (method === 'PUT') return url.endsWith('/latest/api/token') ? 'TOKEN-SENTINEL' : null;
    if (headers['X-aws-ec2-metadata-token'] !== 'TOKEN-SENTINEL') return null;
    const key = url.replace(/^.*\/latest\/meta-data\//, '');
    return answers[key] ?? null;
  };
  return { request, calls };
}
const files = (map: Record<string, string>) => async (path: string) => map[path] ?? null;

describe('#278 placement, from the first source that answers', () => {
  test('#278 IMDSv2: a token by PUT, then the four keys with it; each call with the 1 s timeout; the token is never in the result', async () => {
    const f = imds({ 'instance-type': 'tipo-exemplo.large', 'placement/region': 'regiao-exemplo-1', 'placement/availability-zone': 'regiao-exemplo-1a', 'instance-id': INSTANCE });
    const p = await readPlacement({ metadataBase: 'http://metadata.test', request: f.request, readText: files({}), now: () => T0 });
    assert.deepEqual(p, { provider: 'aws', kind: 'tipo-exemplo.large', region: 'regiao-exemplo-1', zone: 'regiao-exemplo-1a', instanceId: INSTANCE, source: 'instance-metadata', readAt: '2026-11-02T12:00:00.000Z' });
    assert.equal(f.calls[0]!.method, 'PUT');
    assert.equal(f.calls[0]!.url, 'http://metadata.test/latest/api/token');
    assert.ok(f.calls[0]!.headers['X-aws-ec2-metadata-token-ttl-seconds']);
    assert.deepEqual(f.calls.slice(1).map((c) => c.url.replace('http://metadata.test/latest/meta-data/', '')).sort(), ['instance-id', 'instance-type', 'placement/availability-zone', 'placement/region']);
    assert.ok(f.calls.every((c) => c.timeoutMs === 1000));
    assert.equal(JSON.stringify(p).includes('TOKEN-SENTINEL'), false);
  });

  test('#278 no metadata: the SSM registration, only ManagedInstanceID and Region', async () => {
    const reg = JSON.stringify({ ManagedInstanceID: MANAGED, Region: 'regiao-exemplo-1', PrivateKey: 'KEY-SENTINEL', Fingerprint: 'FP-SENTINEL' });
    const p = await readPlacement({ request: imds(null).request, ssmRegistrationFile: '/example/ssm/registration', readText: files({ '/example/ssm/registration': reg }), now: () => T0 });
    assert.deepEqual(p, { provider: 'aws', kind: 'managed-instance', region: 'regiao-exemplo-1', zone: null, instanceId: MANAGED, source: 'ssm-registration', readAt: '2026-11-02T12:00:00.000Z' });
    assert.equal(JSON.stringify(p).includes('SENTINEL'), false);
  });

  test('#278 neither: the DMI, provider only', async () => {
    const dmi = (vendor: string, product: string) =>
      readPlacement({ request: imds(null).request, dmiDir: '/example/dmi', readText: files({ '/example/dmi/sys_vendor': `${vendor}\n`, '/example/dmi/product_name': `${product}\n` }) });
    const g = await dmi('Google', 'Google Compute Engine');
    assert.deepEqual([g.provider, g.kind, g.region, g.instanceId, g.source], ['gcp', null, null, null, 'dmi']);
    assert.equal((await dmi('Microsoft Corporation', 'Virtual Machine')).provider, 'azure');
    assert.equal((await dmi('Amazon EC2', 'tipo-exemplo.large')).provider, 'aws');
    assert.equal(providerFromDmi('Fabricante Exemplo', 'Modelo'), 'unknown');
  });

  test('#278 nothing: unknown, every field null', async () => {
    const p = await readPlacement({ request: imds(null).request, readText: files({}), now: () => T0 });
    assert.deepEqual(p, { provider: 'unknown', kind: null, region: null, zone: null, instanceId: null, source: null, readAt: '2026-11-02T12:00:00.000Z' });
  });

  test('#278 a value that is not a short identifier is dropped (an HTML page, an injected text)', async () => {
    const f = imds({ 'instance-type': '<html>oops</html>', 'placement/region': 'regiao-exemplo-1', 'placement/availability-zone': 'x; rm -rf /', 'instance-id': 'not-an-id' });
    const p = await readPlacement({ request: f.request, readText: files({}) });
    assert.deepEqual([p.kind, p.region, p.zone, p.instanceId], [null, 'regiao-exemplo-1', null, null]);
    assert.equal(sanitizePlacement({ provider: 'nuvem-x' }), null);
    assert.equal(sanitizePlacement('aws'), null);
  });

  test('#278 the probe reads once, keeps it for an hour, then refreshes in the background', async () => {
    let now = T0;
    let reads = 0;
    const probe = new PlacementProbe({ now: () => now, request: async () => (reads++, null), readText: files({}) });
    await probe.get();
    await probe.get();
    assert.equal(reads, 1);
    now += 60 * 60 * 1000;
    await probe.get();
    await probe.refresh();
    assert.ok(reads >= 2);
  });

  test('#278 withPlacement adds it to the core’s own reading, and the Mac carries a remote’s through, validated', async () => {
    const probe = new PlacementProbe({ request: imds(null).request, ssmRegistrationFile: '/r', readText: files({ '/r': JSON.stringify({ ManagedInstanceID: MANAGED, Region: 'regiao-exemplo-1' }) }) });
    const own = await withPlacement({ collect: async () => reading() }, probe).collect();
    assert.equal(own.placement?.source, 'ssm-registration');
    const stored = storableReading(JSON.parse(JSON.stringify(own)), T0);
    assert.deepEqual(stored?.placement, own.placement);
    const tampered = storableReading({ ...JSON.parse(JSON.stringify(own)), placement: { ...own.placement, instanceId: 'x'.repeat(5000), region: '<b>' } }, T0);
    assert.deepEqual([tampered?.placement?.instanceId, tampered?.placement?.region], [null, null]);
    assert.equal(storableReading({ ...JSON.parse(JSON.stringify(own)), placement: 'aws' }, T0)?.placement, undefined);
  });
});
