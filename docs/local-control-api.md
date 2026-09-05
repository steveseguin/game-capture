# Local Control API

Game Capture can expose an opt-in loopback HTTP JSON API for same-user automation, local LLM agents, and issue collection tools.

The server is disabled by default. When enabled, it binds only to `127.0.0.1`, writes a discovery file, and requires a bearer token for every endpoint except `/health`.

## Enable

Command-line flags:

```powershell
game-capture.exe --local-control
game-capture.exe --local-control-port=47631 --local-control-token=my-token
game-capture.exe --local-control-discovery=C:\Temp\game-capture-control.json
```

Environment variables:

```powershell
$env:GAME_CAPTURE_LOCAL_CONTROL = "1"
$env:GAME_CAPTURE_LOCAL_CONTROL_PORT = "47631"
$env:GAME_CAPTURE_LOCAL_CONTROL_TOKEN = "my-token"
$env:GAME_CAPTURE_LOCAL_CONTROL_DISCOVERY = "C:\Temp\game-capture-control.json"
```

If no token is supplied, the app generates one. If no port is supplied, the OS chooses a free loopback port.

A valid `--local-control-port` overrides `GAME_CAPTURE_LOCAL_CONTROL_PORT`,
including `--local-control-port=0`, which explicitly requests an OS-assigned port.

Default discovery path:

```text
%LOCALAPPDATA%\GameCapture\control.json
```

Default report path:

```text
%LOCALAPPDATA%\GameCapture\reports
```

Crash reports:

```text
%LOCALAPPDATA%\GameCapture\crashes
```

Crash reports are best-effort Windows artifacts written after hard crashes. They include a small `.json` summary and a `.dmp` minidump when dump writing succeeds.

## Discovery

If instances share a discovery path, the latest successful writer is discoverable.
Closing an older instance preserves the newer instance's discovery file. Use a
different `--local-control-discovery` path for each instance when automating
multiple publishers. Closing the latest instance does not restore an older entry.

Each concurrently running publisher has its own log. The first publisher uses
`game-capture-debug.log`; additional publishers use a UUID suffix. Read the `path`
returned by `/logs/recent` to locate that instance's log. Its issue reports and
crash reports reference the same log.

Read the discovery file to find the current port, base URL, token, and supported endpoints:

```powershell
$control = Get-Content "$env:LOCALAPPDATA\GameCapture\control.json" | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($control.token)" }
Invoke-RestMethod "$($control.base_url)/health"
Invoke-RestMethod "$($control.base_url)/schema" -Headers $headers
```

## Endpoints

Unauthenticated:

- `GET /health`

Authenticated:

- `GET /schema`
- `GET /diagnostics`
- `GET /sources/windows`
- `GET /sources/cameras`
- `GET /sources/spout`
- `GET /sources/audio-inputs`
- `GET /logs/recent?lines=250`
- `POST /commands`

`/logs/recent` defaults to the latest 250 lines. Only the `lines` query parameter
changes that limit; unrelated query parameters are ignored. Numeric limits are
clamped to 1–2000.

Audio-input source objects include `sampleRate`, `channels`, `bitsPerSample`,
`validBitsPerSample`, `floatingPoint`, and `isDefault` alongside the device
`id` and `name`.

Authentication header:

```text
Authorization: Bearer <token>
```

`X-Game-Capture-Token: <token>` is also accepted for simple local clients.

Requests must use fixed-length bodies (`Content-Length`); transfer encoding is
not supported. Invalid or duplicate lengths and requests exceeding 1 MiB including
headers receive HTTP 400. Diagnostics exports return success only after the file
has been committed; failed replacements preserve the previous report.

## Diagnostics Source Health

`GET /diagnostics` includes a `source` object for quick capture-source checks:

- `mode`, `source_id`, `has_frame`, `bgra`, `width`, `height`
- `alpha_detected`, `green_background_likely`, `large_source`
- `transparent_ratio`, `translucent_ratio`, `opaque_ratio`, `green_ratio`
- `resize_count`, `sampled_frames`

Local tools should show these as plain status, for example: transparency detected, green background detected, large source may lower FPS, or sender resized during capture.

`GET /diagnostics` also includes video alpha/encoder fields:

- `ffmpeg_resolved`, `ffmpeg_resolved_path`, `ffmpeg_configured_path`
- `ffmpeg_version`, `ffmpeg_configuration`, `ffmpeg_has_libvpx_vp9`
- `ffmpeg_is_bundled`, `ffmpeg_is_user_override`, `ffmpeg_gpl_enabled`, `ffmpeg_nonfree_enabled`, `ffmpeg_probe_error`
- `alpha_enabled`, `alpha_background_mode`, `alpha_background_color_rgb`
- `encode_timeouts`, `encode_hard_failures`
- `alpha_packets_sent`, `alpha_encode_failures`, `alpha_encode_timeouts`, `alpha_send_failures`
- `alpha_frames_queued`, `alpha_frames_dropped`

## Commands

Stop capture and streaming without closing the app:

```powershell
Invoke-RestMethod "$($control.base_url)/commands" -Headers $headers -Method Post `
  -ContentType "application/json" -Body '{"command":"stop"}'
```

Stop capture and streaming, then quit the app:

```powershell
Invoke-RestMethod "$($control.base_url)/commands" -Headers $headers -Method Post `
  -ContentType "application/json" -Body '{"command":"quit"}'
```

Export diagnostics:

```powershell
Invoke-RestMethod "$($control.base_url)/commands" -Headers $headers -Method Post `
  -ContentType "application/json" -Body '{"command":"export_diagnostics"}'
```

Create an issue report with current diagnostics and recent log lines:

Automatically named diagnostics exports and issue reports include a timestamp
and UUID so rapid requests retain separate files. Use the returned `path` to
locate each report. An explicit diagnostics export path still replaces that file.

```powershell
Invoke-RestMethod "$($control.base_url)/commands" -Headers $headers -Method Post `
  -ContentType "application/json" -Body '{"command":"issue_report","notes":"Spout sender disappeared after resize"}'
```

## Local LLM Usage

A local agent should:

1. Launch the compiled app with `--local-control` or check for the discovery file.
2. Read `control.json`.
3. Call `/schema` to learn the supported contract.
4. Call `/diagnostics`, `/logs/recent`, and source endpoints before deciding what to do.
5. Use `issue_report` when asking a user or developer for help, because it captures app state and recent logs in one file.
6. Use `stop` or `quit` only when the user explicitly asks or the workflow clearly owns the app process.

This API intentionally does not yet start or reconfigure a live stream. Starting a stream changes UI state, capture state, signaling state, and user-visible settings together, so that needs a separate workflow contract before being exposed safely.
