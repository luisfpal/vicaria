// Tiny request/response protocol between the page and a worker.
export type Req = { id: number; fn: string; args: unknown[] };
export type Res = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { id: -1; progress: unknown };

export function serve(fns: Record<string, (...a: never[]) => unknown>) {
  self.onmessage = async (e: MessageEvent<Req>) => {
    const { id, fn, args } = e.data;
    try {
      const value = await (fns[fn] as (...a: unknown[]) => unknown)(...args);
      const transfer = value instanceof Blob || !value ? [] : collectTransfer(value);
      (self as unknown as Worker).postMessage({ id, ok: true, value } satisfies Res, transfer);
    } catch (err) {
      (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error)?.message || String(err) } satisfies Res);
    }
  };
}
function collectTransfer(v: unknown): Transferable[] { return v instanceof ArrayBuffer ? [v] : v instanceof Uint8Array && v.buffer instanceof ArrayBuffer ? [v.buffer] : []; }
export const progress = (p: unknown) => (self as unknown as Worker).postMessage({ id: -1, progress: p } satisfies Res);

export function client(make: () => Worker, onProgress?: (p: unknown) => void) {
  let w: Worker | null = null, seq = 0, leaving = false;
  // Safari reports the worker as failed while the page is being left; nothing is waiting for an answer then
  addEventListener("pagehide", () => { leaving = true; }); addEventListener("pageshow", () => { leaving = false; });
  // Safari cancels a worker's script as soon as a reload starts, before pagehide (seen after a language change); if the
  // page stays after all (the leave was cancelled), errors count again a moment later
  addEventListener("beforeunload", () => { leaving = true; setTimeout(() => { leaving = false; }, 3000); });
  const waiting = new Map<number, [(v: unknown) => void, (e: Error) => void]>();
  const get = () => {
    if (w) return w;
    w = make();
    w.onmessage = (e: MessageEvent<Res>) => {
      const m = e.data;
      if (m.id === -1) { onProgress?.((m as { progress: unknown }).progress); return; }
      const p = waiting.get(m.id); if (!p) return; waiting.delete(m.id);
      if ("ok" in m && m.ok) p[0](m.value); else p[1](new Error((m as { error: string }).error));
    };
    w.onerror = e => { if (leaving) return; for (const [, p] of waiting) p[1](new Error(e.message || "worker failed")); waiting.clear(); };
    return w;
  };
  return {
    call<T>(fn: string, args: unknown[] = [], transfer: Transferable[] = []): Promise<T> {
      return new Promise((ok, bad) => { const id = ++seq; waiting.set(id, [ok as (v: unknown) => void, bad]); get().postMessage({ id, fn, args } satisfies Req, transfer); });
    },
    warm() { get(); },
  };
}
