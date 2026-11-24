import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { execSync } from "node:child_process";
import pkg from "./package.json" with { type: "json" };

const build = (() => { try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "dev"; } })();
export default defineConfig({
  base: process.env.VIC_BASE || "/",
  plugins: [preact()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD__: JSON.stringify(build) },
  worker: { format: "es" },
  build: { manifest: true, target: "es2022", modulePreload: { polyfill: false }, assetsInlineLimit: 0, reportCompressedSize: false },
});
