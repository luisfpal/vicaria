"""Narration. Voices come from the local narrator (voice.py: Kokoro, 82M parameters, on CPU, free), found at
COMMONPLACE_VOICE_URL, else "voice_url" in config.json, else http://127.0.0.1:8785. When it is not running, the
voice list is empty and the reader falls back to the device's own voice. Audio is cached on disk per voice and text."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_cache: dict = {"at": 0.0, "voices": []}


def voice_url() -> str:
    if os.environ.get("COMMONPLACE_VOICE_URL"):
        return os.environ["COMMONPLACE_VOICE_URL"].rstrip("/")
    cfg = Path(os.environ.get("BOOK_READER_CONFIG", ROOT / "config.json"))
    if cfg.is_file():
        url = json.loads(cfg.read_text()).get("voice_url")
        if url:
            return url.rstrip("/")
    return "http://127.0.0.1:8785"


def voices() -> list[dict]:
    """The narrator's voices, or [] when it is not reachable. Remembered for 30 s so pages stay fast."""
    if time.time() - _cache["at"] < 30:
        return _cache["voices"]
    try:
        with urllib.request.urlopen(voice_url() + "/voices", timeout=2) as r:
            out = json.loads(r.read())
    except (OSError, ValueError):
        out = []
    _cache.update(at=time.time(), voices=out)
    return out


def speak(voice: str, text: str) -> tuple[bytes, str]:
    req = urllib.request.Request(voice_url() + "/speak", method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"voice": voice, "text": text}).encode())
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read(), r.headers.get("Content-Type", "audio/mpeg")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"narrator error {e.code}") from None
    except OSError as e:
        raise RuntimeError(f"narrator not reachable: {e}") from None


def mime(audio: bytes) -> str:
    return "audio/wav" if audio[:4] == b"RIFF" else "audio/mpeg"
