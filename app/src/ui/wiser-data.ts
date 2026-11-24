// What the Wiser screens share: where the model's material comes from (the books worker), the bundled text in the
// reader's language, and today's thought, asked for once however many screens want it.
import { books, go } from "./state";
import { activeRoute } from "../ai/providers";
import { todayThought, type Today } from "../wiser/today";
import { readAll, type BundledThought, type BundledLesson } from "../wiser/data";
import type { Say, Source } from "../wiser/pick";
import { lang, t } from "../core/i18n";

export const loadSource = () => books.call<Source>("wiserSource");
export const loadBundled = async (): Promise<{ thoughts: BundledThought[]; lessons: BundledLesson[] }> => lang === "es" ? import("../wiser/bundled-es") : import("../wiser/bundled-en");
// turning the daily thought off in Settings also keeps it from asking a model: it then comes from the reader's own marks or the bundled lines
const dailyOff = () => { try { return localStorage.getItem("vic:wiser:off") === "1"; } catch { return false; } };
const say: Say = (k, a) => t(k, a);
let pending: Promise<Today> | null = null;
export function getToday(): Promise<Today> {
  return pending ??= readAll().then(({ thoughts }) => todayThought({ load: loadSource, bundled: async () => (await loadBundled()).thoughts, say, lang, ai: dailyOff() ? null : activeRoute(), recent: thoughts.slice(0, 3).map(x => x.text) })).finally(() => { pending = null; });
}
export const openLessons = () => go("/wiser");
