/*
 * The change cursor's publication as CloudEvents 1.0 (#663; framework conditions EVT-1 and EVT-2).
 * A pure mapper: one recorded change becomes one event. The contract is authored under
 * docs/contracts/events/ (the envelope schema and one schema per type); this code is validated against it
 * by test/changes/cloud-events.test.ts. A breaking change to `data` is a new `.v2` type and schema file.
 */

import type { ChangeType, RecordedChange } from './cursor.ts';

export const CLOUD_EVENT_SOURCE = '/ahrena-console/core';
const TYPE_PREFIX = 'com.github.ahrenatechnology.console.core';
const SCHEMA_BASE = 'https://github.com/ahrenatechnology/ahrena-console/blob/main/docs/contracts/events';

export interface CloudEvent {
  specversion: '1.0';
  /** The change's cursor, `<generation>.<seq>`: unique per core start (#663). */
  id: string;
  source: typeof CLOUD_EVENT_SOURCE;
  type: string;
  /** The identity of the root that changed (the change's key) (#663). */
  subject: string;
  /** When the change occurred, ISO 8601 UTC (#663). */
  time: string;
  datacontenttype: 'application/json';
  dataschema: string;
  data: { sessionId: string | null; accountId: string | null };
}

/** The versioned event type of a change type. */
export const cloudEventType = (type: ChangeType): string => `${TYPE_PREFIX}.${type}.changed.v1`;

export function toCloudEvent(change: RecordedChange, generation: string): CloudEvent {
  return {
    specversion: '1.0',
    id: `${generation}.${change.seq}`,
    source: CLOUD_EVENT_SOURCE,
    type: cloudEventType(change.type),
    subject: change.key,
    time: change.time,
    datacontenttype: 'application/json',
    dataschema: `${SCHEMA_BASE}/${change.type}.changed.v1.schema.json`,
    data: { sessionId: change.sessionId, accountId: change.accountId },
  };
}
