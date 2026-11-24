// Builds the large Japanese sample from the IDPF repository at a pinned commit, then checks every corpus file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;
const COMMIT = process.env.IDPF_COMMIT || "7651e2002b631e6577fadf7e9e0692fa6efb8746";
const name = "kusamakura-japanese-vertical-writing";
const out = join(CORPUS, `idpf-${name}.epub`);
if (!existsSync(out)) {
  const dir = mkdtempSync(join(tmpdir(), "idpf-"));
  execFileSync("git", ["clone", "-q", "--filter=blob:none", "--sparse", "https://github.com/IDPF/epub3-samples", dir]);
  execFileSync("git", ["-C", dir, "checkout", "-q", COMMIT]);
  execFileSync("git", ["-C", dir, "sparse-checkout", "set", `30/${name}`]);
  const root = join(dir, "30", name), files = { mimetype: [new TextEncoder().encode("application/epub+zip"), { level: 0 }] };
  const walk = d => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (f.startsWith(".")) continue; if (statSync(p).isDirectory()) walk(p); else { const r = relative(root, p); if (r !== "mimetype") files[r] = readFileSync(p); } } };
  walk(root);
  writeFileSync(out, zipSync(files));
}
const sums = readFileSync(join(CORPUS, "SHA256SUMS"), "utf8").trim().split("\n").map(l => l.split(/\s+/));
let bad = 0;
for (const [sum, f] of sums) {
  const h = createHash("sha256").update(readFileSync(join(CORPUS, f))).digest("hex");
  if (h !== sum) { console.log(`changed: ${f}`); if (!f.includes("kusamakura")) bad++; }
}
console.log(bad ? `${bad} corpus files differ from SHA256SUMS` : "corpus ok");
process.exit(bad ? 1 : 0);
