# Game Capture 0.2.63 Windows qualification

Qualification performed October 14-15, 2026 on Windows with Intel graphics and
an NVIDIA TITAN RTX. The release provides a setup EXE, portable EXE, portable ZIP,
FFmpeg source/build information and checksums, with both versioned and stable
download filenames.

## Frozen package identity

The signed Windows x64 application was built from commit
`f2b0823d736ba5848c3bfc3a82300a5efc38bcb1`. Documentation added after packaging
does not change this executable or the package being qualified.

| Item | SHA-256 |
| --- | --- |
| Packaged `game-capture.exe` | `096a25c273198478ec6c0b123fac7ebbce0866e1272e2316b9d05cf1a970e2ef` |
| `release-artifact-manifest.json` | `cdd98db08b8cd2236ded463a804b034104d70cd3eda5685a3029baf3ee10a7fa` |
| Native source snapshot, 281 files | `d25ed5e6a14bd16f2080ad078fd0fef4da330a217f37edfc406c3af6bbdedfbb` |
| Setup EXE | `b2163aaabe186757c8358153d6a968ad3b7e9373a68dab3ca50112ad22ef8c63` |
| Portable EXE | `0a319a8bd8ab6ceb775d2311bed7a2befe5118a50ff8009027ed94ea4a9eff7d` |
| Portable ZIP | `142912d20c38cb4188dacb824e6d55f6cae0e22530b389e086d19ee91aabdd31` |
| FFmpeg source-info ZIP | `69c1bc79578333fed757338063340f035c984479c3e7c50414d18c6dca71b32e` |

The source snapshot covers tracked and nonignored untracked files under
`native-qt`; it is not a reproducible-build claim. The package manifest records
one dirty entry because an unrelated, untracked historical installer report
was present outside that scope. Tracked application source was clean.

## Packaged application workflows

The final full readiness run, `20261014-233631`, completed with an overall
**PASS** and exit code 0. Workloads were run sequentially against the signed
package, with its bundled Qt plugins and FFmpeg. Completed workflows include:

- Actual GUI H.264/VP9 publishing and browser playback, Start/Stop, source
  selection/removal, FFmpeg probe stalls/timeouts and stale results,
  responsiveness, desktop sounds, tray/accessibility behavior and shutdown.
- Capture with the optional Windows border interface unavailable, including
  playback and safe avoidance of unsupported calls.
- Three deterministic local API fuzz runs, malformed/oversized and incomplete
  concurrent requests, bounded connections and subsequent health recovery.
- MCP control of the actual application, quoted source names, live browser
  playback under request pressure, credentials/Origin/URL checks and cleanup
  of owned processes.
- Update-footer behavior using real GitHub HTTPS and the default browser,
  bundled TLS, caching, network/response failures, timeouts and shutdown.
- Streaming matrix, viewer refresh, duplicate stream-ID handling, remote
  resolution/bitrate controls, restored 4 Mbps defaults and ICE restart.
- Automatic, host-only, STUN and TURN connectivity and settings persistence.
- Edge, automated Firefox and official Firefox signaling: stale generation,
  candidate and session rejection, relay/direct media, delayed peer recovery,
  transport reset with audio/video/alpha, peer removal/readdition and natural
  shutdown with active media. All three browser paths passed in the final run.
- Control Center in all three browsers: advancing video, resolution/bitrate
  controls, mute/unmute, statistics and absence of an unintended microphone.
- Dual-quality viewer roles, churn, initialization fuzz and room behavior.
- Actual OBS room-alpha playback and opaque/half-transparent color stability.
  The full-alpha wrapper currently runs these two cases; its older readiness
  heading saying "seven-case" is not a claim of seven tested cases.
- Bitrate preset sessions at 3, 6, 12 and 20 Mbps. Auto hardware MFT and strict
  software MFT publishing passed. Strict NVIDIA `h264_nvenc` and Intel
  `h264_qsv` publishing passed, including hardware selection verification.
  Requesting unsupported NVIDIA VP9 visibly failed instead of silently
  selecting a different encoder category.

The dual-quality soak passed after 1,820 seconds: four batches containing
88 + 88 + 88 + 57 viewer join/decode/leave cycles, all passing on the first
attempt (321 cycles total). The high-quality scene remained available while
low-quality viewers joined and left. Its report is
`dual-quality-soak-2026-10-15T04-45-02-571Z.md`.

