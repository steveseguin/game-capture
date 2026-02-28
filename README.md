# Game Capture (Windows)

Native Windows game capture and publishing app for VDO.Ninja workflows.

## Status

- Platform: Windows only (currently)
- Primary app source: `native-qt/`
- License: AGPL-3.0

## Download

Release binaries are published here:

- https://github.com/steveseguin/game-capture/releases/latest

Expected assets:

- `game-capture-<version>-setup.exe` (installer)
- `game-capture-setup.exe` (stable installer alias)
- `game-capture-<version>-portable.exe` (portable)
- `game-capture-portable.exe` (stable portable alias)
- `game-capture-<version>-win64.zip` (staged zip)

## Build (Windows)

Prerequisites:

- Visual Studio 2022 (C++)
- CMake 3.24+
- Qt6

Build:

```powershell
cd native-qt
mkdir build
cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
ninja
```

## Test

Primary QA/test plans are in `native-qt/qa/`.

Examples:

```powershell
cd native-qt
npm install
npm run e2e:stream
.\qa\run-release-readiness.ps1 -BuildDir build-review2 -Configuration Release
```

## Repository Scope

This repo intentionally excludes legacy web wrapper content and archived historical app trees.

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
See `LICENSE` for details.
