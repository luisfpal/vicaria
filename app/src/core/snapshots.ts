// Bringing back changes from the snapshot taken before an upgrade. Ops are kept by id, so this only adds what is
// missing and never undoes anything done since; settings and the book list are not touched.
import { clean, mergeOps } from "./ops";
import { listSnapshots, readSnapshot, type Snapshot } from "./idb";
import type { Op } from "./types";

export function opsIn(s: Snapshot): Op[] {
  const raw = [...s.ops, ...s.segs.flatMap(x => (x as { ops?: unknown[] }).ops ?? [])];
  return raw.map(o => { const { bk: _bk, ...r } = (o ?? {}) as Record<string, unknown>; return clean(r); }).filter((o): o is Op => !!o);
}
export async function restoreOps(s: Snapshot): Promise<number> { return (await mergeOps(opsIn(s))).length; }
// the latest snapshot: when it was taken and what it holds
export async function latestSnapshot(): Promise<{ name: string; at: number; from: number; to: number } | null> {
  const all = (await listSnapshots()).map(name => { const m = name.match(/^v(\d+)-to-v(\d+)-(\d+)\.json$/); return m ? { name, from: +m[1], to: +m[2], at: +m[3] } : null; }).filter(x => !!x);
  return all.sort((a, b) => b.at - a.at)[0] ?? null;
}
export async function restoreLatest(): Promise<number | null> {
  const l = await latestSnapshot(); if (!l) return null;
  const s = await readSnapshot(l.name); return s ? restoreOps(s) : null;
}
