// The optional daily reminder, with no server. The web platform cannot wake a closed page without a push server, so a
// timer runs while Vicaria is open or in the background and shows one notice at the chosen time, through the service
// worker (the only way Chrome on Android shows one). It stays quiet while the app is on screen: the card is already
// there. Off by default; the time lives on this device only.
import { dayOf } from "./budget";
import { cachedToday } from "./today";
import { t, lang } from "../core/i18n";

export const KEY = "vic:wiser:notify", DONE = "vic:wiser:notified";
export const supported = () => typeof Notification !== "undefined" && "serviceWorker" in navigator;
export const timeSet = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// the next moment the clock shows HH:MM, strictly after `now`
export function nextAt(time: string, now: Date): number {
  const [h, m] = time.split(":").map(Number), at = new Date(now); at.setHours(h, m, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}
let timer = 0;
export function stop() { clearTimeout(timer); timer = 0; }
export function start() {
  stop();
  const time = timeSet(); if (!time || !validTime(time) || !supported() || Notification.permission !== "granted") return;
  const wait = Math.min(nextAt(time, new Date()) - Date.now(), 2 ** 31 - 1);
  timer = window.setTimeout(async () => { await fire().catch(() => {}); start(); }, wait);
}
async function fire() {
  const day = dayOf();
  if (localStorage.getItem(DONE) === day || document.visibilityState === "visible") return;
  const reg = await navigator.serviceWorker.getRegistration(); if (!reg) return;
  const today = await cachedToday(day, lang).catch(() => null);
  localStorage.setItem(DONE, day);
  await reg.showNotification(t("wiser.notifyTitle"), { body: today ? today.thought.text.slice(0, 140) : t("wiser.notifyBody"), tag: "vicaria-daily", icon: "icons/icon-192.png", data: { url: "./" } });
}
export async function enable(time: string): Promise<"on" | "denied" | "unsupported"> {
  if (!supported()) return "unsupported";
  const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (p !== "granted") return "denied";
  localStorage.setItem(KEY, time); start(); return "on";
}
export function disable() { localStorage.removeItem(KEY); stop(); }
