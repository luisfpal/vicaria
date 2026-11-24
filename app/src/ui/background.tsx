// Reading backgrounds: a preset (drawn by CSS, nothing to download) or the reader's own photo, blurred and dimmed
// toward the page color until the text meets WCAG AA. Per device; the choice (not the photo) can follow the reader to
// other devices. The layer is drawn after the text and never takes part in layout.
import { useEffect, useMemo, useState } from "preact/hooks";
import { store, use, prefs, toast } from "./state";
import { get, put, del } from "../core/idb";
import { addOp, latestUnfiled } from "../core/ops";
import { AA, AAA, dimFor, hex, worstContrast, type RGB } from "../core/contrast";
import { t } from "../core/i18n";
import type { Key } from "../core/i18n";

type Stop = [number, string];
interface Preset { name: string; stops: Stop[]; angle: number }
export const PRESETS: Record<string, Preset> = {
  dawn: { name: "Dawn", angle: 160, stops: [[0, "#f6d5b8"], [0.5, "#e9b7a7"], [1, "#b9a3c9"]] },
  sea: { name: "Sea", angle: 180, stops: [[0, "#bfe0ea"], [0.6, "#6fa8c4"], [1, "#2f5f80"]] },
  forest: { name: "Forest", angle: 170, stops: [[0, "#cfdcb6"], [0.5, "#7d9c6a"], [1, "#2f4a35"]] },
  dusk: { name: "Dusk", angle: 200, stops: [[0, "#3b3561"], [0.55, "#7b4d6e"], [1, "#d0866a"]] },
  stone: { name: "Stone", angle: 135, stops: [[0, "#e4e1dc"], [0.5, "#b9b4ab"], [1, "#8d877d"]] },
};
export interface Bg { kind: "none" | "preset" | "photo"; preset: string; dim: number; blur: number; auto: boolean; sync: boolean; cells?: RGB[]; t?: number }
const DEFAULT: Bg = { kind: "none", preset: "dawn", dim: 0.5, blur: 12, auto: true, sync: false };
export const bg = store<Bg>({ ...DEFAULT, ...JSON.parse(localStorage.getItem("vic:bg") || "{}") });
export function setBg(p: Partial<Bg>, fromSync = false) {
  const n = { ...bg.get(), ...p, ...(fromSync ? {} : { t: Date.now() }) }; bg.set(n); localStorage.setItem("vic:bg", JSON.stringify(n));
  if (n.sync && !fromSync) { const { kind, preset, dim, blur, auto } = n; addOp("bg", { kind: kind === "photo" ? "none" : kind, preset, dim, blur, auto }).catch(() => {}); }
}

// a choice made on another device, when this one follows it and the other is newer (the photo never travels)
export async function applySyncedBg() {
  const b = bg.get(); if (!b.sync) return;
  const o = await latestUnfiled("bg"); if (!o || o.t <= (b.t ?? 0)) return;
  const v = o.v as Partial<Bg>;
  if (b.kind === "photo") return; // this device's own photo stays until changed here
  const kind = v.kind === "preset" && typeof v.preset === "string" && PRESETS[v.preset] ? "preset" : "none";
  setBg({ kind, preset: kind === "preset" ? v.preset! : b.preset, dim: Math.min(0.95, Math.max(0, Number(v.dim) || 0)), blur: Math.min(40, Math.max(0, Number(v.blur) || 0)), auto: v.auto !== false, t: o.t }, true);
}
const css = (p: Preset) => `linear-gradient(${p.angle}deg, ${p.stops.map(([o, c]) => `${c} ${Math.round(o * 100)}%`).join(", ")})`;
// a 36 by 48 grid of colors of the picture: fine enough that a busy pattern counts at its darkest, not averaged away
function cellsOf(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): RGB[] {
  const c = document.createElement("canvas"); c.width = 36; c.height = 48;
  const g = c.getContext("2d", { willReadFrequently: true })!; draw(g, 36, 48);
  const d = g.getImageData(0, 0, 36, 48).data, out: RGB[] = [];
  for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
  return out;
}
const presetCells = (p: Preset) => cellsOf((g, w, h) => {
  const a = (p.angle - 90) * Math.PI / 180, cx = w / 2, cy = h / 2, r = Math.abs(w * Math.cos(a) / 2) + Math.abs(h * Math.sin(a) / 2);
  const gr = g.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  for (const [o, col] of p.stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});

export async function choosePhoto(file: File) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob>((ok, bad) => c.toBlob(b => b ? ok(b) : bad(new Error("no image")), "image/jpeg", 0.85));
    const cells = cellsOf((g, w, h) => g.drawImage(bmp, 0, 0, w, h));
    await put("kv", blob, "bg:photo");
    photoUrl.set(URL.createObjectURL(blob));
    setBg({ kind: "photo", cells });
  } catch { toast(t("reader.badPicture")); }
}
export async function clearPhoto() { await del("kv", "bg:photo"); photoUrl.set(""); setBg({ kind: "none", cells: undefined }); }
const photoUrl = store("");

