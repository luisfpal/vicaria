// "Sign in with OpenRouter": OpenRouter's own PKCE flow hands back an ordinary API key for the reader's account, which is
// then stored on this device like any pasted key. No sign-in token is kept and nothing runs on a server of ours.
const VERIFIER = "vic:or:verifier";
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const challengeOf = async (verifier: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

export async function startConnect(callback: string): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
  sessionStorage.setItem(VERIFIER, verifier);
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${await challengeOf(verifier)}&code_challenge_method=S256`;
}
// the code OpenRouter put in the address when it sent the reader back, if there is one to finish
export const pendingCode = (): string | null => { try { return sessionStorage.getItem(VERIFIER) ? new URLSearchParams(location.search).get("code") : null; } catch { return null; } };
export async function finishConnect(code: string, f: typeof fetch = fetch): Promise<string | null> {
  const verifier = sessionStorage.getItem(VERIFIER); sessionStorage.removeItem(VERIFIER);
  if (!verifier) return null;
  const res = await f("https://openrouter.ai/api/v1/auth/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null) as { key?: string } | null;
  return typeof j?.key === "string" && j.key ? j.key : null;
}
