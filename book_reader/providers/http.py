"""Server-sent events over plain urllib, with HTTP errors turned into the app's errors. Never logs the key."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Iterator

from .base import LLMError, NoKey, RateLimited


def key_status(p: dict) -> dict:
    if p.get("_key") or p.get("local") or p.get("optional_key"):
        return {"state": "ready", "detail": "key set" if p.get("_key") else "no key needed"}
    return {"state": "no-key", "detail": "no key"}


def sse(p: dict, url: str, body: dict, headers: dict) -> Iterator[dict]:
    label = p.get("label", "The provider")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        if e.code in (401, 403):
            raise NoKey(f"{label} refused the key (revoked or wrong), so new cards and answers are paused. "
                        "Reading, listening, the graph and saved cards still work. Update the key in Settings.") from None
        if e.code == 429:
            raise RateLimited(f"{label} is rate limiting requests right now.") from None
        if e.code == 402:
            raise NoKey(f"{label} says the account is out of credit. Saved cards still work.") from None
        raise LLMError(f"{label} returned HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise LLMError(f"Could not reach {label}: {e.reason}") from None
    with resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                yield json.loads(data)
            except json.JSONDecodeError:
                continue
