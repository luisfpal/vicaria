# Releasing

Nothing is published from a developer machine. A push to `main` deploys the web app; a tag builds the downloads and
drafts a release. A maintainer reads the draft and publishes it.

## Channels

| Channel | How it updates | Where it comes from |
| --- | --- | --- |
| Web app (PWA) | A service worker fetches the new build in the background and switches when nothing is busy | GitHub Pages, deployed by `.github/workflows/pages.yml` on every push to `main` |
| Mac and Linux | The Tauri updater checks at launch and every six hours, verifies a signature, and offers a restart | `latest.json` and signed bundles on the GitHub release |
| Android | The APK is signed with the release keystore; Obtainium (or a manual download) follows GitHub releases | The release APK |

The web app is served under `/next/` while 0.x is still served at the site root; see `docs/ARCHITECTURE.md`.

## Making a release

1. Make sure `main` is green: `.github/workflows/ci.yml` runs unit tests, the model check, every end-to-end script and
   the performance budgets. Locally: `bash app/scripts/full-suite.sh`.
2. Set the version in `app/package.json` (the Tauri config reads it from there) and add the entry to `CHANGELOG.md`.
3. Publish the source (above), then tag the published commit: `git tag v1.0.0 public && git push <remote> v1.0.0`. The tag must equal the package version or the publish job stops.
   A tag with a dash (`v1.1.0-rc.1`) becomes a pre-release.
4. `.github/workflows/release.yml` builds Mac (Apple silicon and Intel), Linux (AppImage and deb) and the Android APK,
   writes `latest.json` with `app/scripts/latest-json.mjs`, and creates a **draft** release with generated notes.
5. Read the draft, install one build, then publish it. Publishing is what makes `latest.json` and the APK visible to
   updaters and Obtainium.

## Signing keys

Two keys, both kept outside the repository, both unrecoverable if lost.

- **Updater key** (minisign, made with `npx tauri signer generate`). The private key and its password are the
  Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public half is the
  Actions variable `UPDATER_PUBKEY`, injected at build time. Installed desktop apps accept only updates signed by it.
- **Android keystore.** Secrets `ANDROID_KEYSTORE_BASE64` (the keystore, base64), `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. A phone can update an app only if the new APK carries the same
  signature as the installed one; with a different key the user must uninstall first and loses local data. Back
  the keystore and its passwords up off the build machine before the first release reaches a phone.

Local builds use a throwaway key (`VIC_KEYSTORE` and friends, see `app/src-tauri/gen/android/app/build.gradle.kts`).
Never publish a build signed with it. The Mac app is ad-hoc signed (no Apple developer account), which is why the
installer script is the documented way to open it without a warning.

Setting the secrets (values come from files or a password manager, never typed into a shell history):

```
base64 -i vicaria-release.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 -R <owner>/<repo>
gh secret set ANDROID_KEYSTORE_PASSWORD -R <owner>/<repo>
gh secret set ANDROID_KEY_ALIAS -R <owner>/<repo>
gh secret set ANDROID_KEY_PASSWORD -R <owner>/<repo>
gh secret set TAURI_SIGNING_PRIVATE_KEY < updater.key -R <owner>/<repo>
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R <owner>/<repo>
gh variable set UPDATER_PUBKEY -R <owner>/<repo> < updater.pub
```

## How web updates work

`postbuild.mjs` writes `sw.js` with the exact file list and a content hash, and `version.txt` with the build id.
The worker downloads the new build while the old one keeps serving. The page switches only when that cuts nothing:
at launch before the reader has touched anything, or while the tab is hidden, with one tab open and nothing busy
(`app/src/core/busy.ts`). Otherwise it offers a reload that waits for busy work. Checks run at launch, every six hours
and when the app is reopened after six hours.

## Pulling or holding back a build

`update.json` at the site root (never cached) controls it:

```json
{ "bad": ["6f3b581a509f"], "rollout": 10, "build": "169c4d97bbd2" }
```

- `bad`: a device running a listed build steps back to the build it had before (the service worker keeps it).
- `rollout` with `build`: only that share of devices takes that build for now.

To pull a bad web release, list it in `bad` and revert the deploy. For desktop, delete or replace the release's
`latest.json`. A build that cannot open the library after a failed upgrade steps back by itself.

## Migrations and releases

A release that changes stored data must follow `docs/MIGRATIONS.md`: additive, idempotent steps, a saved-library
fixture for the new version, and an updated `app/schema.json`. Another device may still run the previous build, so
nothing the previous build reads may be removed or renamed. Test the upgrade on a real saved library before tagging.

## Publishing the source

Day-to-day work happens on private branches whose history may hold working notes. What is published is a separate
branch, `public`, built from the tracked files of a reviewed commit with `scripts/publish-public.sh`:

```
scripts/publish-public.sh                 # from HEAD; or: scripts/publish-public.sh -m "Vicaria 1.1.0" <ref>
```

The script refuses to continue if the tree holds a private file name, a private path or host name, or anything
`gitleaks` finds; it creates `public` as a single root commit the first time, and afterwards one new commit per release
on top of the previous `public` tip, so the published history is only the sequence of releases. It never pushes; it
prints the command. The maintainer pushes `public:main`, then tags the release (a tag is created on the published
commit, never on a private one). Install gitleaks from its release page and set `GITLEAKS=/path/to/gitleaks` if it
is not on `PATH`.

## After publishing

Check the Get page offers the new downloads, install on one device per platform, and watch the issue tracker. If
something is wrong, pull the build as above and ship a fixed one; never edit a published tag.
