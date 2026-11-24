// The browser the e2e scripts drive. VIC_ENGINE=webkit runs them in Playwright's WebKit with an iPad profile (user
// agent and touch), the nearest thing to Safari here; the viewport each script asks for still wins. Each context is
// a persistent one in its own temporary folder: WebKit's default context is ephemeral like a private window, where
// it refuses to store a Blob in IndexedDB ("Error preparing Blob/File data"), which a real Safari window does not.
import { chromium as cr, firefox, webkit, devices } from "playwright";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const ipad = devices["iPad (gen 7)"];
// VIC_ENGINE=firefox runs them in Playwright's Firefox (Gecko), the engine of the Linux browser most readers use.
// Headless Firefox has no WebGL (the Ideas graph); VIC_HEADED=1 under xvfb-run gives it Mesa's software WebGL.
const ff = { launch: (o = {}) => firefox.launch({ ...o, ...(process.env.VIC_HEADED ? { headless: false } : {}) }) };
// WebKit reports a load it cancelled itself (a worker script or blob URL still loading when the page navigates or the
// URL is let go) as a page error "Cannot load <url> due to access control checks". Nothing fails for the reader, and
// Chromium and Firefox stay silent, so page error listeners in WebKit runs skip exactly that message; a real access
// failure still shows in the Chromium and Firefox runs.
const CANCELLED = /^(Error: )?Cannot load .+ due to access control checks\.$/;
function quiet(pg) {
  if (pg.quieted) return pg; pg.quieted = true;
  const on = pg.on.bind(pg);
  pg.on = (ev, fn) => on(ev, ev === "pageerror" ? e => { if (!CANCELLED.test(String(e?.message ?? e))) fn(e); } : fn);
  return pg;
}
export const chromium = process.env.VIC_ENGINE === "firefox" ? ff : process.env.VIC_ENGINE !== "webkit" ? cr : {
  async launch(o = {}) {
    const open = [];
    return {
      async newContext(opts = {}) {
        const dir = mkdtempSync(join(tmpdir(), "vic-wk-"));
        const c = await webkit.launchPersistentContext(dir, { userAgent: ipad.userAgent, hasTouch: true, deviceScaleFactor: ipad.deviceScaleFactor, ...(process.env.VIC_NOSW ? { serviceWorkers: "block" } : {}), ...o, ...opts });
        for (const pg of c.pages()) quiet(pg); c.on("page", quiet);
        const newPage = c.newPage.bind(c); c.newPage = async () => quiet(await newPage());
        const close = c.close.bind(c); c.close = async () => { await close(); rmSync(dir, { recursive: true, force: true }); };
        open.push(c); return c;
      },
      async newPage(opts) { return (await this.newContext(opts)).newPage(); },
      async close() { for (const c of open) await c.close().catch(() => {}); },
    };
  },
};
