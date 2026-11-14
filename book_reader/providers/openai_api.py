"""Any OpenAI-compatible chat API: DeepSeek, OpenAI, xAI, OpenRouter, Ollama, llama.cpp, vLLM."""
from __future__ import annotations

import json
from typing import Iterator

from . import http

KIND = "openai"


def status(p: dict) -> dict:
    return http.key_status(p)


def stream(p: dict, key: str | None, system: str, messages: list[dict], max_tokens: int, temperature: float) -> Iterator[str]:
    body = {"model": p["model"], "stream": True, "max_tokens": max_tokens, "temperature": temperature,
            "messages": [{"role": "system", "content": system}, *messages]}
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    for ev in http.sse(p, p["base_url"].rstrip("/") + "/chat/completions", body, headers):
        for ch in ev.get("choices", []):
            piece = (ch.get("delta") or {}).get("content")
            if piece:
                yield piece
