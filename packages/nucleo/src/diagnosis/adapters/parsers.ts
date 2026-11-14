/*
 * Pure parsers of the outputs the diagnosis collectors read (#565): no command, no file, no clock.
 * Each takes the text a catalog command printed and returns the items of the diagnosis model.
 */

import { basename } from 'node:path';
import type { DockerDfItem, FolderItem, ProcessItem } from '../model.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps` `lstart` (`Sat Nov 14 08:15:02 2026`, local time) as an ISO instant; `null` when it makes no sense. */
function lstartToIso(text: string): string | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month < 0) return null;
  const date = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `ps -axo pid=,pcpu=,rss=,lstart=,comm=`: the name is the executable's base name; RSS comes in KiB. */
export function parsePsProcesses(out: string): ProcessItem[] {
  const items: ProcessItem[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
    const startedAt = m ? lstartToIso(m[4]) : null;
    if (!m || !startedAt) continue;
    items.push({ pid: Number(m[1]), name: basename(m[5]) || m[5], rssBytes: Number(m[3]) * 1024, cpuPct: Number(m[2]), startedAt });
  }
  return items;
}

const DECIMAL_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

/** A size as docker prints it (`4.5GB`, `800MB (66%)`, `1.5kB`): decimal units. */
function dockerSize(text: string | undefined): number | null {
  const m = /^\s*([\d.]+)\s*([kKMGTP]?B)\b/.exec(text ?? '');
  const unit = m ? DECIMAL_UNITS[m[2].toUpperCase()] : undefined;
  return m && unit !== undefined ? Math.round(Number(m[1]) * unit) : null;
}

/** `docker system df --format '{{json .}}'`: one JSON object per line; a line that is not one is skipped. */
export function parseDockerDf(out: string): DockerDfItem[] {
  const items: DockerDfItem[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let row: { Type?: unknown; Size?: unknown; Reclaimable?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const used = dockerSize(typeof row.Size === 'string' ? row.Size : undefined);
    const reclaimable = dockerSize(typeof row.Reclaimable === 'string' ? row.Reclaimable : undefined);
    if (typeof row.Type === 'string' && used !== null && reclaimable !== null) items.push({ type: row.Type, usedBytes: used, reclaimableBytes: reclaimable });
  }
  return items;
}

const BINARY_UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `Archived and active journals take up 1.2G in the file system.`: binary units. */
export function parseJournalUsage(out: string): number | null {
  const m = /take up ([\d.]+)([BKMGT])\b/.exec(out);
  return m ? Math.round(Number(m[1]) * BINARY_UNITS[m[2]]) : null;
}

/**
 * `du -k -d 2 .` run inside `mount`: the deepest folders, as absolute paths. A first-level folder only
 * counts when no second-level folder under it was listed, so a parent never competes with its children.
 */
export function parseDuTree(out: string, mount: string): FolderItem[] {
  const entries: { rel: string; bytes: number }[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (!m || m[2] === '.') continue;
    entries.push({ rel: m[2].replace(/^\.\//, ''), bytes: Number(m[1]) * 1024 });
  }
  const parents = new Set(entries.filter((e) => e.rel.includes('/')).map((e) => e.rel.split('/')[0]));
  const root = mount.endsWith('/') ? mount : `${mount}/`;
  return entries.filter((e) => e.rel.includes('/') || !parents.has(e.rel)).map((e) => ({ path: root + e.rel, bytes: e.bytes }));
}

/** `du -s -k .`: the total of the working directory, in bytes. */
export function parseDuSize(out: string): number | null {
  const m = /^(\d+)\t/m.exec(out);
  return m ? Number(m[1]) * 1024 : null;
}
