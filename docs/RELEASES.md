# Release Playbook (Fixed Download Names)

Use this every time so `releases/latest/download/...` links keep working.

## Stable filenames (do not change)

- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`
- `game-capture-ffmpeg-source-info.zip`

Versioned files can change per release, but these stable aliases must always be uploaded.

## Preferred one-command flow

From repo root:

```powershell
$firefox = (Resolve-Path (Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe")).Path
$pluginRepo = (Resolve-Path ..\ninja-plugin).Path
$spoutSender = (Resolve-Path .\native-qt\build-review2\bin\spout_test_sender.exe).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\release-and-publish.ps1 `
  -Version <version> -BuildDir build-review2 -FirefoxPath $firefox `
  -RoomAlphaPluginRepo $pluginRepo -RoomAlphaSpoutSenderPath $spoutSender
```

Use a prepared ninja-plugin checkout with the required OBS runtime and plugin payload; adjust the paths to match your validation environment. Start from a configured Release build and commit the intended source/version changes before packaging.

This runs:

- A fresh build, packaging, FFmpeg bundle validation/source-info packaging, and signing.
- Exact packaged-application readiness, including browser/OBS workflows and two 30-minute soaks.
- Versioned/stable asset identity checks, optional VirusTotal submission, and GitHub publication.

There is no `-SkipFastGate` option in this publishing command. Required readiness must pass before upload. Builds, CTest, static contracts, and installer construction are gates; actual application playback and recovery workflows provide end-to-end testing.

## 0) Preflight (avoid stale build-dir source mixups)

If your local `build-review2` was ever used by another repo, reconfigure it once:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" `
  -S .\native-qt -B .\native-qt\build-review2 `
  -G "Visual Studio 17 2022" -A x64 `
  -DVERSUS_BUILD_TESTS=ON `
  -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake `
  -DCMAKE_PREFIX_PATH=C:/vcpkg/installed/x64-windows
```

## 1) Build release artifacts

Refresh the pinned LGPL FFmpeg bundle before packaging:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\tools\fetch-ffmpeg-lgpl.ps1 -Force
```

Release packaging fails if the FFmpeg bundle is missing, GPL/nonfree, or lacks `libvpx-vp9`.

From repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\build-release.ps1 -BuildDir build-review2 -Configuration Release -Version <version>
```

VirusTotal behavior during this step:

- If signing certs are available, EXE artifacts are code-signed before VirusTotal submission.
- If `VT_API_KEY` is set, release EXEs are submitted automatically (best effort).
- If no key is set, VirusTotal submission is skipped.
- To skip explicitly: add `-SkipVirusTotal`.

Expected outputs in `native-qt/dist`:

- `game-capture-<version>-setup.exe`
- `game-capture-<version>-portable.exe`
- `game-capture-<version>-win64.zip`
- `game-capture-<version>-ffmpeg-source-info.zip`
- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`
- `game-capture-ffmpeg-source-info.zip`

## 2) Run the fast gate during preparation

```powershell
$firefox = (Resolve-Path (Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe")).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release -FirefoxPath $firefox
```

## 2.5) Configure VirusTotal key (optional but recommended)

Use one of:

- Environment variable: `VT_API_KEY`
- Key file: `native-qt/.vt-apikey`
- Key file: repo root `.vt-apikey`

## 2.6) Configure code-signing bundle (recommended)

- Ensure your decrypted signing bundle exists at:
  - `C:\Users\Steve\code\code-signing\secrets\decrypted\certs\socialstream.pfx`
- Provide certificate password via:
  - `WIN_CSC_KEY_PASSWORD` environment variable, or
  - `C:\Users\Steve\code\code-signing\secrets\decrypted\build-config.env`

## 2.7) Run signing manually (optional verification)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\sign-artifacts.ps1 -DistDir .\native-qt\dist -Version <version> -FailOnError
```

## 2.8) Run VirusTotal manually (optional verification)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\submit-virustotal.ps1 -DistDir .\native-qt\dist -Version <version> -FailOnError
```

## 3) Upload assets to the release

The preferred command above handles upload after readiness passes. For a manual upload, first complete the packaged release-readiness workflow in the [README](../README.md#testing). Replace `<tag>` and `<version>`.

```powershell
gh release upload <tag> `
  .\native-qt\dist\game-capture-<version>-setup.exe `
  .\native-qt\dist\game-capture-<version>-portable.exe `
  .\native-qt\dist\game-capture-<version>-win64.zip `
  .\native-qt\dist\game-capture-<version>-ffmpeg-source-info.zip `
  .\native-qt\dist\game-capture-setup.exe `
  .\native-qt\dist\game-capture-portable.exe `
  .\native-qt\dist\game-capture-win64.zip `
  .\native-qt\dist\game-capture-ffmpeg-source-info.zip `
  --clobber --repo steveseguin/game-capture
```

## 4) Publish release (if draft)

```powershell
gh release edit <tag> --draft=false --repo steveseguin/game-capture
```

## 5) Links that must keep working

- `https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-setup.exe`
- `https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-portable.exe`
- `https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-win64.zip`
- `https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-ffmpeg-source-info.zip`

## Troubleshooting

- `signtool` reports no matching certs:
  - Use `native-qt/qa/sign-artifacts.ps1` (it signs directly with `socialstream.pfx` + password; no cert-store selector needed).
  - Verify:
    - `C:\Users\Steve\code\code-signing\secrets\decrypted\certs\socialstream.pfx` exists.
    - `WIN_CSC_KEY_PASSWORD` is set, or `build-config.env` contains it.

- VirusTotal `curl` TLS error `SEC_E_NO_CREDENTIALS`:
  - Clear proxy env vars before running VT:
    ```powershell
    Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY,Env:http_proxy,Env:https_proxy,Env:all_proxy -ErrorAction SilentlyContinue
    ```
  - Re-run VT step:
    ```powershell
    powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\submit-virustotal.ps1 -DistDir .\native-qt\dist -Version <version> -FailOnError
    ```

## Website and documentation follow-up

- Update release notes and link the packaged Windows validation report. Keep historical measurements tied to the version that produced them.
- Verify every uploaded asset's SHA-256 and size against the local artifact, including stable aliases. Publish `SHA256SUMS.txt` with the release.
- Keep website download links on stable aliases so they do not need a version edit each release.
- The GitHub Pages site is served from `main:/docs`; `gamecapture.html` is the canonical landing page and `index.html` redirects to it.
- Keep `sitemap.xml` limited to canonical public pages. This project is hosted under `/game-capture/`; a robots.txt file here would not control crawling at the host root.
- After a website change, verify the deployed desktop/mobile layout, keyboard navigation, setup links, and download destinations.

SEO references: [Google's software-app structured data guidance](https://developers.google.com/search/docs/appearance/structured-data/software-app) and [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap). Keep metadata factual; do not invent ratings or promise search placement.
