# Changelog

Notable changes for readers and contributors. Newest first. Versions follow `app/package.json`.

## 1.0.0 (2026-11-23)

- A rewrite of the app in TypeScript (`app/`), served at `/next/` next to the previous version while 1.0 is prepared.
  Libraries from 0.x move over with every book and highlight found again by its quote.
- Ask a book: answers quote the passages they came from. Works with OpenRouter (including sign in), DeepSeek, OpenAI,
  Anthropic, Google Gemini and xAI.
- Library: a thin bar under each book shows how far you have read.
- Ideas: a map of how your books connect, fast at 1,000 books.
- Listen: any book read aloud, with a voice that runs on the device.
- PDF support, including right-to-left text.
- Sync between devices by scanning a code; encrypted, peer to peer, with public relays as fallback.
- Desktop apps (Mac, Linux) and an Android app, all a Tauri shell around the same web app, with signed updates.
- Interface in English and Spanish.
- New hourglass icon and a Get page with the right download for your device.

## 0.x

The Python-in-the-browser version, still served at the site root. See the git history of `book_reader/`.
