/*
 * What the telemetry answer carries beyond the readings (#723, #720): the CPU governor's state, for this machine only.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../adapters/sqlite/sqlite-storage.ts';
import type { GovernorState } from '../cpu-governor/model.ts';
import { AlertTracker } from './alerts.ts';
import { SqliteTelemetryStore } from './adapters/sqlite.ts';
import { localMachine, TelemetryService, type MachineEntry } from './service.ts';

const STATE: GovernorState = { enabled: true, mode: 'containing', containedSessions: ['s1'], since: '2026-11-21T22:00:00.000Z' };
const remote: MachineEntry = { id: 'workstation', label: 'Workstation', state: () => 'connected' };

async function service(cpuGovernor?: () => GovernorState) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const telemetry = new TelemetryService({ store: new SqliteTelemetryStore(storage.db), tracker: new AlertTracker(), machines: [localMachine(), remote], ...(cpuGovernor ? { cpuGovernor } : {}) });
  return { telemetry, close: () => storage.close() };
}

describe('#720/AC-6 GET /api/telemetry carries the governor state', () => {
  test('#720/AC-6 Given a governor, Then this machine answers its state: enabled, mode, contained sessions and since when', async () => {
    const { telemetry, close } = await service(() => STATE);
    try {
      const t = await telemetry.telemetry('local', 1);
      assert.deepEqual(t?.cpuGovernor, STATE);
    } finally {
      await close();
    }
  });

  test('#720/AC-6 Given a remote machine, Then its answer does not carry this machine governor', async () => {
    const { telemetry, close } = await service(() => STATE);
    try {
      const t = await telemetry.telemetry('workstation', 1);
      assert.equal(t !== null && 'cpuGovernor' in t, false);
    } finally {
      await close();
    }
  });

  test('#720/AC-6 Given no governor, Then the answer has no cpuGovernor key', async () => {
    const { telemetry, close } = await service();
    try {
      const t = await telemetry.telemetry('local', 1);
      assert.equal(t !== null && 'cpuGovernor' in t, false);
    } finally {
      await close();
    }
  });
});
