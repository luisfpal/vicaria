// The Get Vicaria page: each device sees its own download first, in its own language; the install line and the
// release links come from the page, the GitHub release list is stubbed. Also runs install.sh against a fake release.
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const GET = new URL("../../get/", import.meta.url).pathname;
let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
const srv = createServer(async (rq, rs) => { const f = join(GET, new URL(rq.url, "http://x").pathname.replace(/\/$/, "/index.html")); try { rs.writeHead(200, { "content-type": { ".mjs": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png" }[extname(f)] || "text/html" }); rs.end(await readFile(f)); } catch { rs.writeHead(404); rs.end(); } });
await new Promise(r => srv.listen(47990, "127.0.0.1", r));
const URL0 = "http://127.0.0.1:47990/";
const release = { assets: ["Vicaria_1.0.0_aarch64.dmg", "Vicaria_1.0.0_x64.dmg", "Vicaria_1.0.0_amd64.AppImage", "Vicaria_1.0.0_amd64.deb", "Vicaria_1.0.0_android.apk"].map(name => ({ name, browser_download_url: "https://dl.test/" + name })) };

const b = await chromium.launch();
const cases = [
  ["mac", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", locale: "en-US" }, "Get Vicaria for Mac", "install.sh | sh", "https://dl.test/Vicaria_1.0.0_aarch64.dmg"],
  ["linux", { userAgent: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", locale: "en-US" }, "Get Vicaria for Linux", "install.sh | sh", "https://dl.test/Vicaria_1.0.0_amd64.AppImage"],
  ["android", { ...devices["Pixel 7"], locale: "en-US" }, "Get the Android app", null, "https://dl.test/Vicaria_1.0.0_android.apk"],
  ["iphone", { ...devices["iPhone 14"], locale: "en-US" }, "On iPhone and iPad", null, null],
  ["spanish mac", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", locale: "es-EC" }, "Descarga Vicaria para Mac", "install.sh | sh", "https://dl.test/Vicaria_1.0.0_aarch64.dmg"],
];
for (const [label, ctxOpts, head, cmd, href] of cases) {
  const ctx = await b.newContext(ctxOpts); const p = await ctx.newPage();
  await p.route("https://api.github.com/**", r => r.fulfill({ json: release }));
  await p.goto(URL0); await p.locator("#primary h2").waitFor();
  if ((await p.locator("#primary h2").textContent()) !== head) fail(`${label}: heading was "${await p.locator("#primary h2").textContent()}"`);
  if (cmd && !(await p.locator("#primary pre").textContent()).includes(cmd)) fail(`${label}: no install line`);
  if (href && !(await p.locator(`#primary a[href="${href}"]`).count())) fail(`${label}: missing ${href}`);
  if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail(`${label}: sideways scroll`);
  await ctx.close();
}
// no release yet: buttons fall back to the releases page and the page says so
{ const ctx = await b.newContext({ locale: "en-US", ...devices["Pixel 7"] }); const p = await ctx.newPage();
  await p.route("https://api.github.com/**", r => r.fulfill({ status: 404, json: { message: "Not Found" } }));
  await p.goto(URL0); await p.locator("#pending:not([hidden])").waitFor({ timeout: 5000 }).catch(() => fail("no release: no note shown"));
  if (!(await p.locator('#primary a[href$="/releases/latest"]').count())) fail("no release: no fallback link"); await ctx.close(); }
await b.close(); srv.close();

// install.sh on this machine against a fake release folder (Mac: the app unpacks, nothing is quarantined)
if (process.platform === "darwin" && process.env.VIC_APP_TARBALL) {
  const R = mkdtempSync(join(tmpdir(), "vic-rel-")), A = mkdtempSync(join(tmpdir(), "vic-apps-"));
  const a = process.arch === "arm64" ? "aarch64" : "x64";
  execFileSync("cp", [process.env.VIC_APP_TARBALL, join(R, `Vicaria_0.9.0_${a}.app.tar.gz`)]);
  writeFileSync(join(R, "latest.json"), '{"version":"0.9.0"}');
  execFileSync("sh", [join(GET, "install.sh")], { env: { ...process.env, VIC_RELEASE_URL: "file://" + R, VIC_APPS: A } });
  if (!existsSync(join(A, "Vicaria.app/Contents/MacOS"))) fail("install.sh: no app installed");
  try { execFileSync("codesign", ["-v", join(A, "Vicaria.app")]); } catch { fail("install.sh: signature broke"); }
  rmSync(R, { recursive: true }); rmSync(A, { recursive: true });
} else console.log("install.sh test skipped (set VIC_APP_TARBALL to a Vicaria.app.tar.gz on a Mac)");
console.log(failed ? `${failed} FAILED` : "get e2e passed");
process.exit(failed ? 1 : 0);
