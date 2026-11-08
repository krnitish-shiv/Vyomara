# Building and installing Vyomara

This guide covers how to build Vyomara from source, install it as a normal
Mac app, and publish a release.

## What you need

- A Mac with Apple Silicon running macOS
- Node.js `>= 22.22.1` and pnpm `12.16.1` (use pnpm only)
- [Ollama](https://ollama.com) with a tool-calling model, for example `ollama pull qwen3:14b`
- Optional, for voice: `brew install whisper.cpp`

Run `pnpm install` once after cloning, and again whenever `pnpm-lock.yaml` changes.
Newer pnpm versions skip dependency install scripts, so Electron's app may not
be downloaded by `pnpm install`; `pnpm desktop`, `pnpm package:mac`, and
`pnpm test:desktop-ui` download it on first use (`scripts/ensure-electron.mjs`).

## Commands

| Command | What it does | Output |
|---|---|---|
| `pnpm install:mac` | **Builds a fresh app and installs it.** Quits a running Vyomara, replaces `/Applications/Vyomara.app`, and opens it. | `/Applications/Vyomara.app` |
| `pnpm package:mac` | Builds a fresh standalone app and a disk image without installing anything. | `release/Vyomara.app`, `release/Vyomara-<version>-arm64.dmg` |
| `pnpm desktop` | Development: builds the code and opens an app that runs straight from this project. | `out/Vyomara.app` |
| `pnpm build` | Only compiles main, preload, and renderer. | `out/main`, `out/preload`, `out/renderer` |
| `pnpm dev` | The command-line version of the agent. | — |
| `pnpm check` | Typecheck and all unit tests. | — |
| `pnpm test:desktop-ui` | Electron smoke test of the desktop UI. | — |
| `pnpm eval` | Agent evaluation against a real model (needs Ollama). | `eval-results.json` |

## Install on your Mac

```sh
pnpm install
pnpm install:mac
```

After that, Vyomara is a normal app: open it from Launchpad, Spotlight, or
the Dock. Keep it in the Dock with right-click → Options → Keep in Dock. To
update, pull the latest code and run `pnpm install:mac` again.

Your conversations, memories, permissions, and speech models are kept in
`~/Library/Application Support/vyomara`. The installed app and the
development app share this folder, so reinstalling keeps everything.

**First launch:** macOS asks for the microphone the first time you use voice,
and asks again for control of apps such as Chrome the first time Vyomara
opens them. Because each build has a new ad-hoc signature, macOS may ask for
these permissions again after you reinstall.

## Share the app with someone else

`pnpm package:mac` creates `release/Vyomara-<version>-arm64.dmg`. The other
person opens it and drags **Vyomara** onto **Applications**.

The app is ad-hoc signed, not signed with an Apple Developer ID, so the first
time it opens on another Mac, macOS blocks it. To open it anyway:

1. Try to open Vyomara once and close the warning.
2. Go to **System Settings → Privacy & Security** and click **Open Anyway**.

The other Mac also needs Ollama with a model, plus `whisper.cpp` for voice.

## How the app is built

`scripts/mac-bundle.mjs` builds the bundle in these steps:

1. **Compile:** `electron-vite build` compiles the TypeScript and React code into `out/`.
2. **Copy Electron:** copies `node_modules/electron/dist/Electron.app` as `Vyomara.app`.
3. **Icon:** renders `src/renderer/src/ui/assets/vyomara-app-icon.svg` at every size into `vyomara.icns`.
4. **Code (release builds only):** copies `out/main`, `out/preload`, and `out/renderer`, with a minimal `package.json`, into `Contents/Resources/app`. Electron runs that folder, so the app no longer needs this project.
5. **Info.plist:** sets the name, bundle ID (`app.vyomara.desktop`), version (from `package.json`), icon, and the permission texts for the microphone and Apple Events.
6. **Sign:** signs the bundle ad-hoc (`codesign --sign -`) and verifies the signature.

`scripts/package-mac.mjs` then creates the `.dmg` with `hdiutil` (the app,
plus a shortcut to Applications) and, with `--install`, copies the app into
`/Applications` with `ditto`.

The app has no runtime npm dependencies: React is bundled into the renderer,
and the main process uses only Electron and Node built-ins (including
`node:sqlite`).

## Release a new version

1. Update `version` in `package.json` ([Semantic Versioning](https://semver.org/)) and add a section to [CHANGELOG.md](../CHANGELOG.md).
2. Run `pnpm check` and `pnpm test:desktop-ui`, and run `pnpm eval` if the agent changed.
3. Run `pnpm package:mac` and test the app from `release/`.
4. Commit, then tag and push:
   ```sh
   git tag -a v1.2.0 -m "Vyomara 1.2.0"
   git push origin main v1.2.0
   ```
5. Create the GitHub release and attach the disk image:
   ```sh
   gh release create v1.2.0 release/Vyomara-1.2.0-arm64.dmg --title "Vyomara 1.2.0" --notes-file notes.md
   ```

## Not available yet

- **Developer ID signing and notarization:** these need a paid Apple Developer
  account. Without them, other Macs show the "Open Anyway" step above.
- **Intel Macs:** only Apple Silicon (`arm64`) builds are made.
- **Automatic updates:** to update, install the new version again.
