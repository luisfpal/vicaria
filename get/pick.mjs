// Which download to offer: pure functions, tested by app/tests/get.test.ts; index.html wires them to the page.
export const REPO = "luisfpal/vicaria";
export const WEB = "https://luisfpal.github.io/vicaria/next/";
export const INSTALL = "curl -fsSL https://luisfpal.github.io/vicaria/install.sh | sh";

export function detect(ua, platform = "", touchPoints = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform || ua) && touchPoints > 1)) return "ios"; // iPadOS says it is a Mac
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Mac/.test(ua)) return "mac";
  if (/Linux|X11|CrOS/.test(ua)) return "linux";
  return "other";
}

// assets: [{ name, browser_download_url }] of the latest release
export function assetFor(kind, assets) {
  const by = re => assets.find(a => re.test(a.name))?.browser_download_url ?? null;
  if (kind === "android") return { apk: by(/_android\.apk$/) };
  if (kind === "mac") return { arm: by(/_aarch64\.dmg$/), intel: by(/_x64\.dmg$/) };
  if (kind === "linux") return { appimage: by(/_amd64\.AppImage$/), deb: by(/_amd64\.deb$/) };
  return {};
}

export const obtainiumLink = `obtainium://add/https://github.com/${REPO}`;

export const TEXT = {
  en: {
    benefits: [["Ask the book", "Answers quote the passages they came from. Tap one to jump to the page."], ["Keep the ideas", "Highlight as you read. Ideas shows how your books connect."], ["Listen", "Any book read aloud, with a voice that runs on your device."], ["Yours alone", "Books, notes and keys stay on your device. No account. Sync by scanning a code."]],
    title: "Get Vicaria", lead: "Read a book, ask it anything, keep what it taught you.",
    ios: "On iPhone and iPad", iosSteps: ["Open this page in Safari.", "Tap the Share button.", "Choose Add to Home Screen, then Add."], iosOpen: "Open Vicaria in Safari",
    android: "Get the Android app", androidApk: "Download the APK", androidObt: "Keep it updated with Obtainium", androidNote: "Android asks once to allow installs from your browser. Without the app, Vicaria also works in Chrome: open the web app and choose Install.",
    mac: "Get Vicaria for Mac", macCmd: "Paste this in Terminal", macArm: "Download for Apple silicon (.dmg)", macIntel: "Download for Intel (.dmg)", macNote: "The app is not signed with an Apple developer account. The Terminal line opens it without a warning; after the .dmg, open System Settings, Privacy & Security, and choose Open Anyway once.",
    linux: "Get Vicaria for Linux", linuxCmd: "Paste this in a terminal", linuxAppimage: "Download the AppImage", linuxDeb: "Download the .deb", linuxNote: "On Ubuntu 24.04 and later the AppImage needs FUSE 2: sudo apt install libfuse2t64.",
    windows: "On Windows", windowsNote: "There is no Windows app yet. Open the web app in Edge or Chrome and choose Install.", web: "Open the web app",
    other: "Other devices", pending: "The downloads appear here once the first release is published.", all: "All downloads and notes",
  },
  es: {
    benefits: [["Pregunta al libro", "Las respuestas citan los pasajes de donde vienen. Toca uno para ir a la página."], ["Conserva las ideas", "Subraya mientras lees. Ideas muestra cómo se conectan tus libros."], ["Escucha", "Cualquier libro en voz alta, con una voz que funciona en tu dispositivo."], ["Solo tuyo", "Libros, notas y claves se quedan en tu dispositivo. Sin cuenta. Sincroniza escaneando un código."]],
    title: "Descarga Vicaria", lead: "Lee un libro, pregúntale lo que quieras y conserva lo que te enseñó.",
    ios: "En iPhone y iPad", iosSteps: ["Abre esta página en Safari.", "Toca el botón Compartir.", "Elige Añadir a pantalla de inicio y luego Añadir."], iosOpen: "Abrir Vicaria en Safari",
    android: "Descarga la app para Android", androidApk: "Descargar el APK", androidObt: "Mantenla al día con Obtainium", androidNote: "Android pide una vez permiso para instalar desde tu navegador. Sin la app, Vicaria también funciona en Chrome: abre la versión web y elige Instalar.",
    mac: "Descarga Vicaria para Mac", macCmd: "Pega esto en Terminal", macArm: "Descargar para Apple silicon (.dmg)", macIntel: "Descargar para Intel (.dmg)", macNote: "La app no está firmada con una cuenta de desarrollador de Apple. La línea de Terminal la abre sin aviso; con el .dmg, abre Ajustes del Sistema, Privacidad y seguridad, y elige Abrir de todos modos una vez.",
    linux: "Descarga Vicaria para Linux", linuxCmd: "Pega esto en una terminal", linuxAppimage: "Descargar el AppImage", linuxDeb: "Descargar el .deb", linuxNote: "En Ubuntu 24.04 y posteriores el AppImage necesita FUSE 2: sudo apt install libfuse2t64.",
    windows: "En Windows", windowsNote: "Todavía no hay app para Windows. Abre la versión web en Edge o Chrome y elige Instalar.", web: "Abrir la versión web",
    other: "Otros dispositivos", pending: "Las descargas aparecen aquí cuando se publique la primera versión.", all: "Todas las descargas y notas",
  },
};
