// The bar shown while a book is read aloud: play and pause, sentence back and forward, speed, which voice is
// speaking, and the clearer voice's download.
import { useEffect, useState } from "preact/hooks";
import { listen, onListen, toggle, skip, setRate, stop, neuralFor } from "./player";
import { progressOf, pauseModel, startModel, metered, retrying } from "../models/client";
import { t } from "../core/i18n";

const RATES = [0.8, 1, 1.25, 1.5, 1.75, 2];
const I = (d: string) => <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d={d} fill="currentColor" /></svg>;
const PREV = "M4 3h2v12H4zM15 3v12L7 9z", NEXT = "M12 3h2v12h-2zM3 3v12l8-6z", PLAY = "M5 2.5v13L15.5 9z", PAUSE = "M4.5 3h3.2v12H4.5zM10.3 3h3.2v12h-3.2z";
const mb = (n: number) => t("listen.mb", { n: Math.round(n / 1e6) });

export function ListenBar({ lang }: { lang: string }) {
  const [, tick] = useState(0);
  useEffect(() => onListen(() => tick(n => n + 1)), []);
  if (!listen.on) return null;
  const id = neuralFor(lang), p = id ? progressOf(id) : undefined;
  // once the neural voice is on the device it is the voice, also before Play is pressed again
  let status = listen.engine === "neural" || (listen.engine === "none" && p?.status === "done") ? t("listen.neuralVoice") : listen.engine === "system" ? t("listen.systemVoice") : t("listen.noVoice");
  let action: preact.JSX.Element | null = null;
  if (id && p && p.status !== "done" && listen.engine !== "neural") {
    if (retrying(id)) status = t("listen.retrying");
    else if (p.status === "downloading" || p.status === "queued") {
      status = t("listen.downloading", { pct: Math.floor(100 * p.got / Math.max(1, p.total)) });
      action = <button class="chip" onClick={() => void pauseModel(id)}>{t("listen.pauseDownload")}</button>;
    } else if (p.status === "error") {
      status = t("listen.downloadFailed");
      action = <button class="chip" onClick={() => void startModel(id, true)}>{t("listen.tryAgain")}</button>;
    } else if (p.status === "paused" || p.status === "idle") {
      status = metered() ? t("listen.waitsWifi") : t("listen.size", { size: mb(p.total - p.got) });
      action = <button class="chip" onClick={() => void startModel(id, true)}>{t("listen.download")}</button>;
    }
  }
  return (
    <div class="listenbar" dir="ltr" role="toolbar" aria-label={t("listen.toolbar")}>
      <button class="icon" aria-label={t("listen.prevSentence")} onClick={() => skip(-1)}>{I(PREV)}</button>
      <button class="icon play" aria-label={listen.playing ? t("listen.pause") : t("listen.play")} onClick={toggle}>{I(listen.playing ? PAUSE : PLAY)}</button>
      <button class="icon" aria-label={t("listen.nextSentence")} onClick={() => skip(1)}>{I(NEXT)}</button>
      <button class="chip rate" aria-label={t("listen.speed")} onClick={() => setRate(RATES[(RATES.indexOf(listen.rate) + 1) % RATES.length] ?? 1)}>{listen.rate}×</button>
      <span class="lstatus" aria-live="polite">{status}</span>
      {action}
      <button class="icon close" aria-label={t("listen.stop")} onClick={stop}>×</button>
    </div>
  );
}
export * as player from "./player";
