# Game Capture v0.2.60

This patch hardens capture startup and the optional local automation controls.

- Capture checks for the optional Windows borderless interface before using it,
  and skips unsupported border-permission requests in unpackaged builds.
- Local control connections have a 10-second absolute deadline, a 32-connection
  limit, bounded reads, and a 16 KiB header limit. Incomplete or trickling requests
  can no longer retain connections indefinitely.
- Malformed HTTP request lines, headers, and duplicate authentication/framing
  headers are rejected. Only one request is handled per connection.
- The optional MCP bridge rejects oversized discovery files, preserves UTF-8/BOM
  support, and includes the dependency updates that resolved all five reported
  Dependabot alerts. Existing bridge installations should pull the source and
  rerun `npm ci --prefix native-qt/tools/mcp --ignore-scripts`.
- Packaging now requires the DirectX compiler and Visual C++ redistributable
  even when built outside a Visual Studio developer shell.
- Release readiness now exercises the missing capture-interface condition,
  deterministic HTTP/JSON fuzzing, MCP malformed inputs and ownership races, and
  real browser playback during concurrent control requests.

Version discovery and quiet daily update checks remain unchanged. Custom
resolution support is still tracked separately in issue #3.

See the [Windows validation report](https://github.com/steveseguin/game-capture/blob/main/docs/release-0.2.60-windows-validation.md)
for the exact artifact, measured results, and validation limits.
