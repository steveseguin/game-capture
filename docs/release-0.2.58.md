# Game Capture v0.2.58

Routine status changes no longer request the Windows alert sound. This fixes
beeps during source selection, normal button actions, and background source
refreshes while retaining accessibility announcements.

- FFmpeg validation runs in the background, keeps the desktop responsive,
  reports timeouts accurately, and ignores results for settings that changed.
- Streaming startup also checks FFmpeg in the background. Diagnostics read
  completed probe metadata without waiting for validation.
- The close-to-tray reminder appears once per app session.
- Release readiness now requires packaged Windows desktop workflows that
  observe sound requests, exercise slow/failed FFmpeg validation, verify GUI
  streaming through a browser receiver, and check tray/quit behavior.

See the [investigation](windows-alert-sound-investigation-2026-09-24.md) for the
cause, historical reproduction, and gaps in earlier coverage.
