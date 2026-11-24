// The page's side of model downloads: current progress of each model, start (asking the browser to keep the
// files, and waiting for Wi-Fi where the connection is metered), pause, remove.
import { client } from "../workers/rpc";
import { shouldWait, type Progress } from "./downloads";
import { CATALOG } from "./catalog";

const w = client(() => new Worker(new URL("../workers/models.worker.ts", import.meta.url), { type: "module" }));
const state = new Map<string, Progress>();
const subs = new Set<() => void>();
const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("vicaria-models") : null;
// a download that failed (a dropped connection) is tried again by itself: after 5 s, 30 s, then 2 minutes
const retries = new Map<string, number>(), timers = new Map<string, number>();
const DELAYS = [5_000, 30_000, 120_000];
export const retrying = (id: string) => timers.has(id);
const put = (p: Progress) => {
  state.set(p.id, p);
  if (p.status === "done") retries.delete(p.id);
  if (p.status === "error" && wantedIds().has(p.id) && !timers.has(p.id)) {
    const n = retries.get(p.id) ?? 0;
    if (n < DELAYS.length) { retries.set(p.id, n + 1); timers.set(p.id, setTimeout(() => { timers.delete(p.id); if (wantedIds().has(p.id) && !metered()) void w.call("start", [p.id]); }, DELAYS[n]) as unknown as number); }
  }
  for (const s of subs) s();
};
if (ch) ch.onmessage = e => put(e.data as Progress);

export const progressOf = (id: string): Progress | undefined => state.get(id);
export function onProgress(f: () => void): () => void { subs.add(f); return () => subs.delete(f); }

type Conn = { saveData?: boolean; type?: string; metered?: boolean; addEventListener?(t: string, f: () => void): void };
const conn = () => (navigator as Navigator & { connection?: Conn }).connection;
export const metered = () => shouldWait(conn());

let checked: Promise<void> | null = null;
// what is on the device; models that were downloading when the app closed carry on (unless the connection is metered)
export function checkModels(): Promise<void> {
  return checked ??= w.call<Progress[]>("check", [CATALOG.map(m => m.id)]).then(ps => {
    for (const p of ps) put(p);
    const wanted = wantedIds(); for (const p of ps) if (p.status !== "done" && wanted.has(p.id) && !metered()) void w.call("start", [p.id]);
    conn()?.addEventListener?.("change", () => { if (metered()) void w.call("pauseAll"); else for (const id of wantedIds()) if (state.get(id)?.status !== "done") void w.call("start", [id]); });
  });
}
// which models the reader asked for (kept across reloads, so an interrupted download resumes)
const KEY = "vicaria.models.wanted";
const wantedIds = () => new Set<string>(JSON.parse(localStorage.getItem(KEY) || "[]"));
const setWanted = (s: Set<string>) => localStorage.setItem(KEY, JSON.stringify([...s]));
export const isWanted = (id: string) => wantedIds().has(id);

export async function startModel(id: string, anyNetwork = false): Promise<"started" | "waiting"> {
  clearTimeout(timers.get(id)); timers.delete(id); retries.delete(id);
  const s = wantedIds(); s.add(id); setWanted(s);
  void navigator.storage?.persist?.().catch(() => false);
  if (metered() && !anyNetwork) { const p = state.get(id); if (p) put({ ...p, status: "paused" }); return "waiting"; }
  await w.call("start", [id]); return "started";
}
export async function pauseModel(id: string) { clearTimeout(timers.get(id)); timers.delete(id); const s = wantedIds(); s.delete(id); setWanted(s); await w.call("pause", [id]); }
export async function removeModel(id: string) { const s = wantedIds(); s.delete(id); setWanted(s); await w.call("remove", [id]); }
