"""0.x side of the old-and-new sync test: runs the real book_reader.sync on a temporary library.
Usage: zero.py <lib dir> export | import  (import reads a snapshot's data on stdin, then prints export)."""
import json, os, sys
os.environ["BOOK_READER_LIBRARY"] = sys.argv[1]
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "standalone"))
from book_reader import library, sync  # noqa: E402
import cp_bridge  # noqa: E402  the browser app's sync endpoints (/api/x/sync/export and import)
from pathlib import Path  # noqa: E402
cp_bridge._PENDING = Path(sys.argv[1]) / ".pending"  # ops for books this copy lacks (in the browser: /data/pending)

cmd = sys.argv[2]
if cmd == "setup":
    library.LIB.mkdir(parents=True, exist_ok=True)
    (library.LIB / "library.json").write_text(json.dumps({"id": sys.argv[4] if len(sys.argv) > 4 else "cp-0123456789abcdef", "format": 2}))
    bid = library.import_epub(open(sys.argv[3], "rb").read(), "meditations.epub")
    sync.add(bid, [
        {"id": "dev-old1.1700000000000000001", "dev": "dev-old1", "t": 1700000000001, "k": "pos", "v": {"chapter": 3, "block": 7, "percent": 12, "quote": "Of my grandfather Verus"}},
        {"id": "dev-old1.1700000000000000002", "dev": "dev-old1", "t": 1700000000002, "k": "hl", "v": {"id": "h1", "chapter": 3, "block": 7, "start": 0, "end": 22, "quote": "Of my grandfather Verus", "color": "yellow", "note": "ñandú “quoted”", "created": 1700000000002}},
    ])
    sync.add(None, [{"id": "dev-old1.1700000000000000003", "dev": "dev-old1", "t": 1700000000003, "k": "reader", "v": {"theme": "sepia", "size": 19}}])
    print(json.dumps({"book": bid}))
elif cmd == "export":
    print(json.dumps(cp_bridge.sync_export(), ensure_ascii=False))
elif cmd == "import":
    data = json.load(sys.stdin)
    r = cp_bridge.sync_import(data)
    print(json.dumps({"result": r, "export": cp_bridge.sync_export()}, ensure_ascii=False))
