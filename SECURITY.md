# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting: **Security** tab, then
**Report a vulnerability** on this repository. Say what you found, how to reproduce it, and which version or build
you ran (Settings shows it).

Fixes for confirmed problems ship as a normal release, and the report is
credited unless you prefer otherwise.

## What is in scope

- The web app, the desktop apps and the Android app in this repository.
- Anything that could expose a reader's books, notes, sync key or AI key, or run code from a book or a sync peer.
- The update path: the service worker, `update.json`, the desktop updater (`latest.json` and its signatures) and the
  signed Android APK.

## How Vicaria handles your data

Books, notes and AI keys stay on the device. AI requests go from the device to the provider you chose, with your own
key. Sync messages are encrypted with a key that only the paired devices hold. The Privacy page in the app (Settings,
Privacy) lists everything that leaves the device and when.

## Supported versions

Only the latest release receives fixes.
