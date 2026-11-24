// Work that a reload would cut: importing, moving the 0.x library, a note being written, changes not yet on the
// relays. An update never switches the app while any of it is open (DESIGN section 10).
const jobs = new Map<number, string>();
const waiting = new Set<() => void>();
let n = 0;
export function busy(why: string): () => void {
  const id = ++n; jobs.set(id, why);
  return () => { if (jobs.delete(id) && !jobs.size) for (const f of [...waiting]) f(); };
}
export const isBusy = () => jobs.size > 0;
export const busyWith = () => [...new Set(jobs.values())];
export async function whileBusy<T>(why: string, f: () => Promise<T>): Promise<T> { const done = busy(why); try { return await f(); } finally { done(); } }
// runs f once nothing is busy (now, if nothing is)
export function whenIdle(f: () => void): () => void {
  if (!jobs.size) { f(); return () => {}; }
  const g = () => { waiting.delete(g); f(); }; waiting.add(g);
  return () => waiting.delete(g);
}
