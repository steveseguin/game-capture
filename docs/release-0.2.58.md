# Game Capture v0.2.58

Routine status changes no longer request the Windows alert sound. This fixes
beeps during source selection, normal button actions, and background source
refreshes while retaining accessibility announcements.

- FFmpeg validation runs in the background, keeps the desktop responsive,
  reports timeouts accurately, and ignores results for settings that changed.
- Streaming startup also checks FFmpeg in the background. Diagnostics read
  completed probe metadata without waiting for validation.
- The close-to-tray reminder appears once per app session.
- Includes the optional local MCP automation bridge and installer warnings when
  Windows Firewall rule creation fails, which were added after v0.2.57.
- Release readiness now requires packaged Windows desktop workflows that
  observe sound requests, exercise slow/failed FFmpeg validation, verify GUI
  streaming through a browser receiver, and check tray/quit behavior.

See the [investigation](https://github.com/steveseguin/game-capture/blob/main/docs/windows-alert-sound-investigation-2026-09-24.md) for the
cause, historical reproduction, and gaps in earlier coverage.

The packaged application passed desktop, browser, OBS, NVIDIA/Intel encoder,
and recovery workflows, plus both 30-minute soaks (308 dual-quality cycles and
101 browser playback iterations). See the [validation report](https://github.com/steveseguin/game-capture/blob/main/docs/release-0.2.58-windows-validation.md)
for artifact identity, coverage, and limitations.
