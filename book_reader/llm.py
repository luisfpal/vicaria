"""One streaming call for any model. The adapters in providers/ do the talking; this file keeps keys, the choice and fallback.

Keys come from an environment variable, keys/<provider>.key (written by Settings, mode 600), or a key file named in
config.json. They are never logged, never sent back to a browser in full, and never written anywhere else.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Iterator

from .providers import ADAPTERS, LLMError, NoKey, RateLimited

ROOT = Path(__file__).resolve().parent.parent


def keys_dir() -> Path:
    return Path(os.environ.get("COMMONPLACE_KEYS", ROOT / "keys"))

DEFAULT_PROVIDERS = {
    "deepseek": {"label": "DeepSeek", "kind": "openai", "base_url": "https://api.deepseek.com",
                 "model": "deepseek-chat", "key_env": "DEEPSEEK_API_KEY"},
    "claude-cli": {"label": "Claude (your Claude subscription, through Claude Code)", "kind": "claude-cli",
                   "command": "claude", "model": "haiku"},
    "codex-cli": {"label": "ChatGPT (your ChatGPT plan, through Codex)", "kind": "codex-cli",
                  "command": "codex", "model": "gpt-6-luna"},
    "grok-cli": {"label": "Grok (your SuperGrok or X plan, through the Grok CLI)", "kind": "grok-cli",
                 "command": "grok", "model": ""},
    "gemini": {"label": "Gemini (Google AI Studio key, free tier)", "kind": "openai",
               "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-3.1-flash-lite",
               "key_env": "GEMINI_API_KEY"},
    "anthropic": {"label": "Claude (Anthropic API key)", "kind": "anthropic", "base_url": "https://api.anthropic.com",
                  "model": "claude-haiku-4-5", "key_env": "ANTHROPIC_API_KEY"},
    "openai": {"label": "OpenAI (API key)", "kind": "openai", "base_url": "https://api.openai.com/v1",
               "model": "gpt-4.1-mini", "key_env": "OPENAI_API_KEY"},
    "xai": {"label": "Grok (xAI API key)", "kind": "openai", "base_url": "https://api.x.ai/v1",
            "model": "grok-4-fast", "key_env": "XAI_API_KEY"},
    "custom": {"label": "Any OpenAI-compatible server (OpenRouter, Ollama, llama.cpp)", "kind": "openai",
               "base_url": "", "model": "", "key_env": "CUSTOM_API_KEY", "optional_key": True},
    "ollama": {"label": "Local (Ollama)", "kind": "openai", "base_url": "http://localhost:11434/v1",
               "model": "llama3.1", "local": True},
}
# Subscriptions first (already paid for), then the cheapest keys.
FALLBACK_ORDER = ["deepseek", "claude-cli", "codex-cli", "grok-cli", "gemini", "anthropic", "openai", "xai", "custom"]


# Models offered in Settings: cheap and good first. Anything pricier must be chosen on purpose in config.json.
MODELS = {
    "deepseek": [("deepseek-chat", "DeepSeek V3 chat, cheapest, default"), ("deepseek-reasoner", "DeepSeek reasoner, slower")],
    "claude-cli": [("haiku", "Haiku, light on your plan's limits"), ("sonnet", "Sonnet, uses limits faster")],
    "codex-cli": [("gpt-6-luna", "GPT-6 Luna, light on your plan's limits"), ("gpt-6.1-sol", "GPT-6.1 Sol, uses limits much faster")],
    "grok-cli": [("", "The Grok CLI's default"), ("grok-4.5", "Grok 4.5"), ("grok-4.6", "Grok 4.6")],
    "gemini": [("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite, cheapest"), ("gemini-3.5-flash", "Gemini 3.5 Flash")],
    "anthropic": [("claude-haiku-4-5", "Claude Haiku 4.5, fast and cheap"), ("claude-sonnet-4-5", "Claude Sonnet 4.5, about 3x the price")],
    "openai": [("gpt-4.1-mini", "GPT-4.1 mini, cheap"), ("gpt-4.1", "GPT-4.1")],
    "xai": [("grok-4-fast", "Grok 4 fast, cheap"), ("grok-4", "Grok 4")],
    "ollama": [("llama3.1", "Llama 3.1 on this computer, free")],
}


def _choice_path() -> Path:
    return keys_dir() / "choice.json"


def choice() -> dict:
    """The provider and model picked in Settings, else DeepSeek's default."""
    try:
        c = json.loads(_choice_path().read_text())
    except (OSError, ValueError):
        c = {}
    return {"provider": c.get("provider") or "deepseek", "model": c.get("model") or "",
            "custom": c.get("custom") or {"base_url": "", "model": ""}, "fallback": c.get("fallback", True)}


