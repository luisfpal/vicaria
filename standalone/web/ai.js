// Excerpta: connect AI in one tap. OpenRouter's official OAuth (PKCE) hands this device its own key; nothing is pasted
// and nothing passes through a server of ours. The key is stored only on this device, like any key saved in Settings.
(() => {
  const BASE = window.EXC_BASE || "", OR = "https://openrouter.ai";
  const MODEL = "deepseek/deepseek-chat";  // cheap and good for cards; changeable in Settings
  const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const api = async (p, o) => { const r = await fetch(BASE + p, o); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
  const say = t => window.toast?.(t);

  async function connect() {
    const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    sessionStorage.orVerifier = verifier; sessionStorage.orReturn = location.pathname;
    location.href = `${OR}/auth?callback_url=${encodeURIComponent(location.origin + BASE + "/")}&code_challenge=${challenge}&code_challenge_method=S256`;
  }
  async function finish(code) {
    const verifier = sessionStorage.orVerifier; delete sessionStorage.orVerifier;
    const back = sessionStorage.orReturn || BASE + "/"; delete sessionStorage.orReturn;
    history.replaceState(null, "", back);
    if (!verifier) return;
    try {
      const r = await fetch(`${OR}/api/v1/auth/keys`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
      const j = await r.json(); if (!r.ok || !j.key) throw new Error(j.error?.message || "OpenRouter did not return a key");
      await api("/api/settings", { method: "POST", body: JSON.stringify({ provider: "custom", model: "", fallback: true, custom: { base_url: `${OR}/api/v1`, model: MODEL } }) });
      const x = await api("/api/keys/custom", { method: "PUT", body: JSON.stringify({ key: j.key }) });
      say(x.check?.ok ? "AI connected through OpenRouter." : "Connected, but OpenRouter did not answer yet: " + (x.check?.error || ""));
      navigator.serviceWorker.controller?.postMessage({ type: "invalidate" }); window.route?.(); paintNav();
    } catch (e) { say("Could not connect: " + e.message); }
  }
  async function ready() { try { return (await api("/api/settings")).providers.some(p => p.status?.state === "ready" && !/cli$/.test(p.id) && p.id !== "ollama"); } catch { return true; } }

  function panel() {
    const h = (t, a = {}, ...k) => { const n = document.createElement(t); for (const [x, v] of Object.entries(a)) x.startsWith("on") ? n.addEventListener(x.slice(2), v) : n.setAttribute(x, v); n.append(...k); return n; };
    const body = h("div", {},
      h("p", {}, "Cards, answers and recaps need an AI model. Pick one:"),
      h("div", { class: "x-row" }, h("button", { class: "x-btn", onclick: connect }, "Connect with OpenRouter"), h("span", { class: "x-muted" }, "One tap. Sign in, approve, done. Pay-as-you-go credits; hundreds of models.")),
      h("div", { class: "x-row" }, h("a", { class: "x-ghost", href: BASE + "/settings", "data-link": "", onclick: e => { e.preventDefault(); window.ExcPanels.close(); window.go(BASE + "/settings"); } }, "Use an API key instead"),
        h("span", { class: "x-muted" }, "DeepSeek, Anthropic, Gemini, xAI or OpenAI.")),
      h("p", { class: "x-muted" }, "Keys stay on this device. AI requests go straight from here to the provider."));
    window.ExcPanels.show("Connect AI", body);
  }
  async function paintNav() {
    const nav = document.querySelector("header.bar nav"); if (!nav) return;
    let a = nav.querySelector("#navAI");
    if (await ready()) { a?.remove(); return; }
    if (!a) { a = document.createElement("a"); a.id = "navAI"; a.href = "#"; a.textContent = "Connect AI"; a.title = "Connect AI in one tap"; a.style.cssText = "font-weight:600;color:var(--accent,#b4532a)"; a.onclick = e => { e.preventDefault(); panel(); }; nav.append(a); }
  }
  // An AI error inside the app ("no key yet") gets the one-tap way out next to it.
  new MutationObserver(() => {
    for (const box of document.querySelectorAll("#app .error:not([data-x])")) {
      box.dataset.x = 1;
      if (/key|Settings|sign/i.test(box.textContent)) { const b = document.createElement("button"); b.className = "btn"; b.textContent = "Connect AI in one tap"; b.onclick = panel; box.append(b); }
    }
  }).observe(document.getElementById("app"), { childList: true, subtree: true });

  window.ExcAI = { connect, panel, ready };
  const code = new URLSearchParams(location.search).get("code");
  if (code && sessionStorage.orVerifier) finish(code); else setTimeout(paintNav, 1200);
})();
