// Your devices: pair, see what is connected and arriving, sync now, a sync file, unpair. The sync code itself is
// loaded only on a paired device (sync/client.ts).
import { useEffect, useState } from "preact/hooks";
import { store, use, books, setLibrary, toast, route, go, BASE } from "./state";
import { applySyncedBg } from "./background";
import { pairing, savePairing, newPairing, parseCode, codeOf, linkOf, type Pairing } from "../sync/pairing";
import type { SyncClient, Status } from "../sync/client";
import type { LibraryBook } from "../core/read";
import { t } from "../core/i18n";

export const syncStatus = store<Status | null>(null);
export const paired = store<Pairing | null>(pairing());
const pendingCode = store<string | null>(null);
let client: SyncClient | null = null, starting: Promise<void> | null = null;

// Only one tab of this device runs sync; another takes over when it closes.
export function startSync() {
  const p = pairing(); if (!p || starting) return starting;
  starting = new Promise<void>(ok => {
    const run = async () => {
      const { SyncClient } = await import("../sync/client");
      client = new SyncClient(p, {
        addBook: async bytes => { const buf = bytes.slice().buffer; return books.call<LibraryBook>("importFile", [buf], [buf]); },
        afterMerge: () => { books.call<LibraryBook[]>("afterSync").then(bs => setLibrary(bs)).then(() => applySyncedBg()).catch(() => {}); },
        status: s => syncStatus.set(s),
        focus: () => { const m = route.get().match(/^\/book\/([0-9a-f]{16})/); return new Set(m ? [m[1]] : []); },
      });
      await client.start();
      ok();
    };
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) locks.request("vicaria-sync", () => new Promise<void>(() => { run().catch(e => { syncStatus.set({ on: false, peers: [], books: {}, log: [], error: (e as Error).message }); ok(); }); })); // held while this tab lives
    else run().catch(() => ok());
  });
  return starting;
}
async function stopSync() { await client?.stop(); client = null; starting = null; syncStatus.set(null); }
export function pickUpPairLink() {
  if (location.hash.startsWith("#pair=")) { pendingCode.set(location.hash.slice(6)); history.replaceState(null, "", location.pathname + location.search); go("/settings"); }
}

const ago = (at?: number) => { if (!at) return t("sync.notYet"); const s = Math.round((Date.now() - at) / 1000); return s < 60 ? t("sync.justNow") : s < 3600 ? t("sync.minAgo", { n: Math.round(s / 60) }) : new Date(at).toLocaleString(); };

export function Devices() {
  const p = use(paired), st = use(syncStatus), code = use(pendingCode);
  const [show, setShow] = useState(false), [typed, setTyped] = useState(""), [qr, setQr] = useState("");
  useEffect(() => { if (p && show) import("qrcode-generator").then(m => { const q = m.default(0, "M"); q.addData(linkOf(p, BASE)); q.make(); setQr(q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })); }); }, [p, show]);
  const join = async (text: string) => {
    const np = parseCode(text); if (!np) { toast(t("sync.notCode")); return; }
    await stopSync(); savePairing(np); paired.set(np); pendingCode.set(null); setTyped(""); await startSync(); toast(t("sync.paired"));
  };
  if (code) {
    const np = parseCode(code);
    if (np && (!p || codeOf(p) !== codeOf(np))) return <section class="devices"><h2>{t("sync.devices")}</h2>
      <p>{t(p ? "sync.joinLeave" : "sync.join")}</p>
      <div class="row"><button class="btn" onClick={() => join(code)}>{t("sync.joinButton")}</button><button class="link" onClick={() => pendingCode.set(null)}>{t("sync.notNow")}</button></div></section>;
  }
  if (!p) return <section class="devices"><h2>{t("sync.devices")}</h2>
    <p class="muted">{t("sync.intro")}</p>
    <div class="row"><button class="btn" onClick={async () => { const legacy = await books.call<{ library?: string } | null>("legacyReport").catch(() => null); const np = newPairing(legacy?.library ?? undefined); savePairing(np); paired.set(np); setShow(true); await startSync(); }}>{t("sync.pairDevice")}</button></div>
    <p class="muted small">{t("sync.haveCode")}</p>
    <div class="row"><input class="code" value={typed} placeholder={t("sync.codePlaceholder")} aria-label={t("sync.pairingCode")} onInput={e => setTyped((e.target as HTMLInputElement).value)} /><button class="btn ghost" disabled={!typed.trim()} onClick={() => join(typed)}>{t("sync.joinButton")}</button></div>
  </section>;
  const arriving = Object.entries(st?.books ?? {});
  const n = st?.peers.length ?? 0;
  const last = Math.max(st?.direct ?? 0, st?.relay ?? 0) || undefined;
  return <section class="devices"><h2>{t("sync.devices")}</h2>
    <p>{st?.on ? (n ? t(st.peers.some(x => x.old) ? "sync.connectedOld" : "sync.connected", { n }) : last ? t("sync.noDevice") : t("sync.waiting")) : st?.error ? t("sync.startFailed", { error: st.error }) : t("sync.starting")}{" "}
      <span class="muted">{last ? t("sync.lastChange", { when: ago(last) }) : t("sync.catchUp")}</span></p>
    {arriving.map(([sha, b]) => <p key={sha} class="muted small">{t("sync.arriving", { pct: Math.round(100 * b.done / b.n) })}</p>)}
    <div class="row">
      <button class="btn ghost" onClick={async () => { await client?.syncNow(); toast(t("sync.checked")); }}>{t("sync.syncNow")}</button>
      <button class="btn ghost" onClick={() => setShow(!show)}>{show ? t("sync.hideCode") : t("sync.pairAnother")}</button>
    </div>
    {show && <div class="pair">
      {qr && <div class="qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label={t("sync.qrLabel")} />}
      <p class="muted small">{t("sync.scan")}</p>
      <div class="row"><input class="code" readOnly value={linkOf(p, BASE)} aria-label={t("sync.linkLabel")} onFocus={e => (e.target as HTMLInputElement).select()} />
        <button class="btn ghost" onClick={async () => { await navigator.clipboard?.writeText(linkOf(p, BASE)); toast(t("sync.copied")); }}>{t("sync.copy")}</button></div>
    </div>}
    <details><summary>{t("sync.more")}</summary>
      <div class="row">
        <button class="btn ghost" onClick={async () => { const b = await client?.exportFile(); if (!b) return; const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "vicaria-sync.txt"; a.click(); }}>{t("sync.saveFile")}</button>
        <label class="btn ghost">{t("sync.openFile")}<input type="file" accept=".txt,text/plain" hidden onChange={async e => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f || !client) return; try { const n = await client.importFile(await f.text()); toast(n ? t("sync.newChanges", { n }) : t("sync.nothingNew")); } catch { toast(t("sync.badFile")); } }} /></label>
        <button class="link danger" onClick={async () => { const was = p; await stopSync(); savePairing(null); paired.set(null); toast(t("sync.unpaired"), { action: { label: t("sync.undo"), run: async () => { savePairing(was); paired.set(was); await startSync(); } } }); }}>{t("sync.unpair")}</button>
      </div>
      {st?.log.length ? <ul class="log muted small">{st.log.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
    </details>
  </section>;
}
