"""Claude through the user's own Claude subscription: the official, unmodified `claude` binary in print mode.

Signed in once on the server by its owner. This code never reads or copies its credentials; it only runs the binary.
"""
from __future__ import annotations

import json
import subprocess
import time
from typing import Iterator

from .base import LLMError, NoKey, classify, find, flatten, run

KIND = "claude-cli"
SIGN_IN = "Sign in once on the server with: claude, then /login."
_cache: dict = {"at": 0.0, "st": None}


def status(p: dict) -> dict:
    if time.time() - _cache["at"] < 60 and _cache["st"]:
        return _cache["st"]
    b = find(p.get("command", "claude"))
    st = {"state": "not-installed", "detail": "Claude Code is not installed on the server"}
    if b:
        try:
            r = subprocess.run([b, "auth", "status"], capture_output=True, text=True, timeout=15)  # no model call
            j = json.loads(r.stdout or "{}")
            st = {"state": "ready", "detail": f"signed in ({j.get('authMethod') or 'subscription'})"} if j.get("loggedIn") \
                else {"state": "signed-out", "detail": "not signed in"}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            st = {"state": "signed-out", "detail": "could not read sign-in status"}
    _cache.update(at=time.time(), st=st)
    return st


def stream(p: dict, key, system: str, messages: list[dict], max_tokens: int, temperature: float) -> Iterator[str]:
    b = find(p.get("command", "claude"))
    if not b:
        raise NoKey("Claude Code is not installed on the server, so Claude is not available. Saved cards still work.")
    prompt = messages[-1]["content"] if len(messages) == 1 else flatten("", messages)
    argv = [b, "-p", "--model", p.get("model") or "haiku", "--output-format", "json", "--tools", "",
            "--strict-mcp-config", "--no-session-persistence", "--system-prompt", system]
    r, _ = run(argv, prompt)
    try:
        j = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
    except ValueError:
        j = {}
    text = str(j.get("result", "")) if isinstance(j, dict) else ""
    if r.returncode != 0 or (isinstance(j, dict) and j.get("is_error")) or not text:
        _cache["at"] = 0
        raise classify("Claude (your subscription)", text or r.stderr or r.stdout or "no answer", SIGN_IN)
    yield text
