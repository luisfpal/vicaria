# Excerpta

A reader that keeps what a book taught you.

Open a book and read. Excerpta writes a short card for each chapter: the core lesson, the terms the author uses in their own way, and why each point matters. Ask questions about a chapter or the whole book. Highlight passages. Listen with your device's voice. See how ideas connect across everything you have read.

**Open it:** [luisfpal.github.io/excerpta](https://luisfpal.github.io/excerpta/)

## Install

Open the link on your phone or computer, then choose **Install app** (Chrome, Edge, Android) or **Share → Add to Home Screen** (Safari). It works offline after the first visit. There is no account.

## Books

A classic is waiting on your shelf the first time you open it. Tap **Discover** to add more free books from [Standard Ebooks](https://standardebooks.org), or add any DRM-free EPUB you own.

## AI

Tap **Connect AI** and sign in with [OpenRouter](https://openrouter.ai) to use hundreds of models with pay-as-you-go credits. Or paste a key from DeepSeek, Anthropic, Google Gemini, xAI or OpenAI in Settings. Reading, highlights and listening work without AI.

## Sync

Tap the **sync** button, then point your other device's camera at the code. That's it.

Your devices talk to each other directly. When they can't, for example because one is switched off, an encrypted copy of your changes waits on public [Nostr](https://nostr.com) relays for up to 30 days, and your other device picks it up. The relays can't read it: only devices that scanned your code hold the key. You can add your own relay, or move changes with a sync file instead.

Positions, highlights, reading settings and chapter cards sync. Books move between your devices on request, straight from one to the other, while both are open.

## Privacy

Your books, notes and keys stay on your devices. The site only serves the app's files. AI requests go from your device to the provider you chose.

## Build

```
python3 standalone/build.py --base /excerpta
python3 standalone/serve_static.py standalone/dist 8000 /excerpta
```

Then open http://localhost:8000/excerpta/.

## License

Copyright © 2026 Luis Palacios. Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). See [CONTRIBUTING](CONTRIBUTING.md) and [TRADEMARK](TRADEMARK.md).
