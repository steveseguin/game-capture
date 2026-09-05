# Capture cadence and software H.264 color follow-up

This follows the remaining issues in [the integrated review](review-validation-2026-09-05.md): roughly 51 fresh window captures/s with QSV, 43–46 with VP9, and software H.264 RGB patch error of 19/255.

## Confirmed causes and changes

Windows Graphics Capture has its own minimum update interval, independent of our capture and output limiters. Its default 60-Hz interval can undershoot when compositor updates do not land exactly on that deadline. The [capture sample maintainer explains this behavior and the nonzero-interval workaround](https://github.com/robmikh/Win32CaptureSample/issues/92). The application now requests half the target frame interval through the optional `IGraphicsCaptureSession5` interface, both at startup and after a successful runtime FPS change. The existing application limiter remains responsible for limiting readbacks. [Microsoft documents the interval API](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval?view=winrt-26100).

The application limiter also rejected slightly early callbacks: a deterministic 60-Hz sequence with alternating 1-ms jitter admitted only 300 of 600 frames. A bounded allowance of at most 2 ms preserves its deadline phase and average rate while admitting all 600. A faster-producer gate verifies that this does not accumulate capture credits. Capture can replace its one pending image while the encoder is busy; the queue remains bounded to one image.

A stricter repeat caught another failure after returning from 30 to 60 FPS: VP9 captured 52.11/s and rejected 7.76/s although Windows delivered about 60/s. WGC pacing now uses the frame's compositor timestamp, avoiding callback and lock-scheduling jitter. [Microsoft defines `SystemRelativeTime` as the compositor's QPC time](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframe.systemrelativetime). After a stall, the callback drains at most the pool capacity and reads back the newest available frame rather than processing a backlog of old images.

Software Media Foundation H.264 receives limited-range BT.601 YUV from the BGRA conversion, but its untagged HD stream was decoded using BT.709. The observed colored-patch errors match that matrix mismatch; neutral gray was already correct. Earlier Media Foundation color-attribute/CodecAPI experiments were unsupported or ignored on this encoder. Software H.264 SPS headers now explicitly identify limited range, BT.709 primaries, sRGB transfer, and BT.601 matrix. The change is restricted to software H.264 with the supported YUV input packings. The configured Baseline profile is supported; unsupported profiles and malformed headers are left intact.

