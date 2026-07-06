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
- `GET /sources/spout`
- `GET /sources/audio-inputs`
- `GET /logs/recent?lines=250`
- `POST /commands`

Authentication header:

```text
Authorization: Bearer <token>
```

`X-Game-Capture-Token: <token>` is also accepted for simple local clients.

## Diagnostics Source Health

`GET /diagnostics` includes a `source` object for quick capture-source checks:

- `mode`, `source_id`, `has_frame`, `bgra`, `width`, `height`
- `alpha_detected`, `green_background_likely`, `large_source`
- `transparent_ratio`, `translucent_ratio`, `opaque_ratio`, `green_ratio`
- `resize_count`, `sampled_frames`

Local tools should show these as plain status, for example: transparency detected, green background detected, large source may lower FPS, or sender resized during capture.

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
