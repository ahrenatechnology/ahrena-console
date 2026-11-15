// #663: every event the core publishes is a CloudEvents 1.0 event that passes the envelope schema and the
// schema of its type (docs/contracts/events/). The schemas are authored; this test validates the code
// against them. Each change is shaped like the real call sites that record it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { CHANGE_TYPES, ChangeCursor, serveChanges, serveStream, toCloudEvent, type ChangeType, type CloudEvent, type NewChange } from '../../src/changes/index.ts';
import { validate } from './json-schema-subset.ts';

const EVENTS_DIR = new URL('../../../../docs/contracts/events/', import.meta.url);
const ENVELOPE_FILE = 'cloudevents-1.0.schema.json';
const TYPE_SCHEMA_SUFFIX = '.changed.v1.schema.json';
const OCCURRED_AT = Date.parse('2026-11-14T12:00:00.000Z');

type Schema = Record<string, never>;
const readSchema = (file: string): Schema => JSON.parse(readFileSync(new URL(file, EVENTS_DIR), 'utf8')) as Schema;
const envelopeSchema = (): Schema => readSchema(ENVELOPE_FILE);
const typeSchemaFile = (type: ChangeType): string => `${type}${TYPE_SCHEMA_SUFFIX}`;

/** One change per type, shaped like the call sites that record it (see the survey in docs/contracts/events.md). */
const SAMPLES: Record<ChangeType, NewChange> = {
  session: { type: 'session', key: 's1', sessionId: 's1', accountId: 'conta-a' },
  state: { type: 'state', key: 's1', sessionId: 's1', accountId: null },
  'needs-you': { type: 'needs-you', key: 's1', sessionId: 's1', accountId: 'conta-a' },
  plan: { type: 'plan', key: 's1', sessionId: 's1', accountId: 'conta-a' },
  decision: { type: 'decision', key: 'd1', sessionId: 's1', accountId: 'conta-a' },
  activity: { type: 'activity', key: 's1', sessionId: 's1', accountId: 'conta-a' },
  account: { type: 'account', key: 'conta-a', sessionId: null, accountId: 'conta-a' },
  repos: { type: 'repos', key: 'acme/widgets', sessionId: null, accountId: null },
  alert: { type: 'alert', key: 'local:swap-high', sessionId: null, accountId: null },
  'agent-instructions': { type: 'agent-instructions', key: 'acme/widgets', sessionId: null, accountId: null },
  'framework-install': { type: 'framework-install', key: 'acme/widgets', sessionId: null, accountId: null },
  adrs: { type: 'adrs', key: 'list', sessionId: null, accountId: null },
  connections: { type: 'connections', key: 'github', sessionId: null, accountId: null },
  tools: { type: 'tools', key: 'local', sessionId: null, accountId: null },
  connector: { type: 'connector', key: 'aws', sessionId: null, accountId: null },
  'app-update': { type: 'app-update', key: 'app', sessionId: null, accountId: null },
};
/** The remote machine's needs-you (telemetry/remote.ts) has no session id. */
const REMOTE_NEEDS_YOU: NewChange = { type: 'needs-you', key: 'mac2:s9', sessionId: null, accountId: null };

const newCursor = (): ChangeCursor => new ChangeCursor({ generation: 'g1', batchMs: 0, minIntervalMs: 0, wallClock: () => OCCURRED_AT });

function validateEvent(event: unknown, type: ChangeType): string[] {
  return [...validate(envelopeSchema(), event), ...validate(readSchema(typeSchemaFile(type)), (event as CloudEvent).data, '$.data')];
}

