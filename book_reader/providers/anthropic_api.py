"""Claude through an Anthropic API key."""
from __future__ import annotations

from typing import Iterator

from . import http
from .base import LLMError

KIND = "anthropic"


def status(p: dict) -> dict:
    return http.key_status(p)


def stream(p: dict, key: str | None, system: str, messages: list[dict], max_tokens: int, temperature: float) -> Iterator[str]:
    body = {"model": p["model"], "max_tokens": max_tokens, "system": system, "stream": True, "messages": messages}
    for ev in http.sse(p, p["base_url"].rstrip("/") + "/v1/messages", body, {"x-api-key": key or "", "anthropic-version": "2023-06-01"}):
        if ev.get("type") == "content_block_delta":
            yield ev["delta"].get("text", "")
        elif ev.get("type") == "error":
            raise LLMError(str(ev.get("error")))
