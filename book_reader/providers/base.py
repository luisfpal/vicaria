"""What every provider adapter shares: the errors the app understands and a safe way to run an official CLI.

An adapter is one module with:
  KIND                                   the "kind" used in llm.DEFAULT_PROVIDERS
  status(p) -> dict                      {"state": "ready" | "signed-out" | "not-installed" | "no-key", "detail": str}
                                         cheap: never calls a model
  stream(p, key, system, messages, max_tokens, temperature) -> Iterator[str]
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


class LLMError(RuntimeError):
    pass


class NoKey(LLMError):
    """No key, signed out, or the provider refused the key (revoked, wrong, out of credit). The UI points to Settings."""


class RateLimited(LLMError):
    """Out of capacity for now (plan limit, 429, overloaded). The next configured provider can take over."""


def find(cmd: str) -> str | None:
    """An official CLI on PATH or in the usual per-user install folders."""
    home = Path.home()
    for c in [shutil.which(cmd), home / ".local/bin" / cmd, home / ".npm-global/bin" / cmd, Path("/usr/local/bin") / cmd]:
        if c and Path(c).is_file():
            return str(c)
    return None


def flatten(system: str, messages: list[dict]) -> str:
    """CLIs take one prompt: the instructions, then the conversation."""
    if len(messages) == 1:
        return f"{system}\n\n{messages[0]['content']}" if system else messages[0]["content"]
    convo = "\n\n".join(f"{'Reader' if m['role'] == 'user' else 'You'}: {m['content']}" for m in messages)
    return f"{system}\n\n{convo}\n\nYou:"


def run(argv: list[str], stdin: str, timeout: int = 300, files: dict[str, str] | None = None):
    """Run a CLI in an empty temporary folder (no project files to read or edit). Returns (process, files written there)."""
    extra = os.path.dirname(argv[0])
    env = {**os.environ, "PATH": f"{extra}:{os.environ.get('PATH', '/usr/bin:/bin')}", "NO_COLOR": "1", "CI": "1"}
    with tempfile.TemporaryDirectory(prefix="commonplace-llm-") as cwd:
        try:
            r = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env)
        except subprocess.TimeoutExpired:
            raise LLMError("The model took too long to answer.") from None
        out = {name: (Path(cwd) / name).read_text() for name in (files or {}) if (Path(cwd) / name).is_file()}
    return r, out


SIGNED_OUT = ("not logged", "log in", "login", "sign in", "signed out", "not authenticated", "unauthorized", "401",
              "authenticat", "oauth", "credentials")
LIMITED = ("rate limit", "rate_limit", "usage limit", "limit reached", "quota", "429", "overloaded", "at capacity",
           "too many requests", "resource_exhausted", "try again later")


def classify(label: str, text: str, how_to_sign_in: str) -> LLMError:
    low = text.lower()
    if any(w in low for w in LIMITED):
        return RateLimited(f"{label} has hit its usage limit for now.")
    if any(w in low for w in SIGNED_OUT):
        return NoKey(f"{label} is not signed in on the server, so it is not available. Reading, listening, the graph "
                     f"and saved cards still work. {how_to_sign_in}")
    return LLMError(f"{label} failed: {text.strip()[:300]}")
