# Release Playbook (Fixed Download Names)

Use this every time so `releases/latest/download/...` links keep working.

## Stable filenames (do not change)

- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`

Versioned files can change per release, but these three stable aliases must always be uploaded.

## Preferred one-command flow

From repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\release-and-publish.ps1 -Version <version> -BuildDir build-review2
```

This runs:
- build/package
- signing step
- VirusTotal submission step
- release create/update

If you need to avoid long tests, add `-SkipFastGate`.

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
- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`

## 2) Run fast gate before upload

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release
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

Replace `<tag>` and `<version>`.

```powershell
gh release upload <tag> `
  .\native-qt\dist\game-capture-<version>-setup.exe `
  .\native-qt\dist\game-capture-<version>-portable.exe `
  .\native-qt\dist\game-capture-<version>-win64.zip `
  .\native-qt\dist\game-capture-setup.exe `
  .\native-qt\dist\game-capture-portable.exe `
  .\native-qt\dist\game-capture-win64.zip `
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
