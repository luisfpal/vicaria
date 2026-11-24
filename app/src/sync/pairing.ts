// Pairing: a library id and a 256-bit key, shared by QR code or link (the part after # never leaves the device).
// Same code format and storage as 0.x (localStorage "xsync" on the same site), so a browser that was paired in the
// previous version stays paired, and old and new devices pair with each other.
export interface Pairing { lib: string; key: string; relays: string[] }
const KEY = "xsync";
export const b64 = {
  to: (u8: Uint8Array) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  from: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)),
};
export function pairing(): Pairing | null {
  try { const p = JSON.parse(localStorage.getItem(KEY) || "null"); return p && typeof p.lib === "string" && typeof p.key === "string" ? { relays: [], ...p } : null; } catch { return null; }
}
export function savePairing(p: Pairing | null) { if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY); }
export function newPairing(lib?: string): Pairing {
  const hex = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
  return { lib: lib && /^cp-[a-z0-9]{1,36}$/.test(lib) ? lib : `cp-${hex}`, key: b64.to(crypto.getRandomValues(new Uint8Array(32))), relays: [] };
}
export const codeOf = (p: Pairing) => `EXC1.${p.lib}.${p.key}`;
export const linkOf = (p: Pairing, base: string) => `${location.origin}${base}/#pair=${codeOf(p)}`;
export function parseCode(text: string): Pairing | null {
  const m = String(text).trim().replace(/^.*#pair=/, "").match(/^EXC1\.(cp-[a-z0-9]{1,36})\.([A-Za-z0-9_-]{43})$/);
  return m ? { lib: m[1], key: m[2], relays: [] } : null;
}