function themeColors(): { ink: RGB; paper: RGB } {
  const s = getComputedStyle(document.documentElement);
  return { ink: hex(s.getPropertyValue("--ink") || "#1f1d1a"), paper: hex(s.getPropertyValue("--paper") || "#f7f4ee") };
}
// the dim actually used, and the contrast it gives
export function useBgLook() {
  const b = use(bg), p = use(prefs);
  return useMemo(() => {
    if (b.kind === "none") return null;
    const cells = b.kind === "preset" ? presetCells(PRESETS[b.preset] ?? PRESETS.dawn) : b.cells ?? [];
    const { ink, paper } = themeColors();
    const need = dimFor(cells, ink, paper, AA);
    const dim = b.auto ? Math.max(b.dim, need) : b.dim;
    return { dim, need, contrast: worstContrast(cells, ink, paper, dim), paper };
  }, [b.kind, b.preset, b.dim, b.auto, b.cells, p.theme]);
}

// The layer itself. Rendered by the reader; loads the photo only after the text is up.
export function BgLayer(props: { textShown: boolean }) {
  const b = use(bg), url = use(photoUrl), look = useBgLook();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!props.textShown || ready) return;
    const go = () => requestAnimationFrame(() => setReady(true));
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const timer = idle ? idle(go, { timeout: 500 }) : window.setTimeout(go, 200);
    return () => { if (!idle) clearTimeout(timer); };
  }, [props.textShown]);
  useEffect(() => {
    if (!ready || b.kind !== "photo" || url) return;
    get<Blob>("kv", "bg:photo").then(x => { if (x) photoUrl.set(URL.createObjectURL(x)); });
  }, [ready, b.kind, url]);
  const on = ready && !!look && (b.kind === "preset" || !!url);
  // body paints its own page color above a layer behind it; let the layer show while it is up
  useEffect(() => { document.documentElement.classList.toggle("hasbg", on); return () => document.documentElement.classList.remove("hasbg"); }, [on]);
  if (!ready || !look) return null;
  const image = b.kind === "preset" ? css(PRESETS[b.preset] ?? PRESETS.dawn) : url ? `url("${url}")` : "";
  if (!image) return null;
  const [r, g, bl] = look.paper;
  return (
    <div class="readbg" aria-hidden="true">
      <div class="img" style={{ backgroundImage: image, filter: b.blur ? `blur(${b.blur}px)` : "" }} />
      <div class="veil" style={{ background: `rgba(${r}, ${g}, ${bl}, ${look.dim})` }} />
    </div>
  );
}

export function BgPicker() {
  const b = use(bg), look = useBgLook();
  const ratio = look ? look.contrast.toFixed(1) : "";
  return (
    <div class="bgpick">
      <div class="row">
        <button class={`swb none ${b.kind === "none" ? "on" : ""}`} onClick={() => setBg({ kind: "none" })} aria-label={t("reader.bgNoneLabel")}>{t("reader.bgNone")}</button>
        {Object.entries(PRESETS).map(([k, p]) => { const name = t(("reader.preset." + k) as Key); return <button key={k} class={`swb ${b.kind === "preset" && b.preset === k ? "on" : ""}`} style={{ backgroundImage: css(p) }} aria-label={name} title={name} onClick={() => setBg({ kind: "preset", preset: k })} />; })}
        <label class={`swb photo ${b.kind === "photo" ? "on" : ""}`} title={t("reader.bgYourPhoto")}>{t("reader.bgPhoto")}<input type="file" accept="image/*" hidden onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) choosePhoto(f); }} /></label>
      </div>
      {b.kind !== "none" && look && <>
        <label>{t("reader.dim")} <input type="range" min="0" max="0.95" step="0.05" value={look.dim} onInput={e => setBg({ dim: +(e.target as HTMLInputElement).value, auto: false })} /></label>
        <label>{t("reader.blur")} <input type="range" min="0" max="40" step="2" value={b.blur} onInput={e => setBg({ blur: +(e.target as HTMLInputElement).value })} /></label>
        <label class="check"><input type="checkbox" checked={b.auto} onChange={e => setBg({ auto: (e.target as HTMLInputElement).checked })} /> {t("reader.keepReadable")}</label>
        <p class={`contrast ${look.contrast >= AA ? "ok" : "low"}`} role="status">{look.contrast >= AAA ? t("reader.contrastAAA", { ratio }) : look.contrast >= AA ? t("reader.contrastAA", { ratio }) : t("reader.contrastLow", { ratio })}</p>
        <label class="check"><input type="checkbox" checked={b.sync} onChange={e => setBg({ sync: (e.target as HTMLInputElement).checked })} /> {b.kind === "photo" ? t("reader.bgSyncPhoto") : t("reader.bgSync")}</label>
        {b.kind === "photo" && <button class="link danger" onClick={clearPhoto}>{t("reader.removePhoto")}</button>}
      </>}
    </div>
  );
}
