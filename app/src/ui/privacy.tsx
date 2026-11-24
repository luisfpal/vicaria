import { t, tparts } from "../core/i18n";
import { REPO } from "../core/feedback";

export function Privacy() {
  const [a, b] = tparts("privacy.code", "link");
  return (
    <section class="page privacy">
      <h1>{t("privacy.title")}</h1>
      <p>{t("privacy.lead")}</p>
      <h2>{t("privacy.staysHeading")}</h2>
      <p>{t("privacy.stays")}</p>
      <h2>{t("privacy.leavesHeading")}</h2>
      <ul>{(["ai", "wiser", "sync", "downloads", "updates", "feedback"] as const).map(k => <li key={k}>{t(`privacy.${k}`)}</li>)}</ul>
      <h2>{t("privacy.neverHeading")}</h2>
      <p>{t("privacy.never")}</p>
      <h2>{t("privacy.controlHeading")}</h2>
      <p>{t("privacy.control")}</p>
      <p class="muted">{a}<a href={REPO} target="_blank" rel="noopener">github.com/luisfpal/vicaria</a>{b}</p>
    </section>
  );
}
