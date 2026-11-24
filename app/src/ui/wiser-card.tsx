// The quiet card on the shelf: today's thought, once, the first time the app opens that day. It never comes back after
// it is closed or after the day's first open, and it never asks for anything. Also the thought view the Wiser screen
// uses. Loaded only when a thought is due (the library decides), so the first script does not carry it.
import { useEffect, useState } from "preact/hooks";
import { getToday, openLessons } from "./wiser-data";
import { putThought, readAll, type Thought } from "../wiser/data";
import { dayOf } from "../wiser/budget";
import type { Today } from "../wiser/today";
import { t } from "../core/i18n";

export const SEEN = "vic:wiser:seen";
const Heart = (p: { on: boolean }) => <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.3C1.2 8.4 3 5 6.3 5c2 0 3.6 1.1 4.4 2.6h2.6C14.1 6.1 15.7 5 17.7 5 21 5 22.8 8.4 21.5 11.7 19.5 16.4 12 21 12 21z" fill={p.on ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>;

export function useSaved(th: Thought | null) {
  const [on, set] = useState(false);
  useEffect(() => { if (th) readAll().then(a => set(a.thoughts.some(x => x.id === th.id))).catch(() => {}); }, [th?.id]);
  return [on, async () => { if (!th) return; const next = !on; set(next); await putThought(next ? { ...th, made: Date.now() } : { ...th, gone: true }); }] as const;
}

export function ThoughtView({ today, children }: { today: Today; children?: preact.ComponentChildren }) {
  const th = today.thought, [saved, toggle] = useSaved(th);
  return <>
    <blockquote class="wtext" lang={today.lang}>{th.text}</blockquote>
    {th.act && <p class="wact">{th.src === "mine" ? t("wiser.yourNote", { act: th.act }) : th.src === "bundled" ? t("wiser.try", { act: th.act }) : th.act}</p>}
    <p class="wsrc muted small">{[th.by, th.from && t("wiser.from", { from: th.from }), t(`wiser.tier.${today.tier}`)].filter(Boolean).join(" · ")}</p>
    <div class="row wrow">
      <button class={`icon wheart ${saved ? "on" : ""}`} aria-pressed={saved} aria-label={saved ? t("wiser.saved") : t("wiser.save")} title={saved ? t("wiser.saved") : t("wiser.save")} onClick={toggle}><Heart on={saved} /></button>
      {children}
    </div>
  </>;
}

export function DailyCard() {
  const [today, setToday] = useState<Today | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    // marked at once: a closed tab, a failed call or a reload never shows it a second time
    try { localStorage.setItem(SEEN, dayOf()); } catch { /* private mode: the card may show again, which is harmless */ }
    getToday().then(setToday).catch(() => {});
  }, []);
  if (!today || !open) return null;
  return (
    <aside class="wisercard" aria-label={t("wiser.cardLabel")}>
      <div class="whead"><b class="small muted">{t("wiser.cardLabel")}</b><button class="icon wclose" aria-label={t("wiser.close")} onClick={() => setOpen(false)}>×</button></div>
      <ThoughtView today={today}>
        <span class="grow" />
        <button class="link" onClick={() => { setOpen(false); openLessons(); }}>{t("wiser.offer")}</button>
      </ThoughtView>
    </aside>
  );
}
