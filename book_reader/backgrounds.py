"""Background pictures for the reading theme, kept by content (library/.backgrounds/<sha>.<ext>).

The picture's id, blur and dim are reader settings (they sync with the theme); the picture itself travels to a paired
copy inside the sync export, but only the one in use, so a library never ships a gallery on every sync."""
from __future__ import annotations

import base64
import hashlib
import re

from . import library

TYPES = {b"\xff\xd8\xff": ("jpg", "image/jpeg"), b"\x89PNG": ("png", "image/png"), b"RIFF": ("webp", "image/webp")}
MAX = 6 * 1024 * 1024
ID = re.compile(r"^[0-9a-f]{16}$")


def _dir():
    return library.LIB / ".backgrounds"


def kind(data: bytes):
    for magic, k in TYPES.items():
        if data.startswith(magic) and (magic != b"RIFF" or data[8:12] == b"WEBP"):
            return k
    return None


def save(data: bytes) -> str:
    k = kind(data)
    if not k:
        raise ValueError("Use a JPEG, PNG or WebP picture.")
    if len(data) > MAX:
        raise ValueError("That picture is over 6 MB.")
    bid = hashlib.sha256(data).hexdigest()[:16]
    _dir().mkdir(parents=True, exist_ok=True)
    p = _dir() / f"{bid}.{k[0]}"
    if not p.exists():
        p.write_bytes(data)
    return bid


def find(bid: str):
    """(path, mime) of a stored picture, or None."""
    if not ID.match(bid or ""):
        return None
    for ext, mime in TYPES.values():
        p = _dir() / f"{bid}.{ext}"
        if p.is_file():
            return p, mime
    return None


def export(bid: str | None) -> list[dict]:
    f = find(bid) if bid else None
    return [{"id": bid, "data": base64.b64encode(f[0].read_bytes()).decode()}] if f else []


def import_(items) -> int:
    n = 0
    for it in items or []:
        try:
            data = base64.b64decode(it["data"])
            if find(it["id"]) is None and hashlib.sha256(data).hexdigest()[:16] == it["id"]:
                save(data)
                n += 1
        except (KeyError, ValueError, TypeError):
            continue  # a damaged picture is skipped; the theme falls back to the plain page
    return n