def set_choice(provider: str, model: str, custom: dict | None = None, fallback: bool | None = None) -> dict:
    ps = providers(apply_choice=False)
    if provider not in ps:
        raise ValueError("unknown provider")
    c = choice()
    if custom is not None:
        url = str(custom.get("base_url", "")).strip()
        if url and not url.startswith(("http://", "https://")):
            raise ValueError("The server address must start with http:// or https://")
        c["custom"] = {"base_url": url.rstrip("/"), "model": str(custom.get("model", "")).strip()[:120]}
    allowed = [m for m, _ in MODELS.get(provider, [])] + [ps[provider].get("model")]
    if provider == "custom":
        model = c["custom"]["model"]
    elif model and model not in allowed:
        raise ValueError("unknown model")
    out = {"provider": provider, "model": model if model or provider == "custom" else ps[provider].get("model"), "custom": c["custom"],
           "fallback": c["fallback"] if fallback is None else bool(fallback)}
    _write_private(_choice_path(), json.dumps(out))
    return choice()


def resolve(provider_id: str | None) -> str:
    """A request's provider, or the one picked in Settings when the request names none."""
    return provider_id or choice()["provider"]


def providers(apply_choice: bool = True) -> dict[str, dict]:
    """Built-in providers, overridden or extended by config.json (git-ignored), with the model picked in Settings."""
    out = {k: dict(v) for k, v in DEFAULT_PROVIDERS.items()}
    cfg = Path(os.environ.get("BOOK_READER_CONFIG", ROOT / "config.json"))
    if cfg.exists():
        for name, over in json.loads(cfg.read_text()).get("providers", {}).items():
            out.setdefault(name, {}).update(over)
    c = choice()
    if c["custom"].get("base_url"):
        out["custom"].update(base_url=c["custom"]["base_url"], model=c["custom"].get("model") or "default")
    if apply_choice and c["provider"] in out and c["provider"] != "custom" and (c["model"] or c["provider"] == "grok-cli"):
        out[c["provider"]]["model"] = c["model"]
    return out


