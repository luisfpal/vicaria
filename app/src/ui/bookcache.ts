// Opening a book should feel instant: the head and the section to show are read as soon as a finger or pointer
// lands on the cover, and kept for a moment so the reader finds them already in memory.
import { head as loadHead, section as loadSection, type Head } from "../core/read";
import type { Section } from "../core/types";

const heads = new Map<string, Promise<Head | undefined>>();
const secs = new Map<string, Promise<Section | undefined>>();
const trim = <T>(m: Map<string, T>, n: number) => { while (m.size > n) m.delete(m.keys().next().value!); };

export function cachedHead(id: string) {
  let p = heads.get(id);
  if (!p) { p = loadHead(id).catch(() => undefined); heads.set(id, p); trim(heads, 8); }
  return p;
}
export function cachedSection(id: string, idx: number) {
  const k = id + "|" + idx;
  let p = secs.get(k);
  if (!p) { p = loadSection(id, idx).catch(() => undefined); secs.set(k, p); trim(secs, 24); }
  return p;
}
export function forgetBook(id: string) {
  heads.delete(id);
  for (const k of [...secs.keys()]) if (k.startsWith(id + "|")) secs.delete(k);
}
export function lastSpot(id: string): { section: number; block: number } | null {
  try { return JSON.parse(localStorage.getItem("vic:pos:" + id) || "null"); } catch { return null; }
}
export function prefetchBook(id: string, start?: number) {
  const s = lastSpot(id)?.section ?? start;
  cachedHead(id);
  if (s != null) cachedSection(id, s);
}
