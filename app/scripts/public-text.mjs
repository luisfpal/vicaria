// Public text check: no em dashes in anything we write (code, docs, UI strings, commit-facing files).
// Book text in the test corpus, fixtures and demo state is other people's writing and is left alone.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const root = execSync("git rev-parse --show-toplevel").toString().trim();
const files = execSync("git ls-files", { cwd: root }).toString().split("\n").filter(f => f && /\.(ts|tsx|mjs|js|css|html|md|json|yml|py|txt|webmanifest)$/.test(f) && !/(^|\/)(tests\/fixtures|tests\/corpus|docs\/media\/demo-state|node_modules|package-lock\.json)/.test(f));
const bad = [];
for (const f of files) {
  let s; try { s = readFileSync(`${root}/${f}`, "utf8"); } catch { continue; }
  s.split("\n").forEach((l, i) => { if (l.includes("\u2014")) bad.push(`${f}:${i + 1}`); });
}
if (bad.length) { console.error(`Em dashes found (use a comma, colon or parentheses):\n${bad.join("\n")}`); process.exit(1); }
console.log(`public text ok (${files.length} files)`);
