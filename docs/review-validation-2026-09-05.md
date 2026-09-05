# Integrated capture review — 2026-09-05

The remaining capture cadence and software H.264 color issues below are followed
up in [the subsequent validation report](capture-color-validation-2026-09-05.md).
This document preserves the original package's results.

Reviewed and integrated upstream `eba6657` with the prior capture, control, audio and encoder fixes. The upstream paced-output design is retained. Maintenance replays now explicitly use that same output clock, avoiding both stale timestamps and mixed camera/output clock epochs.

Two window-capture changes address a confirmed runtime rate problem: successful FPS changes update the capture limiter, and readback admission uses the actual pending image plus encoder activity. An idle encoder can have its single queued image replaced; a busy encoder with another image queued still suppresses readback. The pending queue remains bounded to one image.

The baseline encoded 60.17 FPS while capturing only 29.58 frames/s after a 30→60 request. The final package captured 50.99 frames/s with QSV and 42.96 with VP9 in the strict browser workflow. **Full 60-FPS fresh capture is not established. VP9 failed the ≥80% fresh-capture check.** Encoded output rate must not be interpreted as unique-image cadence. These capture counters count acquisitions, not a pixel-level distinct-frame analysis.

The final full local Release review package is `native-qt/dist/integration-cadence-review/game-capture.exe`, SHA256 `f6f9ed3fec202da3a68cadec1a6e7a2347f72e2a447ebd60871ebdb1fb1adbe5`. It includes Qt and FFmpeg dependencies and is not a published release.

## End-to-end observations

Testing ran packaged publishers, owned real Chromium windows playing a local 720p60 reference clip, and actual VDO.Ninja receivers. Browser playback pause/seek/resume and native window resize/restore were verified from the receiver. Audio was an independent 440 Hz loopback tone. Spout used the controlled native sender. Raw JSON, screenshots, diagnostics and process logs are retained locally under the ignored `native-qt/qa/reports` directories below.

| Workflow | Encoder | Workflow result | Receiver FPS across regular windows | Runtime capture FPS | RGB patch error |
|---|---|---|---|---|---|
| Window before | qsv-h264 | fail | 29.99–30.09 | 60 requested: 29.58 | not checked |
| Window final, strict capture check | qsv-h264 | pass | 29.96–30.32 | 60 requested: 50.99, 30 requested: 29.80 | not checked |
| Window final, strict capture check | auto-vp9 | fail | 29.97–29.98 | 60 requested: 42.96 | not checked |
| Spout final | qsv-h264 | pass | 59.89–60.02 | not checked | 2.00/255 |
| Spout final | auto-vp9 | pass | 59.89–59.96 | not checked | 2.00/255 |
| Spout final | software-h264 | pass | 59.95–60.04 | not checked | 19.00/255 |
| VP9 window recovery | auto-vp9 | pass | 29.96–30.07 | 60 requested: 45.67, 30 requested: 29.91 | not checked |

- Window before: `window-cadence-before/8dbeb785-4e6f-4bb1-831c-dd66a6b2b9c2/results.json`; publisher `db7dd51b899947f9f346129e836beacb1e252709b9c3d14a5269213aa5c71642`; Chromium `145.0.7632.6`.
  qsv-h264: Error: Fresh capture cadence did not follow runtime FPS
  qsv-h264 shutdown: `{"elapsedMs": 328, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: not requested.
- Window final, strict capture check: `window-cadence-verified/890f6582-5237-4b0c-99b2-b5c205d19ebf/results.json`; publisher `f6f9ed3fec202da3a68cadec1a6e7a2347f72e2a447ebd60871ebdb1fb1adbe5`; Chromium `145.0.7632.6`.
  qsv-h264 shutdown: `{"elapsedMs": 323, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: not requested.
  auto-vp9: Error: Fresh capture cadence did not follow runtime FPS
  auto-vp9 shutdown: `{"elapsedMs": 212, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: not requested.
- Spout final: `integration-spout/a750c5e9-547e-42e4-b67c-c0c2092e44f4/results.json`; publisher `f6f9ed3fec202da3a68cadec1a6e7a2347f72e2a447ebd60871ebdb1fb1adbe5`; Chromium `145.0.7632.6`.
  qsv-h264 shutdown: `{"elapsedMs": 434, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: True.
  auto-vp9 shutdown: `{"elapsedMs": 432, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: True.
  software-h264 shutdown: `{"elapsedMs": 436, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: True.
- VP9 window recovery: `integration-vp9-window\32a490ce-e213-41b8-a396-d3a43f25fb88\results.json`; publisher `f6f9ed3fec202da3a68cadec1a6e7a2347f72e2a447ebd60871ebdb1fb1adbe5`; Chromium `145.0.7632.6`.
  auto-vp9 shutdown: `{"elapsedMs": 323, "exitCode": 0, "signal": null, "forced": false, "remainingEncoders": 0}`; handshake stall observed: not requested.

## Additional validation

Nine focused gates passed: window capture, source list, main window, streaming audio conversion, signaling lifecycle, local control, recovery policy, stats panel and Spout capture. After the admission change, the affected main-window and recovery-policy gates were repeated and passed. Build, syntax and whitespace checks also passed. These are gates, separate from the application workflows above.

The settings-reset gate uses an explicit isolated INI store; the incoming default QSettings constructor bypassed the suite isolation. The merge preserves literal source titles, selection-change handling, and upstream accessibility/selection styling.

- Packaged `integration-source-selection`: pass, 7 recorded checks; `integration-source-selection\dd0922ec4c414356abba5a7f0afd82ae\results.json`.
- Packaged `integration-local-control`: pass, 20 recorded checks; `integration-local-control\2efb5dfa13aa4058ac72ec87380ba2be\results.json`.
- Native portable OBS opaque/half-transparent composition: pass; artifact hashes stable: True. Evidence: `integration-obs/manifest.json`. This verifies steady composition, not moving-alpha recovery or native FPS.

## Remaining limits and reproduction

Fresh 60-FPS browser capture remains below target, particularly for VP9. The strict failure is retained above. The software Media Foundation color discrepancy remains unresolved. Short controlled workflows do not establish high-motion game quality, A/V synchronization, physical non-48-kHz device behavior, packet loss/jitter or TURN-only operation, window recreation, or hour-long resource stability.

Use [the receiver harness](../native-qt/e2e/encoder-receiver-review.js) with the packaged publisher and a unique `--reports` directory. Set `NODE_PATH` to the installed Playwright runtime. Browser: `--window-video=<720p60 MP4> --width=1280 --height=720 --fps=30 --cases=qsv:h264,auto:vp9 --video-controls=1 --control-fps=60 --capture-cadence=1 --window-resize=1 --faults=1`. The strict capture check is expected to expose the documented shortfall; omitting it checks delivery/recovery while still recording capture counters.

Spout: `--sender=<spout_test_sender.exe> --width=1920 --height=1080 --fps=60 --cases=qsv:h264,auto:vp9,software:h264 --faults=1 --color-check=1 --shutdown-handshake-stall=1`.

References: [RTP sampling-clock requirements](https://www.rfc-editor.org/rfc/rfc3550#section-5.1), [Chrome native window bounds API](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds).
