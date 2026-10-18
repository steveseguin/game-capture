# Viewer-disconnect classification and packaged follow-up — 2026-10-17

Both Apple M1 encoders completed five two-viewer Hang Up/rejoin cycles, surviving picture/stereo, a final fresh viewer and cleanup. Windows packaged capture and all 70 GUI snapshot assertions also passed on the same runtime source. These are functional results; macOS remains experimental and public release assets are unchanged.

## What changed

A viewer can close its connection between the sender's open-track check and its send. The app now records `track_closed_during_send` only when libdatachannel raises the exact `Track is not open` or `Track is closed` error **and** that track is no longer open. Other errors, including unknown or changed library error messages, remain `send_failed`. Every such send still returns false, logs its exception and increments the existing aggregate. The asynchronous disconnect race still exists; it is now distinguishable from an unexplained send error.

This is an internal C++/local-diagnostics change. The packaged workflows use VDO.Ninja's existing Hang Up button and bye behavior; no new VDO.Ninja API or signaling command was added. Native source implements the check in `src/webrtc/video_send_failure.h` and the existing H.264/VP9 send paths.

The updated workflow rejects any aggregate send-failure increase during the picture observation while both viewers remain connected. It also requires zero empty-packet, missing-packetizer, pacer and unexplained-send failures, matching settled counters, continued survivor playback, fresh reception and cleanup. Track/transport-unavailable counts during departures remain visible. This criterion differs from the earlier blanket zero-counter gate; those historical failures have not been changed.

## Packaged Mac results

Runtime source: `325b70822a6172d874534c7910df0d7e544f1e7f`. All 39 application units were rebuilt. Developer ID executable SHA-256: `cea19c786e764670927ce00399b32db3ef5c5310ccc2ffe3820a7483d7f05d9d`. The local bundle is **not notarized or released**. Source host: Apple M1, macOS 26.4.1, arm64. The 1920×930 fixture window was fitted to 1080p60 H.264 at 8 Mbps; sender and receiving Chromium browsers shared the host.

| Encoder | Completed cycles | Good stereo windows | Aggregate failed sends | Track / transport unavailable | Unexplained send failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| x264 | 5/5 | 150 | 6 | 2 / 4 | 0 |
| videotoolbox | 5/5 | 150 | 10 | 6 / 4 | 0 |

All 22 picture phases showed advancing, decodable fixture identities. All 300 stereo observations passed. Both final peer counts were zero, both publisher exits were 0, and discovery files were removed. Encoder failures/timeouts and final audio-send failures were zero. All existing 15-second active-track checks passed for explicit Hang Up; retained logical sessions were allowed their existing recovery period before removal.

The new `track_closed_during_send` count was **zero in these two packaged runs**. Its positive path was exercised separately by the native gate; these runs do not claim to have reproduced and eliminated that timing race. Same-host functional observations are not sustained frame-rate, thermal, WAN or picture-quality qualification.

## Native gates

The classification gate checks both exact closure messages, an open-track contradiction, unrelated transport errors and changed error text. Real negotiated H.264 and VP9 endpoints are then closed after successful send admission; both sends return false with the closure reason. Existing concurrent send/reset/shutdown checks pass too. These are gates, not packaged application testing.

The first attempt's five-second setup deadline failed before ICE detected closure. The 30-second allowance passed at the observed ICE boundary; the final gate uses 45 seconds to leave scheduling margin. Both passing runs and the failed attempt are retained. This setup allowance changes neither the product nor the packaged workflow's timing criteria.

## Windows regression workflow

[Run 39083642554](https://github.com/steveseguin/game-capture/actions/runs/39083642554) passed all **70/70 assertions**: ten ordinary snapshot replacements, ten locked-snapshot preservations, twenty normal exits/discovery removals, and **138,302 concurrent reads with 0 incomplete JSON**. The existing 500 ms bounded atomic retry remains in effect.

Actual Windows Graphics Capture/software H.264 MFT playback, static pacing, resize, late joining and expected source-loss exit also passed on an interactive Windows Server 2022 VM. This covers the extracted package; physical GPU/audio/devices, consumer Windows versions, and installer/portable launches remain unqualified.

Executable SHA-256: `108c644a8e6a3a9b07d2bc905eb20f200970843134640e0a9d2dd72b0a3b294a`. ZIP SHA-256: `48b0ab606b6ef16d5b04b7e060563d5db7442dd2a6dd9a2fd2673f2496bdfd58`. Payload manifest: `790dc67efeef04286b1c5de9da88bfeea8256b890ed0889aaaf23d3594cfa111`.

## Boundaries and evidence

The exact new Mac binary has not inherited the older notarized candidate's thirty-minute endurance/distribution results. Physical minimum-version Mac hardware, fresh-host privacy/device behavior, sleep/wake, broader accessibility/output paths and consumer Windows hardware still need qualification. Earlier abrupt-tab-close and recorder-clock failures remain preserved. No matched OBS/FFmpeg/WHIP comparison or VMAF/PSNR/SSIM score was produced.

The evidence manifest binds 26 local files, including the failed gate attempt. Raw publisher/control/settings logs remain local; only explicit allowlisted observations are exported. Manifest SHA-256: `6c959958051a47b216905d36ffb8fb7640ddfe1bfa2f0cbf203f70b0252deb08`. [Measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-track-close/measurements.json), [manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-track-close/evidence-manifest.json), [validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-track-close/validation.json), [earlier results](macos-viewer-teardown-2026-10-17.md).

Later delivery qualification: [the unchanged executable is now notarized/stapled, with local browser-quarantine and fresh macOS 14 VM workflows](macos-lifecycle-delivery-2026-10-17.md). It remains unpublished and experimental.
