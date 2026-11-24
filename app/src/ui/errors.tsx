// Screens for a failure: one layout, three ways out (try again, back to the library, tell us). The report carries the
// version, platform and one short line about the problem, never book content (core/feedback.ts).
import { go, toast } from "./state";
import { VERSION } from "./updates";
import { isNative } from "./nativeupdate";
import { lang, t } from "../core/i18n";
import { platformOf, reportText, issueUrl, type Report } from "../core/feedback";

export function currentReport(problem?: string): Report {
  const how = isNative() ? "desktop or Android app" : matchMedia("(display-mode: standalone)").matches ? "installed web app" : "browser";
  return { version: VERSION, platform: platformOf(navigator.userAgent, navigator.maxTouchPoints), how, lang, problem };
}

export function ErrorScreen(p: { title: string; body: string; problem?: string; reload?: boolean; onLibrary?: () => void }) {
  const r = currentReport(p.problem);
  const copy = async () => { try { await navigator.clipboard.writeText(reportText(r)); toast(t("errors.copied")); } catch { toast(reportText(r), { sticky: true }); } };
  return (
    <section class="page error" role="alert">
      <h1>{p.title}</h1>
      <p>{p.body}</p>
      <div class="row">
        {p.reload && <button class="btn" onClick={() => location.reload()}>{t("errors.reload")}</button>}
        <button class={p.reload ? "btn ghost" : "btn"} onClick={() => { go("/"); p.onLibrary?.(); }}>{t("errors.library")}</button>
        <a class="btn ghost" href={issueUrl(r)} target="_blank" rel="noopener">{t("errors.report")}</a>
        <button class="btn ghost" onClick={copy}>{t("errors.copy")}</button>
      </div>
    </section>
  );
}
