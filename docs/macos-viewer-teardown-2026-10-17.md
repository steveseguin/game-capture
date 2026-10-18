# Mac viewer teardown qualification — 2026-10-17

**Follow-up:** [Windows atomic snapshot fix, Mac shutdown verification and complete x264 teardown observations](windows-atomic-snapshot-2026-10-17.md). The fixed Windows package passes 70/70 assertions; the x264 counter gate remains failed.

This follow-up adds failure diagnostics and exercises actual packaged-app viewer departure/rejoin. It is **not a production sign-off or an encoding-quality comparison**. The Windows production release and public Mac beta are unchanged.

The local Mac qualification bundle is Developer ID signed, but this new bundle has not been notarized or released. Source: `3a0a17cd4f51da9ede378135663b49cfd072fafa`; executable SHA-256: `18b97911d53ebfda305053fa3c6fa87579dab356660ca6d403c814b6903d583e`. The earlier notarized timer candidate (`77e887a`, executable `dc4311…`) is the comparison baseline. Host: Apple M1, macOS 26.4.1, 8 GiB; same-host Chromium viewers and an owned moving-barcode/stereo-tone window. Requested output: H.264, 1920×1080, 60 fps, 8 Mbps; captured source: 1920×930 fitted into the output. These short workflows do not qualify sustained cadence or physical playback.

## What changed

The optional local diagnostics now break down primary peer video send failures into unavailable transport, empty packet, unavailable track, absent packetizer, failed pacer, and send failure/exception. The existing `send_failures` total, send decisions, and warnings remain intact. A closed recipient can therefore be distinguished from other failures without hiding the original count.

This is an internal C++/local-diagnostics change. Viewer departure uses either closing a real browser page or clicking VDO.Ninja's existing **Hang Up** button. The latter invokes the existing `hangup()` → `session.hangup()` → `bye` path, inspected in the local VDO.Ninja source. No new VDO.Ninja signaling command was introduced.

## Packaged application results

| Workflow | Result | What was observed |
| --- | --- | --- |
| VT, explicit Hang Up | Pass | Three two-viewer close/rejoin cycles, surviving-viewer video and stereo audio each time, then a fresh final viewer. All sessions removed; publisher quit normally and removed discovery. Three aggregate failed sends remained: one unavailable track, two unavailable transports. No encoder failure/timeout or RTP-send exception. |
| x264, explicit Hang Up | Fail | First cycle passed. During the second, the remaining viewer still received moving video and stereo audio, but sending raced track closure: `Track is not open`. The send-exception gate failed. One audio-send failure was also retained. This is not an x264 qualification pass. |
| VT, tab close, new diagnostic bundle | Completed; 15-second timing gate failed | Last tracks became inactive after 17.675 s and 16.627 s. Fresh rejoin worked. All logical sessions were eventually removed; final removal was observed 106.586 s after the final page close. Three unavailable-track sends, no encoder errors or send exceptions. |
| VT, tab close, earlier notarized candidate | Completed; same timing gate failed | Last tracks became inactive after 17.682 s and 16.631 s. Fresh rejoin worked; final removal was observed after 106.356 s. The old schema cannot classify its two aggregate failed sends. |

The tab-close delay therefore predates the diagnostic change in this comparison. The existing application retains disconnected direct sessions for 90 seconds after detecting disconnection. The new harness's initial 15-second expectation is still recorded as failed; it is not a previously established product SLA. Explicit hangup and abrupt page closure must not be treated as interchangeable teardown paths.

Two earlier VT attempts are also retained: one expected immediate logical-session removal despite the 90-second recovery policy; another stopped at the 15-second active-track bound. Neither is silently replaced by a later pass. In total, the export contains six reports, including five failed reports with their original criteria and observations.

## Windows regression qualification

[Packaged Windows run 39080791998](https://github.com/steveseguin/game-capture/actions/runs/39080791998), built from the same `3a0a17c` source, passed software H.264 window capture, static pacing, resize, late join, and source-loss exit. Its shutdown workflow passed six of seven assertions, including 72,208 reads with no incomplete JSON and preservation of a deliberately locked snapshot. It failed to replace the ordinary shutdown snapshot. This reopened Windows regression qualification; the previous passing run did not cover the failure. The subsequent fix and focused passing workflows are linked above.

A separate native Windows API probe reproduced replacement failure while a destination reader was open, including delete-sharing readers, and success after reader closure. That probe is a gate, not application testing. The subsequent bounded atomic-commit retry and repeated packaged qualification are recorded in the follow-up; that fix is not included in the Mac binary above.

## Evidence and remaining work

The export includes measured picture identities, stereo observations, counter snapshots, source/harness hashes, failed attempts, and a 64-file local evidence manifest. Raw settings, control tokens, signaling logs and session IDs are excluded. Manifest SHA-256: `403636d8e670ba4826d5cecbcb810bf7b46e6b95bbb0d7b8f53f38868bd97321`.

All 39 Mac application compilation units were rebuilt, Developer ID signatures verified, and focused native classification/concurrency gates passed. These are gates, separate from the packaged workflows above. The C++ gates verify the unchanged boolean send behavior and negotiated sends across reset/shutdown; they are not end-to-end media testing.

Still open: the send/track-close exception race, appropriate abrupt-disconnect timing criteria, broader Windows qualification, and the previously documented physical-device, minimum-OS, accessibility, external-output and endurance requirements. There is no new production-readiness claim.

[Machine-readable measurements](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-17-apple-m1-viewer-teardown).

Follow-up: [precise track-close classification and current packaged VT/x264/Windows results](macos-track-close-2026-10-17.md). Earlier failures above remain unchanged.
