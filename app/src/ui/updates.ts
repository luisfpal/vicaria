// Updates (DESIGN section 10). The service worker downloads a new build in the background. The page switches to it
// only when that cuts nothing: right at launch before the reader has touched anything, or while the tab is hidden,
// and only when this is the only Vicaria tab and nothing is busy (src/core/busy.ts). Otherwise it offers a reload,
// which also waits for busy work to finish. Checks run at launch, every six hours, and on return after six hours.
// update.json can mark a build bad: a device running it steps back to the build before. So does a build that cannot
// open the library after a failed upgrade.
import { toast, BASE } from "./state";
import { isBusy, whenIdle } from "../core/busy";
import { openState } from "../core/idb";
import { t } from "../core/i18n";
import { isNative, nativeUpdater, NATIVE_CHECK_EVERY } from "./nativeupdate";

// In the desktop shell the shell's own updater does what the service worker does on the web (see nativeupdate.ts)
let native: ReturnType<typeof nativeUpdater> | null = null;
function setupNative() {
  native = nativeUpdater({
    check: async () => { const { check } = await import("@tauri-apps/plugin-updater"); return check(); },
    relaunch: async () => { const { relaunch } = await import("@tauri-apps/plugin-process"); return relaunch(); },
    isBusy, whenIdle,
    offer: (version, install) => toast(t("updates.nativeReady", { version }), { sticky: true, action: { label: t("updates.restart"), run: install } }),
    failed: (version) => toast(t("updates.nativeFailed", { version }), { sticky: true, action: { label: t("updates.download"), run: () => window.open("https://github.com/luisfpal/vicaria/releases/latest", "_blank", "noopener") } }),
  });
  void native.run(true);
  setInterval(() => void native?.run(false), NATIVE_CHECK_EVERY);
}

export const VERSION = `${__APP_VERSION__} (${__BUILD__})`;
declare const __APP_VERSION__: string;
declare const __BUILD__: string;
export const CHECK_EVERY = 6 * 3600_000;

let reg: ServiceWorkerRegistration | null = null;
let pending: ServiceWorker | null = null;
let lastCheck = 0, offered = false, touched = false;
const started = performance.now();

function ask<T>(msg: unknown, to = navigator.serviceWorker?.controller): Promise<T | null> {
  if (!to) return Promise.resolve(null);
  return new Promise(ok => {
    const ch = new MessageChannel(), t = setTimeout(() => ok(null), 3000);
    ch.port1.onmessage = e => { clearTimeout(t); ok(e.data as T); };
    to.postMessage(msg, [ch.port2]);
  });
}
interface Info { version: string; serving: string; previous: string | null; bad: string[]; clients: number }
const apply = () => { pending?.postMessage({ t: "skip" }); };

async function decide() {
  if (!pending) return;
  const info = await ask<Info>({ t: "info" });
  const alone = !info || info.clients <= 1;
  const quiet = (!touched && performance.now() - started < 10_000) || document.hidden;
  if (alone && quiet) {
    if (!isBusy()) { apply(); return; }
    // work from the launch itself (moving the 0.x library, changes not yet sent) is still open: look again when it is done
    whenIdle(() => void decide()); return;
  }
  if (!offered) { offered = true; toast(t("updates.ready"), { sticky: true, action: { label: t("updates.reload"), run: () => whenIdle(apply) } }); }
}

// the build this page runs (sw.js names its cache after it); null in development
async function running(): Promise<string | null> {
  try { return (await (await fetch(`${BASE}/version.txt`)).text()).trim() || null; } catch { return null; }
}
async function rollback(why: string): Promise<boolean> {
  const r = await ask<{ ok: boolean }>({ t: "rollback", why });
  if (r?.ok) { whenIdle(() => location.reload()); return true; }
  return false;
}
async function check() {
  lastCheck = Date.now();
  if (!reg) return;
  await reg.update().catch(() => {});
  try {
    const u = await (await fetch(`${BASE}/update.json`, { cache: "no-store" })).json() as { bad?: string[] };
    const me = await running();
    if (me && u.bad?.includes(me) && !(await rollback("marked bad in update.json")))
      toast(t("updates.knownProblem"), { sticky: true });
  } catch { /* no update.json, or offline */ }
}

// after the first open of the database: act on what the upgrade did
export async function afterOpen() {
  if (openState.unusable) {
    if (await rollback(`library structure: ${openState.failed?.error ?? "missing " + openState.unusable.join(", ")}`)) return;
    toast(t("updates.unusable"), { sticky: true, action: { label: t("updates.reload"), run: () => location.reload() } });
  } else if (openState.failed) {
    console.warn("library upgrade did not finish; this version keeps working and tries again next launch:", openState.failed.error);
  } else if (openState.newer) {
    await check(); // the newer build is probably waiting already
  }
}

export function setupUpdates() {
  if (isNative()) { setupNative(); return; }
  if (!("serviceWorker" in navigator) || !isSecureContext || import.meta.env.DEV) return;
  const mark = () => { touched = true; };
  addEventListener("pointerdown", mark, { once: true }); addEventListener("keydown", mark, { once: true });
  navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).then(r => {
    reg = r; lastCheck = Date.now();
    const ready = (w: ServiceWorker) => { pending = w; decide(); };
    if (r.waiting && navigator.serviceWorker.controller) ready(r.waiting);
    r.addEventListener("updatefound", () => {
      const w = r.installing; if (!w) return;
      w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) ready(w); });
    });
    check();
    setInterval(() => { if (Date.now() - lastCheck >= CHECK_EVERY) check(); }, 3600_000);
  }).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastCheck >= CHECK_EVERY) check();
    if (document.hidden && pending) whenIdle(() => { if (document.hidden) decide(); });
  });
  // Reload when a new build takes over this page (never on the first install). Another tab can switch builds while
  // this one is busy: then it reloads once the work is done.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    if (isBusy()) toast(t("updates.otherTab"), { sticky: true });
    whenIdle(() => location.reload());
  });
}
export async function checkForUpdate(): Promise<boolean> {
  if (native) return native.run(false);
  if (!reg) return false;
  await check();
  if (pending) { whenIdle(apply); return true; }
  return !!(reg.installing || reg.waiting);
}
