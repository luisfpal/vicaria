"""EPUB to ordered chapters, using only the standard library.

Chapters come from the book's own table of contents (EPUB3 nav, else NCX),
split at the anchors the TOC points to. Spine files are not chapters.
"""
from __future__ import annotations

import hashlib
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import unquote
from xml.etree import ElementTree as ET

BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "pre",
              "section", "article", "td", "th", "dt", "dd", "figcaption", "tr", "table", "ul", "ol"}
SKIP_TAGS = {"script", "style", "head", "title", "svg", "math"}
KEEP_TYPES = {"h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "pre", "figcaption"}
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg")
CONTENTS = re.compile(r"^\s*(table of )?contents\b", re.I)
MATTER_TITLE = re.compile(
    r"^\s*(contents|table of contents|copyright|cover|title page|index|dedication|"
    r"also by|about the (author|publisher)|acknowledg|colophon|preface|prefatory|foreword|notes?|endnotes|"
    r"bibliography|references|glossary|further reading|title|note to the reader|lecture on platinum\. notes|(subject|name|general|author) index)\b|gutenberg|license",
    re.I)
# EPUB 3 structural semantics (epub:type, also used by Standard Ebooks) that name pages which are not the book's text.
MATTER_TYPES = {"titlepage", "halftitlepage", "imprint", "colophon", "copyright-page", "toc", "loi", "lot", "index",
                "endnotes", "footnotes", "rearnotes", "bibliography", "acknowledgments", "contributors", "other-credits",
                "errata", "landmarks", "cover", "seriespage", "dedication", "glossary", "credits"}
_SEM = re.compile(r'<(?:body|section|article|div)\b[^>]*\bepub:type="([^"]*)"', re.I)
MIN_WORDS = 250  # a section with sub-sections and fewer words is a part (a heading over chapters), not a chapter
MIN_LEAF_WORDS = 40  # a section without sub-sections is a chapter unless it is almost empty (a title page)


@dataclass
class Chapter:
    index: int
    title: str
    depth: int
    blocks: list[dict]
    kind: str = "chapter"  # "chapter", "part" (a heading over chapters, too short for a card) or "matter"
    parent: int | None = None  # index of the enclosing chapter or part, from the book's own nested contents
    trail: list[str] = field(default_factory=list)  # titles of every enclosing contents entry, outermost first
    heads: list[str] = field(default_factory=list)  # contents labels with no text of their own just before it ("PART ONE")

    @property
    def text(self) -> str:  # images carry no text; the digest of a chapter is the same with or without them
        return "\n\n".join(b["text"] for b in self.blocks if b["type"] != "img")

    @property
    def words(self) -> int:
        return len(self.text.split())

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()[:16]


@dataclass
class Book:
    title: str
    authors: list[str]
    chapters: list[Chapter] = field(default_factory=list)
    language: str = ""
    cover: str = ""  # path of the cover image inside the EPUB, if it names one
    images: frozenset = frozenset()  # every image path inside the EPUB, the only files the server will hand out
    body_words: int = 0  # words in the book's text (Project Gutenberg's wrapper left out), to check nothing was dropped
    toc: str = ""  # where the chapters came from: "nav", "ncx", "files" (one per file) or "ai" (an AI repair)
    repairs: list = field(default_factory=list)  # what the repair rules changed, in words


class _Blocks(HTMLParser):
    """Flatten one XHTML document into text blocks and record where ids fall."""

    def __init__(self, doc: str = "", images=frozenset()):
        super().__init__(convert_charrefs=True)
        self.doc, self.images, self.pending, self.svg = doc, images, [], 0
        self.blocks: list[dict] = []
        self.anchors: dict[str, int] = {}
        self.stack: list[str] = []
        self.buf: list[str] = []
        self.skip = 0

    def _kind(self) -> str:
        for tag in reversed(self.stack):
            if tag in KEEP_TYPES:
                return tag
        return "p"

    def flush(self):
        text = "".join(self.buf)
        text = re.sub(r"[ \t\r\f\v]*\n[ \t\r\f\v]*", "\n", re.sub(r"[ \t\r\f\v]+", " ", text)).strip()
        text = re.sub(r"\n{2,}", "\n", text)
        self.buf = []
        if text:
            self.blocks.append({"type": self._kind(), "text": text})
        # images wait for the text around them, so a picture inside a paragraph never splits its text
        self.blocks.extend(self.pending)
        self.pending = []

    def _image(self, attrs):
        a = dict(attrs)
        src = a.get("src") or a.get("href") or a.get("xlink:href") or ""
        if not src or src.startswith(("data:", "http:", "https:")):
            return
        path = _resolve(self.doc, src).split("#")[0]
        if path not in self.images:
            return
        alt = (a.get("alt") or "").strip()
        if re.search(r"[\\/]|\.(jpe?g|png|gif|svg|webp|tiff?)$", alt, re.I) or len(alt) > 300:
            alt = ""  # file names and paths are not descriptions
        blk = {"type": "img", "text": "", "src": path, "alt": alt}
        for k in ("width", "height"):
            if str(a.get(k, "")).isdigit():
                blk[k] = int(a[k])
        self.pending.append(blk)

    def handle_starttag(self, tag, attrs):
        if tag == "svg":
            self.svg += 1
        if tag in ("img", "image") and (not self.skip or self.skip == self.svg):
            self._image(attrs)
        if tag in SKIP_TAGS:
            self.skip += 1
            return
        if self.skip:
            return
        if tag in BLOCK_TAGS:
            self.flush()
        if tag == "br":
            self.buf.append("\n")
        for k, v in attrs:
            if k in ("id", "name") and v and v not in self.anchors:
                # An id points at the next block that will be emitted.
                self.anchors[v] = len(self.blocks) + (1 if "".join(self.buf).strip() else 0)
        if tag not in ("br", "img", "hr", "meta", "link"):
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "svg":
            self.svg = max(0, self.svg - 1)
        if tag in SKIP_TAGS:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in BLOCK_TAGS:
            self.flush()
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data.replace("\n", " "))

    def close(self):
        super().close()
        self.flush()