This edits color metadata without re-encoding slices, as supported by [FFmpeg's H.264 metadata filter](https://www.ffmpeg.org/ffmpeg-bitstream-filters.html#h264_005fmetadata). Independent FFmpeg comparisons produced identical SPS bytes with and without pre-existing VUI. Every non-SPS NAL payload remained identical, and decoded YUV frame MD5s matched before and after tagging. Regression gates cover truncation, unsupported profiles, Annex B framing, other NAL preservation, and idempotence.

## Validation scope

Testing uses the complete local Release review package with bundled Qt and FFmpeg, actual owned Chromium windows playing a 720p60 video, native Spout color fixtures, and real VDO.Ninja Chromium receivers. It is a local review package, not a published release. Browser capture checks require at least 95% of the requested rate, including startup. Receiver video, motion, audio, runtime controls, resize, reconnection, and shutdown are checked separately. Color checks now affect the overall workflow result.

Fresh-capture FPS counts image acquisitions, not encoded repeats. It is not a pixel-level count of unique displayed frames. Source playback counters and receiver decoded FPS are recorded separately. Color error is the maximum channel error across eight controlled RGB patches, not a whole-image perceptual score. The host is Windows build 26200 with Intel Graphics driving a 60-Hz display; older Windows without the optional interval API was not available for end-to-end validation.

The callback-worker and GPU timing experiments did not establish full fresh cadence and were removed. The explicit Windows interval, source-timestamp pacing, bounded jitter allowance, and latest-image admission remain. The frame pool is also retired before its readback resources are released.

## Final package results

Final executable: `native-qt/dist/capture-color-timestamps/game-capture.exe`.

SHA256: `4d7258759aafae030172780df261338f740ef83fecd06475addfef5c840add06`.

| Workflow / encoder | Fresh capture at startup / restored 60 FPS | Receiver FPS in regular windows | RGB error | Result |
|---|---|---|---|---|
| Browser, auto-vp9 | 59.95 / 59.93 | 59.98–60.07 | not sampled | pass |
| Browser, qsv-h264 | 59.92 / 59.73 | 59.92–60.50 | not sampled | pass |
| Spout 1080p, software-h264 | 59.93 / n/a | 59.87–60.06 | 2/255 | pass |
| Spout 360p, software-h264 | 60.20 / n/a | 59.90–59.97 | 2/255 | pass |

Both browser cases passed startup, 60→30→60 controls, bitrate changes, playback pause/seek/resume, window resize/restore, viewer reload, transport refresh, signaling loss, and shutdown with a paused source. At the 30-FPS setting, QSV captured 30.06/s and VP9 29.95/s. The source browser presented approximately 60/s during the restored-rate measurements.

The HD software-color workflow also passed native source loss/restart and shutdown during an observed stalled WebSocket handshake. SD passed steady delivery, viewer reload, and transport refresh. Both retained the software `H264 Encoder MFT`, with 2/255 color error initially and after recovery.

Quality observations: the regular receiver measurement windows recorded zero packet loss and zero freezes. VP9 and both software-color runs recorded zero decoder drops. QSV recorded four decoder drops in the window following runtime video controls, and zero in its other regular windows; this is not a claim of drop-free transitions. Forced source outages are intentionally excluded from these steady/recovery-window totals.

Chromium: `145.0.7632.6`. Browser reference clip SHA256: `a6f0f318adce19a02cc3d8df5577dd0668056d82a776c203eb4f51f7036a3fb6`.

Artifacts under ignored `native-qt/qa/reports/`:

- Browser, auto-vp9: `capture-color-timestamp-window/fc88e6ac-68d4-4052-97ef-dae6126010ee/results.json`; shutdown 329 ms, exit 0, no remaining external encoders.
- Browser, qsv-h264: `capture-color-timestamp-window/fc88e6ac-68d4-4052-97ef-dae6126010ee/results.json`; shutdown 328 ms, exit 0, no remaining external encoders.
- Spout 1080p, software-h264: `capture-color-final-hd/5d3f2914-1e46-4a5b-97ac-17a55ee61e5f/results.json`; shutdown 419 ms, exit 0, no remaining external encoders.
- Spout 360p, software-h264: `capture-color-final-sd/03d7c920-fe39-4d49-a6a0-9ec63a5c37d6/results.json`; shutdown 440 ms, exit 0, no remaining external encoders.

The failed repeat before source-timestamp pacing is retained at `capture-color-final-window/dad264e9-6ff0-4a97-8149-f47e9ca1ff8e/results.json` (publisher `cdf257098d901133bb7810c7238176bf5a825dd293cb8d352e3a2437fb37bcbc`). Its VP9 return-to-60 capture result was 52.11/s and its workflow failed the strict check. The final results above supersede that failure.

Build and component gates passed separately: `WindowCaptureTest`, `AlphaFramePairerTest`, and `RuntimeRecoveryPolicyTest`; log `capture-color-timestamp-gates.txt`. Node syntax and Git whitespace gates also passed. These are gates, not substitutes for the end-to-end testing above.

Independent bitstream artifacts: `color-original.h264`, `color-patched.h264`, `color-reference.h264`, `color-no-vui-reference.h264`, `color-no-vui-patched.h264`, `color-metadata-trace.txt`, and matching `color-original.framemd5` / `color-patched.framemd5`. Complete access-unit files can differ from FFmpeg in start-code length; SPS bytes and all non-SPS payloads were compared separately.
