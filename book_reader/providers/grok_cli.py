"""Grok through the user's own SuperGrok / X subscription: xAI's official `grok` CLI in single-turn mode.

Signed in once on the server with `grok login --device-auth`. Tools, memory, plans and web search are turned off.
"""
from __future__ import annotations

import subprocess
import time
from typing import Iterator

from .base import NoKey, RateLimited, classify, find, flatten, run

KIND = "grok-cli"
SIGN_IN = "Sign in once on the server with: grok login --device-auth"
_cache: dict = {"at": 0.0, "st": None}
MAX_ARG = 120_000  # the prompt is an argument; Linux caps one argument near 128 KB


def status(p: dict) -> dict:
    if time.time() - _cache["at"] < 60 and _cache["st"]:
        return _cache["st"]
    b = find(p.get("command", "grok"))
    st = {"state": "not-installed", "detail": "the Grok CLI is not installed on the server"}
    if b:
        try:
            r = subprocess.run([b, "models"], capture_output=True, text=True, timeout=20)  # lists models, no model call
            out = (r.stdout + r.stderr).lower()
            st = {"state": "signed-out", "detail": "not signed in"} if "not authenticated" in out or r.returncode != 0 \
                else {"state": "ready", "detail": "signed in"}
        except (OSError, subprocess.TimeoutExpired):
            st = {"state": "signed-out", "detail": "could not read sign-in status"}
    _cache.update(at=time.time(), st=st)
    return st


def stream(p: dict, key, system: str, messages: list[dict], max_tokens: int, temperature: float) -> Iterator[str]:
    b = find(p.get("command", "grok"))
    if not b:
        raise NoKey("The Grok CLI is not installed on the server, so Grok is not available. Saved cards still work.")
    prompt = messages[-1]["content"] if len(messages) == 1 else flatten("", messages)
    if len(prompt.encode()) > MAX_ARG:
        raise RateLimited("This request is too long for the Grok CLI; another provider can take it.")
    argv = [b, "-p", prompt, "--output-format", "plain", "--tools", "", "--system-prompt-override", system,
            "--no-memory", "--no-subagents", "--no-plan", "--disable-web-search", "--max-turns", "1"]
    if p.get("model"):
        argv += ["-m", p["model"]]
    r, _ = run(argv, "")
    text = r.stdout.strip()
    low = (r.stdout + r.stderr).lower()
    if r.returncode != 0 or not text or "not authenticated" in low or "grok login" in low:  # it can exit 0 when signed out
        _cache["at"] = 0
        raise classify("Grok (your subscription)", (r.stderr + r.stdout)[-600:] or "no answer", SIGN_IN)
    yield text