# Gutenberg's EPUB3 build swaps drop-cap pictures for their file name: "block-d EAR SON".
_DROPCAP = re.compile(r'<span[^>]*\bid="img_[^"]*"[^>]*>\s*(?:block|cap|drop|dropcap|initial)-([a-z])\s*</span>\s*', re.I)


def _ns(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _find_all(root, name):
    return [e for e in root.iter() if _ns(e.tag) == name]


def _toc_from_nav(zf, path) -> list[tuple[str, str, int]]:
    root = ET.fromstring(zf.read(path))
    navs = [n for n in _find_all(root, "nav")
            if any(v == "toc" or v.endswith(" toc") or v.startswith("toc ") for k, v in n.attrib.items() if k.endswith("type"))]
    if not navs:
        navs = _find_all(root, "nav")[:1]
    if not navs:
        return []
    out = []

    def walk(ol, depth):
        for li in [c for c in ol if _ns(c.tag) == "li"]:
            a = next((c for c in li.iter() if _ns(c.tag) in ("a", "span")), None)
            if a is not None and a.get("href"):
                out.append(("".join(a.itertext()).strip(), _resolve(path, a.get("href")), depth))
            for sub in [c for c in li if _ns(c.tag) == "ol"]:
                walk(sub, depth + 1)

    for ol in [c for c in navs[0] if _ns(c.tag) == "ol"]:
        walk(ol, 0)
    return out


def _toc_from_ncx(zf, path) -> list[tuple[str, str, int]]:
    root = ET.fromstring(zf.read(path))
    out = []

    def walk(node, depth):
        for np in [c for c in node if _ns(c.tag) == "navPoint"]:
            label = next((t for t in np.iter() if _ns(t.tag) == "text"), None)
            content = next((c for c in np if _ns(c.tag) == "content"), None)
            if content is not None and content.get("src"):
                title = (label.text or "").strip() if label is not None else ""
                out.append((title, _resolve(path, content.get("src")), depth))
            walk(np, depth + 1)

    nm = next(iter(_find_all(root, "navMap")), None)
    if nm is not None:
        walk(nm, 0)
    return out


def _resolve(base_file: str, href: str) -> str:
    href = unquote(href)
    target, _, frag = href.partition("#")
    full = posixpath.normpath(posixpath.join(posixpath.dirname(base_file), target)) if target else base_file
    return full + ("#" + frag if frag else "")


def _image_size(h: bytes):
    """(width, height) from the first bytes of a PNG, GIF or JPEG, else None."""
    import struct
    if h[:8] == b"\x89PNG\r\n\x1a\n" and len(h) >= 24:
        return struct.unpack(">II", h[16:24])
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return struct.unpack("<HH", h[6:10])
    if h[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(h):
            if h[i] != 0xFF:
                i += 1
                continue
            m, n = h[i + 1], struct.unpack(">H", h[i + 2:i + 4])[0]
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                hh, ww = struct.unpack(">HH", h[i + 5:i + 9])
                return (ww, hh) if ww and hh else None
            i += 2 + n
    return None


def parse(path: str, repair: bool = True) -> Book:
    with zipfile.ZipFile(path) as zf:
        container = ET.fromstring(zf.read("META-INF/container.xml"))
        opf_path = next(e for e in container.iter() if _ns(e.tag) == "rootfile").get("full-path")
        opf = ET.fromstring(zf.read(opf_path))
        meta = {}
        for e in opf.iter():
            n = _ns(e.tag)
            if n in ("title", "creator", "language") and e.text:
                meta.setdefault(n, []).append(e.text.strip())
        manifest = {}
        nav_path = ncx_path = cover = None
        images = frozenset(n for n in zf.namelist() if n.lower().endswith(IMAGE_EXT))
        cover_id = next((e.get("content") for e in _find_all(opf, "meta") if e.get("name") == "cover"), None)
        for item in _find_all(opf, "item"):
            href = _resolve(opf_path, item.get("href", ""))
            manifest[item.get("id")] = href
            if href in images and ("cover-image" in (item.get("properties") or "").split() or item.get("id") == cover_id):
                cover = href
            if "nav" in (item.get("properties") or "").split():
                nav_path = href
            if item.get("media-type") == "application/x-dtbncx+xml":
                ncx_path = href
        spine = [manifest[i.get("idref")] for i in _find_all(opf, "itemref") if i.get("idref") in manifest]

        body_at = _landmark(zf, nav_path, "bodymatter") if nav_path else None
        toc = _toc_from_nav(zf, nav_path) if nav_path else []
        source = "nav" if toc else ""
        if not toc and ncx_path:
            toc = _toc_from_ncx(zf, ncx_path)
            source = "ncx" if toc else ""

        # Flatten the spine into one block list; remember where each file and id starts.
        blocks: list[dict] = []
        pos: dict[str, int] = {}
        sem: dict[str, set] = {}
        for doc in spine:
            try:
                raw = zf.read(doc).decode("utf-8", errors="replace")
            except KeyError:
                continue
            raw = _DROPCAP.sub(lambda m: m.group(1).upper(), raw)
            p = _Blocks(doc, images)
            p.feed(raw)
            p.close()
            pos[doc] = len(blocks)
            sem[doc] = {t for m in _SEM.finditer(raw[:6000]) for t in m.group(1).split()}  # the page's own outer semantics
            for anchor, i in p.anchors.items():
                pos[f"{doc}#{anchor}"] = len(blocks) + i
            blocks.extend(p.blocks)
        for blk in blocks:  # pictures without a size hold no space while loading; read it from the file header
            if blk["type"] == "img" and "width" not in blk:
                with zf.open(blk["src"]) as f:
                    wh = _image_size(f.read(65536))
                if wh:
                    blk["width"], blk["height"] = wh

    # Project Gutenberg wrappers are not the book.
    start, end = 0, len(blocks)
    for i, b in enumerate(blocks):
        t = b["text"]
        if t.startswith("*** START OF") and "GUTENBERG" in t.upper():
            start = i + 1
        if t.startswith("*** END OF") and "GUTENBERG" in t.upper():
            end = i
            break

    entries = []
    trail: list[tuple[int, str]] = []  # (depth, title) of the enclosing contents entries, kept even when they have no text
    for title, href, depth in toc:
        while trail and trail[-1][0] >= depth:
            trail.pop()
        at = pos.get(href, pos.get(href.split("#")[0]))
        if at is not None:
            entries.append((at, title, depth, [t for _, t in trail]))
        trail.append((depth, title))
    if repair and entries and min(e[0] for e in entries) > start + 0.5 * (end - start):
        entries = []  # contents that skip most of the book (some list only the license): no better than none
    if not entries:  # no usable TOC: one chapter per spine file
        entries = [(pos[d], f"Section {n + 1}", 0, []) for n, d in enumerate(spine) if d in pos]
        source = "files"
    entries.sort(key=lambda e: e[0])

    if not cover:  # no declared cover: an image whose name says cover
        cover = next((n for n in sorted(images) if "cover" in n.lower().rsplit("/", 1)[-1]), "")
    book = Book(title=(meta.get("title") or ["Untitled"])[0], authors=meta.get("creator", []),
                language=(meta.get("language") or [""])[0], cover=cover or "", images=images,
                body_words=sum(len(b["text"].split()) for b in blocks[start:end] if b["type"] != "img"), toc=source)
    heads: list[str] = []
    for n, (at, title, depth, up) in enumerate(entries):
        nxt = entries[n + 1][0] if n + 1 < len(entries) else len(blocks)
        lo, hi = max(at, start), min(nxt, end)
        if hi <= lo:
            if lo < end and title and not MATTER_TITLE.search(title):
                heads.append((title, depth))  # a label over what follows, like PART ONE in a flat contents
            continue
        ch = Chapter(index=len(book.chapters), title=title or f"Section {n + 1}", depth=depth, blocks=blocks[lo:hi], trail=up,
                     heads=[t for t, d in heads if d <= depth])
        heads = []
        if ch.title.strip(" .").lower() == book.title.strip(" .").lower():  # a chapter named after the book: use its own heading
            ch.title = next((b["text"].strip() for b in ch.blocks[:4] if b["type"].startswith("h")
                             and b["text"].strip(" .").lower() != book.title.strip(" .").lower()), ch.title)
        book.chapters.append(ch)
    from . import structure
    if repair:  # off only to measure what the rules fix (tools/corpus.py) and to find cards made before a repair
        book.repairs = structure.rules(book)
    _nest(book.chapters)
    if repair:
        structure.kinds(book)
    _semantic_matter(book, blocks, pos, sem, body_at)
    return book


def _landmark(zf, nav_path, kind):
    """Where the book's landmarks nav says its main text (bodymatter) starts, as a spine path with its anchor."""
    try:
        root = ET.fromstring(zf.read(nav_path))
    except (KeyError, ET.ParseError):
        return None
    for nav in _find_all(root, "nav"):
        if "landmarks" not in (nav.get("{http://www.idpf.org/2007/ops}type") or "").split():
            continue
        for a in _find_all(nav, "a"):
            if kind in (a.get("{http://www.idpf.org/2007/ops}type") or "").split():
                return _resolve(nav_path, a.get("href", ""))
    return None


CONTENT_TYPES = {"preface", "foreword", "introduction", "prologue", "preamble", "chapter", "part", "bodymatter", "epigraph"}


def _semantic_matter(book, blocks, pos, sem, body_at):
    """Front and back matter named by the EPUB itself: a page whose epub:type is a title page, imprint, colophon,
    copyright page, endnotes and the like, and any page before the landmarks' start of the main text that does not
    say it is a preface, foreword, introduction or chapter."""
    starts = sorted((at, doc) for doc, at in pos.items() if "#" not in doc)
    body = pos.get(body_at, pos.get((body_at or "").split("#")[0])) if body_at else None
    seen = {id(b): i for i, b in enumerate(blocks)}
    for c in book.chapters:
        if c.kind == "matter" or not c.blocks:
            continue
        at = seen.get(id(c.blocks[0]))
        if at is None:
            continue
        doc = next((d for a, d in reversed(starts) if a <= at), None)
        types = sem.get(doc, set())
        if types & MATTER_TYPES and not types & {"chapter", "part"}:
            c.kind = "matter"
        elif body is not None and at < body and not types & CONTENT_TYPES and c.words < 1500:
            c.kind = "matter"


def _nest(chapters: list[Chapter]):
    """Parents and kinds from the book's own nesting: a short entry with sub-entries is a part, contents pages and
    indexes (and anything inside them) are matter, an almost empty entry is matter."""
    stack: list[Chapter] = []
    for c in chapters:
        while stack and stack[-1].depth >= c.depth:
            stack.pop()
        c.parent = stack[-1].index if stack else None
        stack.append(c)
    has_kids = {c.parent for c in chapters if c.parent is not None}
    for c in chapters:
        up = chapters[c.parent] if c.parent is not None else None
        # a contents entry that holds the whole book (some NCX files nest everything under it) passes nothing down
        if MATTER_TITLE.search(c.title) or (up is not None and up.kind == "matter" and not CONTENTS.match(up.title)):
            c.kind = "matter"
        elif c.index in has_kids:
            c.kind = "chapter" if c.words >= MIN_WORDS else "part"
        elif c.words < MIN_LEAF_WORDS:
            c.kind = "matter"