def _write_private(path: Path, text: str):
    """Write a file only this user can read (0600), in a folder only this user can open (0700)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_suffix(".part")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _key_path(provider_id: str) -> Path:
    if not provider_id.isidentifier():
        raise ValueError("bad provider id")
    return keys_dir() / f"{provider_id}.key"


def save_key(provider_id: str, key: str):
    key = key.strip()
    if provider_id not in providers() or not key or len(key) > 400 or any(c.isspace() for c in key):
        raise ValueError("That does not look like an API key.")
    _write_private(_key_path(provider_id), key)
    _last.pop(provider_id, None)  # a new key starts with a clean slate


def remove_key(provider_id: str) -> bool:
    p = _key_path(provider_id)
    if p.is_file():
        p.unlink()
        _last.pop(provider_id, None)
        return True
    return False


def key_source(provider_id: str) -> str | None:
    p = providers().get(provider_id, {})
    if p.get("key_env") and os.environ.get(p["key_env"]):
        return "environment"
    if _key_path(provider_id).is_file():
        return "settings"
    if p.get("key_file") and Path(os.path.expanduser(p["key_file"])).is_file():
        return "file"
    return None


def configured(provider_id: str) -> bool:
    """Usable right now without asking anyone: a key, a signed-in CLI, a local server or a custom address."""
    p = providers().get(provider_id)
    if not p:
        return False
    if provider_id == "custom":
        return bool(p.get("base_url"))
    return status(provider_id)["state"] == "ready"


def status(provider_id: str) -> dict:
    """ready / signed-out / not-installed / no-key, plus rate-limited for a while after a plan limit. No model call."""
    p = dict(providers().get(provider_id) or {})
    adapter = ADAPTERS.get(p.get("kind"))
    if not adapter:
        return {"state": "unknown", "detail": "unknown kind"}
    p["_key"] = bool(api_key(p, provider_id)) if p.get("kind") in ("openai", "anthropic") else False
    st = dict(adapter.status(p))
    seen = _last.get(provider_id)
    if seen and seen["at"] > time.time() - 900 and seen["what"] == "rate-limited" and st["state"] == "ready":
        st.update(state="rate-limited", detail="hit its limit recently; others take over")
    elif seen and seen["what"] == "ok" and st["state"] == "ready" and p["_key"]:
        st["detail"] = "key works"
    elif seen and seen["what"] == "refused" and st["state"] == "ready" and p["_key"]:
        st.update(state="no-key", detail="the key was refused")
    return st


_last: dict[str, dict] = {}  # provider -> {"what": ok|rate-limited|refused, "at": time}


def _note(provider_id: str, what: str):
    _last[provider_id] = {"what": what, "at": time.time()}


def api_key(p: dict, provider_id: str | None = None) -> str | None:
    if p.get("key_env") and os.environ.get(p["key_env"]):
        return os.environ[p["key_env"]].strip()
    pid = provider_id or next((k for k, v in providers().items() if v.get("label") == p.get("label")), None)
    if pid and pid.isidentifier() and _key_path(pid).is_file():
        return _key_path(pid).read_text().strip() or None
    if p.get("key_file"):
        f = Path(os.path.expanduser(p["key_file"]))
        if f.is_file():
            return f.read_text().strip() or None
    return None


def public_view() -> list[dict]:
    """What the browser may see: names, models, status, whether a key is set and its last four characters. Never the key."""
    out = []
    for k, v in providers().items():
        cli = v.get("kind", "").endswith("-cli")
        key = None if cli else api_key(v, k)
        st = status(k) if k != "custom" or v.get("base_url") else {"state": "no-key", "detail": "no server address"}
        out.append({"id": k, "label": v.get("label", k), "model": v.get("model"), "kind": v.get("kind"),
                    "available": st["state"] == "ready", "status": st, "cli": cli,
                    "base_url": v.get("base_url") if k == "custom" else None, "local": bool(v.get("local")),
                    "models": [{"id": m, "label": t} for m, t in MODELS.get(k, [])],
                    "key": None if cli else {"set": bool(key), "hint": ("…" + key[-4:]) if key and len(key) > 12 else None,
                                             "source": key_source(k)}})
    return out


def settings_view() -> dict:
    return {**choice(), "providers": public_view()}


def stream(provider_id: str | None, system: str, user: str, max_tokens: int = 8000) -> Iterator[str]:
    return stream_chat(provider_id, system, [{"role": "user", "content": user}], max_tokens)


def stream_chat(provider_id: str | None, system: str, messages: list[dict], max_tokens: int = 8000,
                temperature: float = 0.3) -> Iterator[str]:
    """Multi-turn: messages are {"role": "user"|"assistant", "content": str}, oldest first.
    When no provider is named, the one picked in Settings answers; if it has no key, is signed out or is rate limited
    before saying anything, the next configured provider takes over (unless fallback is turned off)."""
    first = resolve(provider_id)
    chain = [first]
    if provider_id is None and choice()["fallback"]:
        chain += [x for x in FALLBACK_ORDER if x != first and configured(x)]
    errors = []
    for pid in chain:
        said = False
        try:
            for piece in _stream_one(pid, system, messages, max_tokens, temperature):
                said = True
                yield piece
            _note(pid, "ok")
            return
        except (NoKey, RateLimited) as e:
            had_key = bool(api_key(providers().get(pid, {}), pid))
            _note(pid, "rate-limited" if isinstance(e, RateLimited) else "refused" if had_key else "missing")
            if said:
                raise
            errors.append(e)
    raise errors[0] if len(errors) == 1 else type(errors[0])(str(errors[0]) + " No other provider could take over.")


def _stream_one(provider_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float) -> Iterator[str]:
    p = providers().get(provider_id)
    if not p:
        raise LLMError(f"Unknown provider {provider_id!r}")
    adapter = ADAPTERS.get(p.get("kind"))
    if not adapter:
        raise LLMError(f"{provider_id} has an unknown kind {p.get('kind')!r}")
    key = None
    if p["kind"] in ("openai", "anthropic"):
        if provider_id == "custom" and not p.get("base_url"):
            raise NoKey("No server address is set for the OpenAI-compatible provider. Add one in Settings.")
        key = api_key(p, provider_id)
        if not key and not p.get("local") and not p.get("optional_key"):
            raise NoKey(f"No {p.get('label', provider_id)} key is set, so new cards and answers are paused. "
                        "Reading, listening, the graph and saved cards still work. Add a key in Settings.")
    yield from adapter.stream(p, key, system, messages, max_tokens, temperature)


def check(provider_id: str) -> dict:
    """One tiny request to see whether the key works. Costs a few tokens."""
    try:
        got = "".join(stream_chat(provider_id, "Reply with the word ok.", [{"role": "user", "content": "ok?"}], max_tokens=5))
        return {"ok": True, "reply": got[:20]}
    except LLMError as e:
        return {"ok": False, "error": str(e)}


def model_name(provider_id: str) -> str:
    provider_id = resolve(provider_id)
    p = providers().get(provider_id, {})
    return f"{provider_id}/{p.get('model', '?')}"
