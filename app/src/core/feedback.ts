// Feedback is a prefilled GitHub issue: version, platform and, after a failure, one short line about it. Never book
// text, titles, notes or keys. When GitHub is not an option the same text can be copied (ui/errors.tsx).
export const REPO = "https://github.com/luisfpal/vicaria";

export interface Report { version: string; platform: string; how: string; lang: string; problem?: string }

export function platformOf(ua: string, touchPoints: number): string {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPod/.test(ua) ? "iOS" : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? "iPadOS"
    : /Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Unknown system";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  return `${os}, ${browser}`;
}

export function reportText(r: Report): string {
  const lines = [`Vicaria ${r.version}`, `Platform: ${r.platform} (${r.how})`, `Language: ${r.lang}`];
  if (r.problem) lines.push(`Problem: ${r.problem.split("\n")[0].slice(0, 200)}`);
  lines.push("No book text, titles or notes are in this report.");
  return lines.join("\n");
}

export function issueUrl(r: Report): string {
  const body = `What happened:\n\n\n---\n${reportText(r)}`;
  return `${REPO}/issues/new?title=${encodeURIComponent("Feedback: ")}&body=${encodeURIComponent(body)}`;
}
