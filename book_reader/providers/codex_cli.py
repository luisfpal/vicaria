"""ChatGPT models through the user's own ChatGPT plan: the official `codex exec`, signed in with `codex login`.

Runs read-only in an empty folder, keeps no session, ignores the user's Codex config (so a stale model pin cannot break it).
"""
from __future__ import annotations

import subprocess
import time
from typing import Iterator

from .base import NoKey, classify, find, flatten, run

KIND = "codex-cli"
SIGN_IN = "Sign in once on the server with: codex login --device-auth"
_cache: dict = {"at": 0.0, "st": None}


def status(p: dict) -> dict:
    if time.time() - _cache["at"] < 60 and _cache["st"]:
        return _cache["st"]
    b = find(p.get("command", "codex"))
    st = {"state": "not-installed", "detail": "Codex is not installed on the server"}
    if b:
        try:
            r = subprocess.run([b, "login", "status"], capture_output=True, text=True, timeout=15)  # no model call
            out = (r.stdout + r.stderr).strip()
            st = {"state": "ready", "detail": out.splitlines()[0][:80]} if r.returncode == 0 and "not logged" not in out.lower() \
                else {"state": "signed-out", "detail": "not signed in"}
        except (OSError, subprocess.TimeoutExpired):
            st = {"state": "signed-out", "detail": "could not read sign-in status"}
    _cache.update(at=time.time(), st=st)
    return st


def stream(p: dict, key, system: str, messages: list[dict], max_tokens: int, temperature: float) -> Iterator[str]:
    b = find(p.get("command", "codex"))
    if not b:
        raise NoKey("Codex is not installed on the server, so ChatGPT is not available. Saved cards still work.")
    if status(p)["state"] != "ready":  # without a login codex retries for a while; fail fast instead
        raise classify("ChatGPT (your plan, through Codex)", "not logged in", SIGN_IN)
    argv = [b, "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
            "--sandbox", "read-only", "--color", "never", "-o", "answer.txt"]
    if p.get("model"):
        argv += ["-m", p["model"]]
    r, files = run(argv + ["-"], flatten(system + "\n\nAnswer directly. Do not run commands or open files.", messages),
                   files={"answer.txt": ""})
    text = files.get("answer.txt", "").strip()
    if r.returncode != 0 or not text:
        _cache["at"] = 0
        raise classify("ChatGPT (your plan, through Codex)", (r.stderr or r.stdout or "no answer")[-600:], SIGN_IN)
    yield text
