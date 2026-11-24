// Writes latest.json for the desktop updater (read by the shell from GitHub Releases) out of a folder holding the
// signed update files: Vicaria_<version>_<arch>.app.tar.gz and Vicaria_<version>_<arch>.AppImage, each with a .sig.
// usage: node scripts/latest-json.mjs <version> <folder> <download base url> [notes] > latest.json
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PLATFORM = [
  [/^Vicaria_.+_aarch64\.app\.tar\.gz$/, "darwin-aarch64"],
  [/^Vicaria_.+_(x64|x86_64)\.app\.tar\.gz$/, "darwin-x86_64"],
  [/^Vicaria_.+_(amd64|x86_64)\.AppImage$/, "linux-x86_64"],
  [/^Vicaria_.+_aarch64\.AppImage$/, "linux-aarch64"],
];

export function buildLatest({ version, notes = "", base, files, date = new Date() }) {
  const platforms = {};
  for (const name of Object.keys(files)) {
    const hit = PLATFORM.find(([re]) => re.test(name));
    if (!hit) continue;
    const sig = files[name + ".sig"];
    if (!sig) throw new Error(`${name} has no .sig next to it`);
    if (platforms[hit[1]]) throw new Error(`two update files for ${hit[1]}`);
    platforms[hit[1]] = { signature: sig.trim(), url: `${base.replace(/\/$/, "")}/${encodeURIComponent(name)}` };
  }
  if (!Object.keys(platforms).length) throw new Error("no update files found");
  return { version, notes, pub_date: date.toISOString(), platforms };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, dir, base, notes = ""] = process.argv.slice(2);
  if (!version || !dir || !base) { console.error("usage: latest-json.mjs <version> <folder> <base url> [notes]"); process.exit(64); }
  const files = Object.fromEntries(readdirSync(dir).filter(f => /^Vicaria_/.test(f)).map(f => [f, f.endsWith(".sig") ? readFileSync(join(dir, f), "utf8") : ""]));
  process.stdout.write(JSON.stringify(buildLatest({ version, notes, base, files }), null, 2) + "\n");
}
