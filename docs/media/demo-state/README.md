# Demo state

The launch screenshots in `docs/media` are taken from a library that looks like a few weeks of real use: 29 free
books from [Standard Ebooks](https://standardebooks.org), 83 highlights in six named colours, notes, sticky notes,
bookmarks, loved places, reading positions, tags that link books across authors, 45 Ask conversations with real
DeepSeek answers and citations, 8 chapter cards, three saved thoughts and two lessons.

| File | What it is |
|---|---|
| `books.txt` | Standard Ebooks paths of the books. They are downloaded on demand, never stored here. |
| `plan.json` | What the reader marked, tagged, bookmarked and asked, written from sentences in the books. |
| `wiser.json` | Three saved thoughts and two lessons, written by hand, replayed as ops. |
| `chats.json`, `cards.json` | The answers DeepSeek gave when the state was built. Replayed on every rebuild. |

No key is in these files. The key lives only in the browser profile of a `--live` run, and that profile is not saved.

## Rebuild and retake

```
cd app
VIC_BASE=/vicaria/next/ npm run build && (node bench/serve.mjs dist 47812 /vicaria/next &)
node e2e/demo-shots.mjs <epubDir> <pngDir>          # seeds a fresh library for each shot set, no key, no spend
node scripts/media.mjs <pngDir> ../docs/media         # JPEGs for the README, Get page and store listings
node scripts/store-graphics.mjs
```

`<epubDir>` is any folder: missing books are downloaded into it. To ask DeepSeek again (about $0.20 for everything,
the seed stops at an estimated $0.40) and replace `chats.json` and `cards.json`:

```
node e2e/demo-seed.mjs <epubDir> <profileDir> --live <keyFile>
```
