# OBS Ninja Plugin Testing Notes

These notes are for Game Capture development when validating the path:

```text
Spout2 sender -> Game Capture -> VP9 alpha -> VDO.Ninja -> OBS native plugin
```

The OBS automation and plugin build live in the adjacent repo:

```text
C:\Users\steve\Code\ninja-plugin
```

Do not edit that repo from Game Capture work unless the current task explicitly includes the OBS plugin.

## Portable OBS

Portable OBS executable:

```text
C:\Users\steve\Code\ninja-plugin\_obs-portable\bin\64bit\obs64.exe
```

Launch it with this working directory:

```text
C:\Users\steve\Code\ninja-plugin\_obs-portable\bin\64bit
```

Local plugin install paths used by the OBS automation:

```text
C:\Users\steve\Code\ninja-plugin\install\obs-plugins\64bit
C:\Users\steve\Code\ninja-plugin\install\data\obs-plugins
```

OBS logs:

```text
C:\Users\steve\Code\ninja-plugin\_obs-portable\config\obs-studio\logs
```

## One-Command Spout Smoke

Run from the OBS plugin repo:

```powershell
cd C:\Users\steve\Code\ninja-plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-vdoninja-gamecapture-spout-smoke.ps1 -InstallPrefix .\install
```

The script launches packaged Game Capture headless, queries the local-control API for Spout senders, starts OBS with the local VDO.Ninja plugin, creates a native `vdoninja_source`, waits for media, captures an OBS source screenshot, and fails unless OBS reports native alpha composition.

For a deterministic alpha source that does not depend on VTube Studio or another avatar app being configured correctly:

```powershell
cd C:\Users\steve\Code\ninja-plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-vdoninja-gamecapture-spout-smoke.ps1 -InstallPrefix .\install -UseTestSpoutSender -TestSpoutResizeAfterMs 15000 -TestSpoutResizeWidth 960 -TestSpoutResizeHeight 540
```

That mode launches `native-qt\build-test\bin\spout_test_sender.exe`, points Game Capture at the named sender, resizes the sender mid-run, and pixel-checks OBS over a bright background. It should prove real transparency: background pixels should show the OBS background, foreground pixels should remain visible, and chroma-green fill should stay near zero.

Use a packaged Game Capture executable for this workflow. A build-tree executable can fail standalone with `0xC0000135` if runtime DLLs are not beside it.

Latest verified successful run at the time this note was added:

```text
C:\Users\steve\Code\ninja-plugin\artifacts\gamecapture-spout-smoke-20260705-232004\summary.json
```

Key success fields from that run:

- `gameCaptureDetectedSpout: true`
- `gameCaptureVp9AlphaActive: true`
- `obsAlphaCompositionActive: true`
- `obsNoNativeVideoTimeout: false`
- `obsQueueDrops: false`

That run used:

```text
C:\Users\steve\Code\game-capture\native-qt\dist\game-capture-0.2.43-win64\game-capture.exe
```

and detected:

```text
VTubeStudioSpout 2560x1351
```

## OBS Log Signals

Good OBS plugin lines:

```text
[VDO.Ninja] Loading VDO.Ninja plugin v1.1.50
[VDO.Ninja] Registered VDO.Ninja source
[VDO.Ninja] Use Native Receiver (Experimental) is enabled
[VDO.Ninja] Received VP9 alpha video track
[VDO.Ninja] Native receiver decoded first alpha frame
[VDO.Ninja] Native receiver alpha composition active
```

Bad OBS-side signs:

- `No native video packets`
- `Number of media packets dropped due to a full queue`
- OBS process exit
- New dump under `%LOCALAPPDATA%\CrashDumps`

## Manual OBS Source Check

If Game Capture is already publishing a stream, run the native source smoke against that stream ID from the OBS plugin repo:

```powershell
cd C:\Users\steve\Code\ninja-plugin
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-vdoninja-source-smoke.ps1 -Mode native -StreamId <streamId> -Password false -SkipPublisher -InstallPrefix .\install
```

This is useful when Game Capture owns stream startup and the OBS plugin script should only attach as a receiver.

## Local Control Hooks

Game Capture can expose its loopback local-control API with:

```powershell
game-capture.exe --local-control
```

Automation should read:

```text
%LOCALAPPDATA%\GameCapture\control.json
```

Useful endpoints during OBS validation:

- `GET /health`
- `GET /schema`
- `GET /diagnostics`
- `GET /sources/spout`
- `GET /logs/recent?lines=250`
- `POST /commands` with `export_diagnostics`, `issue_report`, `stop`, or `quit`

See `docs/local-control-api.md` for the full contract.

## Known Game Capture Concerns

- High-resolution Spout input plus software VP9 alpha can be expensive. The VTube Studio run exposed `2560x1351`; frame drops were observed under load. Test output caps such as `1280x720@30`, `1920x1080@30`, and then `1920x1080@60` after watchdog changes.
- True VP9 alpha requires the bundled or explicitly selected `ffmpeg.exe` with libvpx/VP9 support. Missing or incompatible FFmpeg should be visible in the UI and diagnostics, not only in logs.
- For users who cannot run software VP9 alpha, use Game Capture's alpha background/chroma mode with H.264/NVENC and key that color in the receiver.
- Current real-app coverage is VTube Studio plus the deterministic `spout_test_sender`. Add more real Spout sender apps only after the deterministic resize/restart and OBS alpha checks are stable.
- Alpha should be pixel-verified over a bright OBS background before treating the workflow as visually proven. OBS log lines prove the native alpha path activated, but a screenshot pixel check proves transparent areas composite correctly instead of showing black or chroma fill. If a real VTube/VR sender fails with green fill while `-UseTestSpoutSender` passes, the likely issue is the sender scene/output configuration rather than Game Capture transport or the OBS plugin receiver.
- VTube Studio API reachability has been confirmed, but live fuzzing of VTube state/output changes is still a separate robustness pass.
