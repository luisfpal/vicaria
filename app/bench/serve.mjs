// Static server that behaves like GitHub Pages: files under a base path, 404.html for unknown routes.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const [dir = "dist", port = "47812", base = "/vicaria/next"] = process.argv.slice(2);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".png": "image/png", ".epub": "application/epub+zip", ".txt": "text/plain", ".wasm": "application/wasm", ".mjs": "text/javascript", ".zip": "application/zip", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".gz": "application/gzip" };
export function serve(d = dir, p = Number(port), b = base) {
  return new Promise(res => {
    const s = createServer(async (req, out) => {
      const url = new URL(req.url, "http://x");
      let path = decodeURIComponent(url.pathname);
      if (!path.startsWith(b + "/") && path !== b) { out.writeHead(404); out.end(); return; }
      path = path.slice(b.length) || "/";
      if (path.endsWith("/")) path += "index.html";
      try {
        const f = join(d, path); if ((await stat(f)).isDirectory()) throw 0;
        out.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream", "cache-control": "no-cache" }); out.end(await readFile(f));
      } catch { out.writeHead(404, { "content-type": TYPES[".html"] }); out.end(await readFile(join(d, "404.html"))); }
    });
    s.listen(p, "127.0.0.1", () => res(s));
  });
}
if (import.meta.url === `file://${process.argv[1]}`) serve().then(() => console.log(`serving ${dir} at http://127.0.0.1:${port}${base}/`));
