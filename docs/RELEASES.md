# Release Playbook (Fixed Download Names)

Use this every time so `releases/latest/download/...` links keep working.

## Stable filenames (do not change)

- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`

Versioned files can change per release, but these three stable aliases must always be uploaded.

## 1) Build release artifacts

From repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\build-release.ps1 -BuildDir build-review2 -Configuration Release -Version 0.2.5
```

Expected outputs in `native-qt/dist`:

- `game-capture-0.2.5-setup.exe`
- `game-capture-0.2.5-portable.exe`
- `game-capture-0.2.5-win64.zip`
- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`

## 2) Run fast gate before upload

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release
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
