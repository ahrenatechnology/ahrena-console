/*
 * The vocabulary of delegating an alert to a Claude session (#567, epic #563). Pure: no file, no command,
 * no network, no clock lives here; the prompt is built in prompt.ts and the opening is the next layers'.
 *
 * - A delegation reaches the session by one of three vias: the Claude Desktop, a terminal on this Mac,
 *   or SSH to the Workstation.
 * - "local" accepts desktop and terminal; any other machine (the Workstation, through its tunnel) accepts ssh only.
 */

import { LOCAL_MACHINE_ID } from '../telemetry/model.ts';

export const VIAS = ['desktop', 'terminal', 'ssh'] as const;
export type Via = (typeof VIAS)[number];

/** The SSH host the Workstation session runs on. */
export const SSH_HOST = 'ahrena-workstation';

/** The longest `encodeURIComponent(prompt)` the Desktop URL carries: it cuts `q` near 14_000 and the folder takes the rest. */
export const URL_BUDGET = 12_000;

export function isVia(value: unknown): value is Via {
  return typeof value === 'string' && (VIAS as readonly string[]).includes(value);
}

/** The vias a machine accepts. */
export function viasFor(machineId: string): readonly Via[] {
  return machineId === LOCAL_MACHINE_ID ? ['desktop', 'terminal'] : ['ssh'];
}

export function acceptsVia(machineId: string, via: Via): boolean {
  return viasFor(machineId).includes(via);
}
