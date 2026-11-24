// Models that make Vicaria better on this device: what each does, its size, and Download, Pause and Remove. The app
// works without any of them. Shown in Settings ("On this device").
import { useEffect, useState } from "preact/hooks";
import { CATALOG, type CatalogModel } from "../models/catalog";
import { progressOf, onProgress, checkModels, startModel, pauseModel, removeModel, metered, retrying, isWanted } from "../models/client";
import { usedBytes } from "../models/opfs";
import { t, type Key } from "../core/i18n";

const NOTE: Record<CatalogModel["kind"], Key> = {
  voice: "ondevice.voice",
  search: "ondevice.search",
  speech: "ondevice.speech",
};
export const sizeOf = (m: CatalogModel) => m.files.reduce((n, f) => n + f.size, 0);
const mb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
function useModels() {
  const [, tick] = useState(0);
  useEffect(() => { void checkModels(); return onProgress(() => tick(n => n + 1)); }, []);
}

export function OnDevice() {
  useModels();
  const [used, setUsed] = useState<number | null>(null);
  const done = CATALOG.filter(m => progressOf(m.id)?.status === "done").length;
  useEffect(() => { usedBytes().then(setUsed).catch(() => {}); }, [done, CATALOG.map(m => progressOf(m.id)?.status).join()]);
  return (
    <>
      <h2 id="device">{t("ondevice.heading")}</h2>
      <p class="muted">{t("ondevice.body")}</p>
      {metered() && <p class="muted" role="status">{t("ondevice.metered")}</p>}
      <ul class="models">{CATALOG.map(m => <Row key={m.id} m={m} />)}</ul>
      <p class="muted small" data-used>{used == null ? "" : used ? t("ondevice.used", { size: mb(used) }) : t("ondevice.none")}</p>
    </>
  );
}

function Row({ m }: { m: CatalogModel }) {
  const p = progressOf(m.id), size = sizeOf(m);
  const [sure, setSure] = useState(false);
  const busy = p?.status === "downloading" || p?.status === "queued";
  const pct = p ? Math.floor(100 * p.got / Math.max(1, p.total)) : 0;
  let state = `${mb(size)}`;
  if (p?.status === "done") state = t("ondevice.onDevice", { size: mb(size) });
  else if (busy) state = t("ondevice.downloading", { pct, size: mb(size) });
  else if (p?.status === "error") state = retrying(m.id) ? t("ondevice.connectionLost") : t("ondevice.failed");
  else if (p?.status === "paused" && p.got > 0) state = t("ondevice.paused", { pct, size: mb(size) });
  else if (p?.status === "paused" && isWanted(m.id) && metered()) state = t("ondevice.waitingWifi", { size: mb(size) });
  return (
    <li data-model={m.id}>
      <span><b>{m.label}</b> <span class="muted">{t(NOTE[m.kind])}</span><br /><span class="muted small" role="status">{state}</span>
        {busy && <progress max={100} value={pct} aria-label={t("ondevice.downloadLabel", { name: m.label })} />}</span>
      <span class="row">
        {p?.status === "done" ? (sure
          ? <><button class="btn danger" onClick={() => { setSure(false); void removeModel(m.id); }}>{t("ondevice.remove")}</button><button class="link" onClick={() => setSure(false)}>{t("ondevice.cancel")}</button></>
          : <button class="link" onClick={() => setSure(true)}>{t("ondevice.remove")}</button>)
          : busy ? <button class="link" onClick={() => void pauseModel(m.id)}>{t("ondevice.pause")}</button>
          : <>
            <button class="btn ghost" onClick={() => void startModel(m.id, true)}>{t(p?.got ? "ondevice.resume" : "ondevice.download")}</button>
            {p?.got ? <button class="link" onClick={() => void removeModel(m.id)}>{t("ondevice.remove")}</button> : null}
          </>}
      </span>
    </li>
  );
}
