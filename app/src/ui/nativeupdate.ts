// Updates inside the desktop shell (Tauri). There is no service worker there: the shell's own updater reads
// latest.json from GitHub Releases, checks its signature, installs and restarts. The same rules as the web app
// (src/ui/updates.ts): at launch, before the reader has touched anything, an update installs at once; later it is
// offered, and installs when nothing is busy. If installing fails (an unsigned Mac build can be refused) the reader
// gets a link to download the new version by hand instead of a silent failure.
export const isNative = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Found { version: string; downloadAndInstall: () => Promise<void> }
export interface NativeDeps {
  check: () => Promise<Found | null>;
  relaunch: () => Promise<void>;
  isBusy: () => boolean;
  whenIdle: (f: () => void) => void;
  offer: (version: string, install: () => void) => void;
  failed: (version: string, why: string) => void;
}
export const NATIVE_CHECK_EVERY = 6 * 3600_000;

export function nativeUpdater(d: NativeDeps) {
  let installing = false, offered: string | null = null;
  async function install(u: Found) {
    if (installing) return;
    installing = true;
    try { await u.downloadAndInstall(); await d.relaunch(); }
    catch (e) { installing = false; d.failed(u.version, (e as Error)?.message ?? String(e)); }
  }
  // atLaunch: the reader has not touched anything yet, so restarting costs nothing
  async function run(atLaunch: boolean): Promise<boolean> {
    let u: Found | null = null;
    try { u = await d.check(); } catch { return false; } // offline, or no release yet
    if (!u) return false;
    const found = u;
    const go = () => d.whenIdle(() => void install(found));
    if (atLaunch && !d.isBusy()) { void install(found); return true; }
    if (offered !== found.version) { offered = found.version; d.offer(found.version, go); }
    return true;
  }
  return { run };
}
