// A daily token budget for the two features, counted on this device. Past it the AI tiers pause until tomorrow and the
// next tier answers; nothing is lost and no error is shown. Each call is estimated before it is sent and corrected
// with the provider's own count afterwards.
export const DAY_TOKENS = 30_000;
export const THOUGHT_MAX_OUT = 160, LESSON_MAX_OUT = 800, SUMMARY_MAX_OUT = 200;
export interface Spend { day: string; used: number }
export const estimate = (chars: number) => Math.ceil(chars / 3.5);
export const room = (s: Spend | null, day: string, need: number, cap = DAY_TOKENS) => (s && s.day === day ? s.used : 0) + need <= cap;
export const spent = (s: Spend | null, day: string, tokens: number): Spend => ({ day, used: (s && s.day === day ? s.used : 0) + Math.max(0, Math.round(tokens)) });
const KEY = "vic:wiser:spend";
export const loadSpend = (): Spend | null => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
export const saveSpend = (s: Spend) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full: the budget restarts, which only costs a little */ } };
export const dayOf = (now = Date.now()) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
