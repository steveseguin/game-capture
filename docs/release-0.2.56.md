## Game Capture 0.2.56

- Fix ordinary browser playback when alpha is enabled: keep the optional alpha track inactive until the receiver requests it.
- Fix native OBS alpha activation when room viewer capabilities arrive before initialization.
- Improve QSV memory stability with pooled hardware uploads.
- Improve capture cadence, encoder handovers, and recovery after transport or source changes.
- Strengthen release validation with explicit publisher hashes, ordinary-page color-track checks, and failure cleanup diagnostics.

Windows validation with OBS plugin v1.1.68 covered H.264 and VP9, transparency, source restart, reconnection and packet loss. A 1080p60 H.264 run passed ten measured minutes with audio and native OBS alpha, including twenty reconnect cycles. Browser playback also passed UDP and TCP TURN checks.

The intermittent local RTC fixture timeout remains unexplained; additional repetitions passed with diagnostics enabled. Hour-scale stability, cellular switching, and installer GUI upgrades are not claimed by these results.

Final-package Windows release readiness passed, including browser and native OBS alpha workflows, a 30-minute room run with 309 join/leave cycles, and a 30-minute browser run with 100 viewer iterations. Both sustained runs passed without retries and used multiple publisher sessions.

Assets include the Windows installer, portable executable, ZIP package, and FFmpeg source/build information. Stable-name assets are identical to their versioned counterparts.
