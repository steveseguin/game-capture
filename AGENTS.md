# AGENTS.md

## Scope

This repository is the primary source for **Game Capture** (Windows native Qt app) and its docs/release flow.

When working from a fresh context, prioritize this repo over legacy/archived repos.

## Release Truths

- Stable download filenames must always exist on the latest release:
  - `game-capture-setup.exe`
  - `game-capture-portable.exe`
  - `game-capture-win64.zip`
- Versioned assets must also be uploaded for each release:
  - `game-capture-<version>-setup.exe`
  - `game-capture-<version>-portable.exe`
  - `game-capture-<version>-win64.zip`
- `docs/gamecapture.html` and website links depend on stable filenames above.

## Quality Gate Before Release

Run fast gate first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release
```

## Build + Sign + VirusTotal + Publish

Preferred one-command flow:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\release-and-publish.ps1 -Version <version>
```

The script handles:

1. Clearing proxy env vars for external API calls.
2. Fast gate (unless skipped).
3. Build/release packaging.
4. Code signing (best effort) using shared code-signing repo.
5. VirusTotal submission (best effort).
6. Release create/update on GitHub with stable + versioned assets.

## Signing and Secrets

- Code-signing repo expected at:
  - `C:\Users\Steve\code\code-signing`
- Decrypted cert expected at:
  - `C:\Users\Steve\code\code-signing\secrets\decrypted\certs\socialstream.pfx`
- Cert password loaded from:
  - `WIN_CSC_KEY_PASSWORD` env var, or
  - `C:\Users\Steve\code\code-signing\secrets\decrypted\build-config.env`
- VirusTotal key loaded from:
  - `VT_API_KEY` env var, or
  - `native-qt/.vt-apikey`, or
  - `.vt-apikey`

Do not commit secret files. `.gitignore` already excludes local key files.

## Docs To Keep Current

- `README.md`
- `docs/gamecapture.html`
- `docs/RELEASES.md`