describe('#663/AC-1 the event contracts', () => {
  test('#663/AC-1 every change type has a schema file and every schema file names a change type', () => {
    const files = readdirSync(EVENTS_DIR).filter((f) => f.endsWith(TYPE_SCHEMA_SUFFIX)).sort();
    assert.deepEqual(files, CHANGE_TYPES.map(typeSchemaFile).sort());
  });

  for (const type of CHANGE_TYPES) {
    test(`#663/AC-1 a ${type} change is published as a CloudEvents 1.0 event valid for its type`, () => {
      const cursor = newCursor();
      const change = cursor.record(SAMPLES[type]);
      const event = toCloudEvent(change, cursor.generation);
      assert.deepEqual(validateEvent(event, type), []);
      assert.equal(event.id, `g1.${change.seq}`);
      assert.equal(event.subject, change.key);
      assert.equal(event.time, '2026-11-14T12:00:00.000Z');
      assert.match(event.type, new RegExp(`\\.${type}\\.changed\\.v1$`));
      assert.ok(event.dataschema.endsWith(`/${typeSchemaFile(type)}`), event.dataschema);
      assert.deepEqual(event.data, { sessionId: change.sessionId, accountId: change.accountId });
    });
  }

  test('#663/AC-1 a needs-you change from a remote machine, with no session, is valid', () => {
    const cursor = newCursor();
    const event = toCloudEvent(cursor.record(REMOTE_NEEDS_YOU), cursor.generation);
    assert.deepEqual(validateEvent(event, 'needs-you'), []);
  });

  test('#663/AC-1 the validator bites: a wrong specversion, a session on an account event, a missing subject are rejected', () => {
    const cursor = newCursor();
    const good = toCloudEvent(cursor.record(SAMPLES.account), cursor.generation);
    assert.deepEqual(validateEvent(good, 'account'), []);
    assert.notDeepEqual(validateEvent({ ...good, specversion: '0.3' }, 'account'), []);
    assert.notDeepEqual(validateEvent({ ...good, data: { sessionId: 's1', accountId: 'conta-a' } }, 'account'), []);
    assert.notDeepEqual(validateEvent({ ...good, subject: undefined }, 'account'), []);
    assert.notDeepEqual(validateEvent({ ...good, time: 'yesterday' }, 'account'), []);
    assert.notDeepEqual(validateEvent({ ...good, type: 'session.changed' }, 'account'), []);
    assert.notDeepEqual(validateEvent({ ...good, data: { sessionId: null, accountId: null } }, 'account'), []);
  });
});

async function withServer(handler: Parameters<typeof createServer>[1], run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Reads the data of the first `changes` SSE message. */
async function firstChangesMessage(res: Response): Promise<{ id: string | null; data: { events: unknown[] } }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the stream ended before a changes message');
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split('\n\n').slice(0, -1)) {
      if (!block.includes('event: changes')) continue;
      const line = (prefix: string) => block.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? null;
      void reader.cancel();
      return { id: line('id: '), data: JSON.parse(line('data: ')!) as { events: unknown[] } };
    }
  }
}

describe('#663/AC-1 delivery on the HTTP routes', () => {
  test('#663/AC-1 GET /api/changes carries each recorded change as a valid event beside the unchanged changes', async () => {
    const cursor = newCursor();
    const start = await cursor.wait(null);
    const recorded = CHANGE_TYPES.map((t) => cursor.record(SAMPLES[t]));
    await withServer((req, res) => void serveChanges(res, new URL(req.url!, 'http://x'), cursor), async (base) => {
      const body = (await (await fetch(`${base}/api/changes?since=${start.cursor}&wait=0`)).json()) as { changes: unknown[]; events: CloudEvent[] };
      assert.deepEqual(body.changes, recorded);
      assert.equal(body.events.length, recorded.length);
      body.events.forEach((event, i) => {
        const change = recorded[i]!;
        assert.deepEqual(validateEvent(event, change.type), [], change.type);
        assert.equal(event.id, `g1.${change.seq}`);
        assert.equal(event.subject, change.key);
        assert.equal(event.time, '2026-11-14T12:00:00.000Z');
      });
    });
  });

  test('#663/AC-1 GET /api/stream carries each recorded change as a valid event in the changes message', async () => {
    const cursor = newCursor();
    const start = await cursor.wait(null);
    const recorded = CHANGE_TYPES.map((t) => cursor.record(SAMPLES[t]));
    await withServer((req, res) => void serveStream(req, res, new URL(req.url!, 'http://x'), cursor), async (base) => {
      const message = await firstChangesMessage(await fetch(`${base}/api/stream?since=${start.cursor}`));
      assert.equal(message.data.events.length, recorded.length);
      message.data.events.forEach((event, i) => {
        const change = recorded[i]!;
        assert.deepEqual(validateEvent(event, change.type), [], change.type);
        assert.equal((event as CloudEvent).id, `g1.${change.seq}`);
        assert.equal((event as CloudEvent).subject, change.key);
        assert.equal((event as CloudEvent).time, '2026-11-14T12:00:00.000Z');
      });
      assert.equal(message.id, cursor.current);
    });
  });
});
