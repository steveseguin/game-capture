# AI control validation — September 7, 2026

The optional MCP bridge was exercised through the official MCP SDK client against the packaged Game Capture v0.2.57 executable, not a mock HTTP server. Publisher SHA-256: `ffe317a2a0a1234d6af7c920b64509c90300c631898f10da29964aeb88575166`. Native OBS used plugin v1.1.68, SHA-256 `09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb`.

## Completed application workflows

- MCP initialization and tool discovery, app launch for inspection, version/schema retrieval, all four source discovery endpoints, recent logs, and issue-report creation passed.
- MCP launched a synthetic Spout2 moving-edge source through packaged Game Capture with software H.264 and VP9 alpha at 640×360, 30 FPS. Real Edge browser playback advanced before and after MCP-requested peer transport recovery.
- Status and timed diagnostics sampling passed. Stop ended both live and capture state; export produced readable JSON; quit closed the owned process.
- Missing required launch settings, a second launch while an owned app was running, and an unavailable Spout sender returned errors. The bridge could launch again after startup failure.
- A live MCP-owned publisher exited on normal MCP disconnect. An explicitly attached publisher survived disconnect. Bearer tokens were absent from attachment output, and a discovery file containing a non-loopback URL was rejected.
- Native OBS received the MCP-launched VP9 stream alongside the browser. Pixel-based moving-alpha checks passed before and after transport recovery. Its 4-second recording contained 120 frames at 30 FPS, 119 changing-frame transitions (29.75 per second), no held frames, and no OBS render/output skips. The original OBS recording directory was restored.

The existing packaged local-control workflow also passed: actual application log retrieval, fixed-length/fragmented HTTP requests, malformed framing rejection, report export and failed atomic replacement, and multi-instance discovery ownership.

## Firewall findings and limits

The installer already creates an inbound UDP allow rule scoped to its executable. Source changes now consume the NSIS command results, report rule-creation failure visibly, and scope uninstall rule deletion to the installation path. The revised installer compiled successfully using the packaged payload. PowerShell syntax, JavaScript syntax, and QA documentation contracts passed as gates.

Read-only inspection of Windows' active firewall policy returned no matching installer rule for the portable package used in these workflows. Portable packages do not install rules. This session was not elevated, so actual install/firewall creation/uninstall testing has **not been completed**. The elevated workflow is provided in `native-qt/e2e/installer-firewall-e2e.ps1`; its syntax was checked, but it has not been run through installation here.

The MCP bridge is available from source with locked Node dependencies. It is not bundled in the already-published v0.2.57 installer, and the new installer error handling is not retroactively present in that release. No general operating-system input injection or new public remote-control listener was added.

## Local evidence

- Final MCP/browser/native OBS run: `native-qt/qa/reports/mcp-e2e/1788837028062/results.json` and `obs/obs-runtime-results.json` within that directory.
- Earlier completed MCP/native OBS run: `native-qt/qa/reports/mcp-e2e/1788836861867/`.
- Packaged local API baseline: `native-qt/qa/reports/ai-control-baseline/af48d4715dd440b28b6d92a795694388/`.
- Revised installer build artifact: `native-qt/qa/reports/mcp-e2e/firewall-review-setup.exe`.

These workflows establish the MCP control path and the stated receiver behavior on this host. They do not replace the encoder/settings matrix or prove receiver quality from publisher diagnostics alone.
