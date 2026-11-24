// A card on the shelf, once, that leads to Settings > On this device. It imports nothing from the model code, so the
// first screen does not pay for it.
import { useState } from "preact/hooks";
import { go } from "./state";
import { t } from "../core/i18n";

const SEEN = "vicaria.setup.seen";
export function SetupCard() {
  const [open, setOpen] = useState(() => !localStorage.getItem(SEEN) && !localStorage.getItem("vicaria.models.wanted"));
  if (!open) return null;
  const close = () => { localStorage.setItem(SEEN, "1"); setOpen(false); };
  return (
    <aside class="setupcard" aria-label={t("setup.label")}>
      <div>
        <b>{t("setup.title")}</b>
        <p class="muted">{t("setup.body")}</p>
      </div>
      <div class="row">
        <button class="btn" onClick={() => { close(); go("/settings#device"); }}>{t("setup.choose")}</button>
        <button class="link" onClick={close}>{t("setup.later")}</button>
      </div>
    </aside>
  );
}
