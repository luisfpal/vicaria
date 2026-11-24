import { render } from "preact";
import { App, screenReady } from "./ui/app";
import { applyPrefs, mark } from "./ui/state";
import { langReady } from "./core/i18n";
import "./ui/styles.css";

applyPrefs();
const root = document.getElementById("app")!;
// the page ships a top bar so the first paint is not blank; a book has no top bar, so the one left over would sit under the text
void Promise.all([langReady, screenReady(location.pathname)]).then(() => {
  if (/\/book\/[0-9a-f]{16}/.test(location.pathname)) root.textContent = "";
  render(<App />, root);
  mark("vic:shell");
});