The regular-viewer soak passed after 1,807 seconds: five batches containing
24 + 24 + 24 + 24 + 5 reconnect/playback cycles, all passing on the first
attempt (101 cycles total), with 15-second playback holds. Its report is
`soak-2026-10-15T05-15-09-694Z.md`. Both required 30-minute soaks ran at full
duration against the same signed executable; neither used a retry.
All process identities recorded during the final batch had exited after
readiness, and no process from the qualified package directory remained.

Build, all 21 CTest suites, analyzer/artifact contracts and installer
construction passed as separate gates; they are not substitutes for these
actual application workflows. The synthetic capture fixture updates more slowly
than a game, so connection/recovery soaks do not establish 60 unique frames
per second under a demanding game workload.

## VP9 alpha startup correction found during qualification

Actual OBS playback exposed a color change between the first opaque blue
frame and later frames: approximately `(28, 98, 241)` to `(32, 95, 254)`.
The half-transparent case could also fail. An unchanged repeat passed, then
another repeat reproduced both failures; that intermittent pass was not
treated as a resolution.

A constant-color encoder characterization isolated the change to cold-start
VP9 CBR quantization. Commit `f2b0823` limits the maximum quantizer to 56 for
the synchronized all-keyframe VP9 primary/mask path. It retains the existing
intra-frame rate budget, adds no buffered frames and leaves H.264 and ordinary
VP9 defaults unchanged. Pixel tolerances and first-useful-frame checks were
not relaxed.

Three consecutive actual OBS runs against the final signed package passed
both opaque and half-transparent cases, followed by both cases passing again
in full readiness: eight successful cases across four runs. In the first
fixed opaque run, mean maximum-channel error was about 1.03 and maximum pixel
delta was 6, below the existing limits of 3 and 16. Publisher, OBS plugin and
Spout fixture hashes stayed fixed across those runs.

An eight-second synthetic-motion encoder characterization measured:

| Format / target | Original kbps | Bounded-quantizer kbps |
| --- | ---: | ---: |
| 640x360 at 30 fps / 1,000 kbps | 1,016.8 | 1,016.8 |
| 1280x720 at 60 fps / 4,000 kbps | 4,072.0 | 4,063.3 |
| 1920x1080 at 60 fps / 4,000 kbps | 4,062.4 | 4,196.7 |

This is an encoder diagnostic, not an application performance benchmark.
The quality floor increased measured bitrate by about 3.3% in the 1080p
synthetic case; it does not guarantee a hard network bitrate ceiling.

Qualification also corrected stale automation expectations for the intended
RED-enabled reset default and 4 Mbps bitrate reset, and stabilized genuine
GUI interactions by waiting for viewport geometry and confirming the selected
option. Earlier failures, including a transient Firefox TURN prerequisite
failure in an earlier candidate run, are retained in local evidence.

## Evidence and limits

Local evidence is retained under `native-qt/qa/reports`, including the final
`release-readiness-20261014-233631.md`, the
`release-full-alpha-20261014-233631/manifest.json`, and
`release-0.2.63/alpha-fixed-{1,2,3}/manifest.json` reports. Raw session logs and
automation credentials are not published with this summary.

The preceding [AMD/streaming investigation](amd-streaming-validation-2026-10-14.md)
and [encoding/fault measurements](encoding-defaults-validation-2026-10-14.md)
retain their original workload and artifact scope. They cover additional
high-resolution, slow-CPU and failure scenarios and are not all represented
as reruns against this final signed package.

- Chromium WHIP playback can still pause under packet loss plus jitter;
  disabling audio RED or increasing playback buffering was not a demonstrated
  fix. Bounded NACK/RTX repair does not eliminate all receiver stalls.
- MediaMTX-to-FFmpeg RTSP reception can produce duplicate timestamps near
  startup. A private receiver warmup experiment is not a publisher fix.
- Physical AMD GPU/driver qualification, clean-machine installation, installed
  version upgrade and overnight endurance remain outstanding. This host has
  no AMD GPU. Installer construction alone does not validate those workflows.
- The application and installer carry a Social Stream Ninja signature. Windows
  on this host reports an untrusted certificate root; signing does not imply
  a publicly trusted chain or established SmartScreen reputation.

Stable aliases are byte-identical to their versioned assets. Published asset
size and SHA-256 verification is required before making the release public;
`SHA256SUMS.txt` accompanies the downloads.
