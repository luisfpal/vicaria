// Interface language: English or Spanish. The catalogs are plain objects (src/i18n); a message is text with {name}
// slots and the ICU plural form {n, plural, one {# book} other {# books}} (# is the number). The language is read
// once at start (saved choice, else the browser's, else English); changing it reloads the page, so t() stays a
// plain function and no screen needs to subscribe. Only English ships in the first script; Spanish is its own file,
// fetched before the first render only when it is the language (main.tsx awaits langReady).
import { en } from "../i18n/en";
import { whenIdle } from "./busy";

export type Lang = "en" | "es";
export type Key = keyof typeof en;
export const LANGS: Lang[] = ["en", "es"];
const CATALOGS: Partial<Record<Lang, Record<string, string>>> = { en };
const SAVED = "vic:lang";

export function pickLang(saved: string | null, browser: readonly string[]): Lang {
  if (saved === "en" || saved === "es") return saved;
  for (const l of browser) { const p = l.toLowerCase().split("-")[0]; if (p === "en" || p === "es") return p; }
  return "en";
}
const store = () => { try { return localStorage; } catch { return null; } };
export const lang: Lang = pickLang(store()?.getItem(SAVED) ?? null, typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]);
if (typeof document !== "undefined") document.documentElement.lang = lang;

// resolves when the chosen catalog is in memory; a failed fetch (offline before the file was cached) falls back to English
export const langReady: Promise<void> = lang === "es"
  ? import("../i18n/es").then(m => { CATALOGS.es = m.es; }, () => {})
  : Promise.resolve();

// the page reloads in the new language once nothing a reload would cut is open (an import, a note being written)
export function setLang(l: Lang) { store()?.setItem(SAVED, l); whenIdle(() => location.reload()); }

// {n, plural, one {...} other {...}}: the arms hold no braces of their own; # is the number
function plural(l: Lang, n: number, body: string): string {
  const arms = new Map<string, string>();
  for (const m of body.matchAll(/(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g)) arms.set(m[1], m[2]);
  const arm = arms.get(`=${n}`) ?? arms.get(new Intl.PluralRules(l).select(n)) ?? arms.get("other") ?? "";
  return arm.replace(/#/g, new Intl.NumberFormat(l).format(n));
}
export function format(l: Lang, msg: string, args: Record<string, string | number> = {}): string {
  return msg.replace(/\{(\w+)(?:,\s*plural,\s*((?:[^{}]|\{[^{}]*\})*))?\}/g, (_, name: string, body?: string) => {
    const v = args[name];
    if (v === undefined) return `{${name}}`;
    return body === undefined ? String(v) : plural(l, Number(v), body);
  });
}
export function t(key: Key, args?: Record<string, string | number>): string {
  return format(lang, CATALOGS[lang]?.[key] ?? en[key], args);
}
// a message with one slot that the screen fills with an element (a link): the text before and after it
export function tparts(key: Key, slot: string, args?: Record<string, string | number>): [string, string] {
  const [a, b = ""] = t(key, { ...args, [slot]: "\u0001" }).split("\u0001");
  return [a, b];
}
