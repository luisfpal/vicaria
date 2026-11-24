// Downloads models in the background, apart from the page and the books worker. Progress goes out on the
// "vicaria-models" channel, so every tab sees it. A page reload stops this worker; the page starts it again and
// the download resumes from the last byte written.
import { serve } from "./rpc";
import { Downloads, nameOf } from "../models/downloads";
import { opfsStore } from "../models/opfs";
import { CATALOG, modelById } from "../models/catalog";

const ch = new BroadcastChannel("vicaria-models");
// one download of a model at a time across tabs, and across the old and new page during a reload
const lock = <T>(id: string, f: () => Promise<T>): Promise<T> => navigator.locks ? navigator.locks.request(`vicaria-download:${id}`, f) as Promise<T> : f();
const dl = new Downloads(opfsStore, (url, init) => fetch(url, init), p => ch.postMessage(p), undefined, lock);
const need = (id: string) => { const m = modelById(id); if (!m) throw new Error(`No model ${id}`); return m; };

serve({
  async check(ids: string[]) { return Promise.all(ids.map(id => dl.check(need(id)))); },
  start(id: string) { dl.start(need(id)); },
  pause(id: string) { dl.pause(id); },
  pauseAll() { dl.pauseAll(); },
  // a file shared with another downloaded model (the voices share espeak-ng) stays
  async remove(id: string) {
    const m = need(id), keep = new Set<string>();
    for (const o of CATALOG) if (o.id !== id && (await dl.check(o)).status === "done") for (const f of o.files) keep.add(nameOf(f.url));
    await dl.remove({ ...m, files: m.files.filter(f => !keep.has(nameOf(f.url))) });
    await dl.check(m);
  },
});
