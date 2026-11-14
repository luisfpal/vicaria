"""Build the standalone Commonplace app: static files only, no server code runs at the host.

    python3 standalone/build.py            # writes standalone/dist/

dist/ holds the app shell (index.html, app.js, css, fonts, icons), the service worker, the on-device server
(worker.js + app.zip with the book_reader package) and Pyodide. Any static host can serve it; nothing in it is
personal: no books, no keys, no library.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import re
import shutil
import tarfile
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DIST = HERE / "dist"
STATIC = REPO / "book_reader" / "static"
PYODIDE = "314.0.8"
PYODIDE_SHA512 = "74Wq1kXOC+CCEzAfxuRAO701nAcCMLjf8NrwvWpu8S41dVMXwXmLQ05dYB+F4e46AdnGo0oq7YHSVUpHsoarLQ=="
PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]
CACHE = Path.home() / ".cache" / "commonplace" / f"pyodide-{PYODIDE}"
GZIP = {".js", ".mjs", ".wasm", ".css", ".html", ".json", ".webmanifest", ".md"}


def pyodide() -> Path:
    """Pyodide from the npm registry, checked against its published sha512, kept in ~/.cache."""
    if all((CACHE / f).exists() for f in PYODIDE_FILES):
        return CACHE
    data = urllib.request.urlopen(f"https://registry.npmjs.org/pyodide/-/pyodide-{PYODIDE}.tgz", timeout=120).read()
    if base64.b64encode(hashlib.sha512(data).digest()).decode() != PYODIDE_SHA512:
        raise SystemExit("pyodide download does not match its published checksum")
    CACHE.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        for f in PYODIDE_FILES:
            (CACHE / f).write_bytes(tf.extractfile(f"package/{f}").read())
    return CACHE


def app_zip() -> bytes:
    """The Python the on-device server runs: book_reader (without its static files), the card skills, the bridge."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted((REPO / "book_reader").rglob("*.py")):
            if "static" not in p.parts and "__pycache__" not in p.parts and not p.name.startswith("._"):
                z.write(p, p.relative_to(REPO).as_posix())
        for p in sorted((REPO / "skills").glob("[!._]*.md")):
            z.write(p, p.relative_to(REPO).as_posix())
        z.write(HERE / "cp_bridge.py", "cp_bridge.py")
    return buf.getvalue()


NAME = "Vicaria"


# Ids that devices paired, and sync files saved, before the Excerpta -> Vicaria rename depend on. Renaming any of
# them would split a user's devices into two rooms, so the build refuses to drop them.
COMPAT_IDS = ('"excerpta-room"', '"excerpta-tag"', '"excerpta-nostr"', 'appId: "excerpta-v1"', '"EXCERPTA-SYNC-1\\n"', "(EXCERPTA|VICARIA)-SYNC-1")


def main():
    sync_js = (HERE / "web" / "sync.js").read_text()
    missing = [i for i in COMPAT_IDS if i not in sync_js]
    if missing:
        raise SystemExit(f"sync.js lost ids that paired devices rely on: {missing}")
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="", help="path the app is served under, e.g. /vicaria for GitHub Pages")
    base = ap.parse_args().base.rstrip("/")
    if base and not re.fullmatch(r"/[\w.-]+(/[\w.-]+)*", base):
        raise SystemExit("bad --base")
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(STATIC, DIST / "static", ignore=shutil.ignore_patterns("sw.js", "index.html", "manifest.webmanifest", "._*", ".DS_Store"))
    man = json.loads((STATIC / "manifest.webmanifest").read_text())
    man.update(name=NAME, short_name=NAME, id=base + "/", start_url=base + "/", scope=base + "/")
    for x in man.get("icons", []) + man.get("shortcuts", []):
        for k in ("src", "url"):
            if k in x:
                x[k] = base + x[k]
    (DIST / "manifest.webmanifest").write_text(json.dumps(man, indent=1))
    html = (STATIC / "index.html").read_text()
    if '<script src="/static/app.js"></script>' not in html:
        raise SystemExit("index.html changed: cannot find the app.js script tag")
    html = html.replace('<script src="/static/app.js"></script>',
                        f'<script>window.EXC_BASE = "{base}";</script><script src="/static/x/p2p.js"></script><script src="/standalone.js"></script>')
    html = re.sub(r'(href|src)="/(?!/)', rf'\1="{base}/', html).replace("Commonplace", NAME)
    (DIST / "index.html").write_text(html)
    (DIST / "404.html").write_text(html)  # GitHub Pages answers unknown paths (the app's own routes) with this
    app = (STATIC / "app.js").read_text()
    if "location.pathname" not in app:
        raise SystemExit("app.js changed: no location.pathname to rewrite")
    app = app.replace("location.pathname", "xPath()").replace("Commonplace", NAME)
    app = app.replace('navigator.serviceWorker.register("/sw.js")', 'navigator.serviceWorker.register(window.EXC_BASE + "/sw.js", { scope: window.EXC_BASE + "/" })')
    (DIST / "static" / "app.js").write_text(app)
    (DIST / "static" / "x").mkdir()
    for f in ("sync.js", "panels.js", "ai.js"):
        shutil.copy(HERE / "web" / f, DIST / "static" / "x" / f)
    for f in ("p2p.js", "p2p.LICENSE"):
        shutil.copy(HERE / "web" / "vendor" / f, DIST / "static" / "x" / f)
    for f in ("standalone.js", "worker.js"):
        shutil.copy(HERE / "web" / f, DIST / f)
    (DIST / "app.zip").write_bytes(app_zip())
    (DIST / "pyodide").mkdir()
    src = pyodide()
    for f in PYODIDE_FILES:
        shutil.copy(src / f, DIST / "pyodide" / f)
    files = sorted("/" + p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file() and p.name != "404.html")
    files = [f for f in files if f != "/index.html"] + ["/index.html"]
    digest = hashlib.sha256()
    for f in files:
        digest.update(f.encode() + (DIST / f.lstrip("/")).read_bytes())
    version = digest.hexdigest()[:12]
    sw = (HERE / "web" / "sw.js").read_text().replace("__VERSION__", version).replace("__BASE__", base)
    sw = sw.replace("__FILES__", json.dumps([base + f for f in files]))
    (DIST / "sw.js").write_text(sw)
    (DIST / "version.txt").write_text(version + "\n")
    for p in list(DIST.rglob("*")):
        if p.is_file() and p.suffix in GZIP and p.stat().st_size > 1024:
            p.with_name(p.name + ".gz").write_bytes(gzip.compress(p.read_bytes(), 9, mtime=0))
    size = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file() and not p.name.endswith(".gz"))
    print(f"dist/ version {version}: {len(files)} files, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
