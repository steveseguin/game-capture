# Mac beta qualification — October 16, 2026

The Apple Silicon release remains **experimental**. This work resolves the earlier missing-RTMP-audio finding and extends real packaged application coverage. It does not establish full production readiness or Windows feature parity.

## Artifact and environment

- Release: [macOS 0.2.62 Beta 1](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.62-beta.1).
- Signed ZIP SHA-256: `2e51db7ef109e01d7d14b6787fd8d7a6b8bd14e05e725d7185e0cf0fbdec306b`.
- Extracted executable SHA-256: `25b4b113702c82a46056095350bbb01c3567c50998fecc066b49407335220c43`.
- Apple M1, 8 GiB RAM, macOS 26.4.1. No released application binary, bundled dependency, signing identity or release asset changed. Candidate source changes are identified separately below.
- External-output workflows use an owned OBS virtual-camera fixture, BlackHole stereo input, a local MediaMTX 1.21.2 server, and independent FFmpeg receivers. They do not exercise physical cameras/microphones or remote production services.

## RTMP finding resolved

The original receiver recording declared an AAC stream but contained no audio packets. A simultaneous comparison isolated the failure to FFmpeg 7.1.1's RTSP stream-copy recorder:

| Receiver path, same signed publisher | Recorded AAC packets in 12 seconds | Decoded stereo |
| --- | ---: | --- |
| FFmpeg 7.1.1 RTSP, original recording options | 0 | Unavailable |
| FFmpeg 7.1.1 direct RTMP | 563 | Correct |
| FFmpeg 9.0.2 RTSP | 563 | Correct |
| FFmpeg 7.1.1 RTSP, audio-only `-copyinkf:a` | 563 | Correct |

The failing receiver actually read 565 AAC packets. A separate packet probe found 188 audio packets without the key flag. [FFmpeg 7.1.1's stream-copy startup code](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/fftools/ffmpeg_mux.c) rejects initial packets without that flag unless initial non-key packets are allowed. Applying the documented [`-copyinkf`](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options) option to **audio only** preserves these valid AAC packets while retaining the video keyframe requirement.

Both Mac mux recording harnesses now use that audio-only option. Packet presence, timestamp, decoded-frame, channel separation, silence and lifecycle assertions are unchanged. The publishing harness also supports direct RTMP reception with `--protocols=rtmp --receiver-protocol=rtmp`, and records the receiver version and probe hash.

This was a recording-path failure, not evidence that the app stopped sending RTMP audio. The original failed runs are retained. The release notes and website warning were corrected without replacing the beta download.

## Completed packaged workflows

| Workflow | Encoders | Result |
| --- | --- | --- |
| RTMP publication → direct RTMP reception | VT, x264 | Passed |
| RTMP publication → RTSP reception | VT, x264 | Passed |
| Encrypted SRT publication → RTSP reception | VT, x264 | Passed |
| RTSP TCP and RTSP UDP publication → RTSP reception | VT, x264 | Passed |
| Direct UDP and RIST publication/reception | VT, x264 | Passed |
| Window suspension/restoration with existing and late receivers | RTMP/VT, SRT/x264 | Passed |
| 720p60 window/application-audio, new per-interval audio observer | VT, x264; 30 seconds each plus controls | Passed |

The fourteen camera/input publishing cases check moving H.264 video and stereo AAC, static video and silence, resumption, VT server-restart recovery where applicable or late reception, and clean publisher/helper shutdown. The window-suspension cases additionally verify decoded background/image content and audio during hide/restore: approximately 29 seconds of existing-viewer audio and 13 seconds of late-viewer audio, with no silent 100 ms blocks or clipped samples.

The window endurance harness now samples three seconds of decoded audio during **every ten-second video interval**, checking stereo, expected source tones and exclusion of unrelated application audio. Raw observations remain hash-bound in compressed evidence. This extends the earlier end-only audio check; it is not continuous audio monitoring or calibrated lip-sync measurement.

### Earlier endurance finding (historical checkpoint)

The thirty-minute VT/application-audio attempt failed during its 72nd ten-second interval, after 710 seconds of completed observations. The receiver rejected a reversed/corrupt fixture identity or excessive identity gap. All 71 completed intervals had passed video cadence and sampled stereo/isolation checks, but **the complete workflow failed** and did not reach its subsequent controls. Encoder failures, timeouts and send failures remained zero; that does not explain or waive the received-output failure.

The original runner did not retain the rejected interval's pixels. It now saves rejected frame images and scanlines, source identities, presentation observations, audio, and before/after diagnostics in a hash-bound compressed failure artifact before exiting. Acceptance thresholds are unchanged. An optional `--fixture-start-id` allows replaying a selected identity range.

A three-minute replay starting at identity 42000 passed all eighteen intervals and the subsequent functional controls. That result does not reproduce or resolve the original failure. A separate fifteen-minute reproduction then passed all ninety intervals and subsequent functional controls: 59.595–60.091 distinct decoded fps, 17 ms worst interval p95 frame gap, and zero encode failures/timeouts/send failures. All 2,700 sampled audio spectra were retained, and the compressed payload hashes and summary values were independently checked. Publisher RSS ranged from 87.2 to 117.0 MiB. **The original failure remained unresolved at this checkpoint**, despite these later passes; the continuous-audio follow-up is recorded below.

The failure recorder was then exercised with an explicitly modified diagnostic fixture that reverses its source identity once. The signed app delivered that reversal, the runner rejected `848 → 649` at the intended threshold, and the saved 1280×720 image visibly shows fixture 649. Source identities, scanline, audio and diagnostics were retained and their hashes checked. This is an expected negative control, not another application defect or a passing endurance run.

## Continuous audio, identity decoding and download follow-up

The unchanged signed beta completed a **thirty-minute VT/application-audio workflow**: all 180 video intervals, 18,212 consecutive 100 ms received-audio windows, and the subsequent live controls, static image, resize, late viewer and shutdown passed. The observer covered 1,821.2 seconds of PCM against 1,821.225 seconds of wall time, with no missing clock windows, silence, clipping, channel/isolation failures or invalid samples. Interval evidence hashes and stored summaries were independently checked.

The corrected-reader **thirty-minute x264/application-audio workflow also passed** all 180 video intervals and subsequent controls, resize, late viewing and expected source closure. It covered 18,229 consecutive 100 ms audio windows: 1,822.9 seconds of PCM against 1,822.919 seconds of wall time, with no missing clock windows or content failures. Received cadence ranged from 59.684 to 60.093 distinct fps; worst interval p95 frame gap was 17 ms. Publisher RSS ranged from 94.2 to 127.0 MiB. Independent verification confirmed every interval hash and summary. Its supplementary recording also had clean decoded content (18,203 inspected windows), but failed the strict recorder-clock check: 1,821.42 decoded seconds against 1,823.584 wall seconds, with a maximum 15 ms PTS gap.

A separate early qualification failed on one 100 ms tone window during a video freeze. Receiver audio-concealment counters increased despite zero reported packet loss. That brief transient remains unexplained. Subsequent recordings preserve raw PCM for rejected windows and periodic receiver counters. A deliberate 700 ms source dropout was rejected by the continuous observer even when the older three-second audio sample passed.

The supplementary browser audio recorder is **not a gapless timing reference**. Its thirty-minute file decoded to 1,819.32 seconds of PCM against 1,821.798 seconds of recording wall time; the strict offline recording-clock check failed. Its 18,182 inspected audio windows contained no silence, clipping or tone failures. These recording limitations are retained separately from the continuous received-playback evidence; they do not identify a publisher defect.

### Reproduced identity rejection was cursor occlusion

The first continuous x264 attempt reproduced an identity rejection in its 400–410-second interval. Saved pixels show the captured mouse pointer covering the middle-row barcode sample: the reader reported 27426 while the visible source label and unobscured rows showed **25378**. The cursor outline changed bit 11 from black to gray (177), above the old reader's threshold. The attempt remains failed and was intentionally stopped after diagnosis; it is not counted as completed endurance.

The reader now samples three separated rows and requires two complete identities to agree. Frame ordering, maximum-step and cadence requirements remain unchanged; an ambiguous read is rejected. It retains disagreement images as well as rejected-frame images. An offline regression gate uses the actual received PNG. In real signed-app controls, a small one-row overlay produced **1,570 recovered frames** during a passing sixty-second VT/audio workflow, while a deliberate whole-frame reversal was still rejected (`882 → 683`, all three rows agreed on 683).

The passing thirty-minute x264 run also retained one natural cursor occlusion: rows decoded `[25479, 9095, 9095]`, while the visible label was 9095. The top-row bit-14 sample was gray (154); the other two were black. The accepted sequence remained 9094 → 9095 → 9096. Offline review also found no rejected identity step across any of the 179 interval boundaries in either completed endurance run; that is not coverage of pixels between observation intervals.

This explains the reproduced x264 rejection. The older VT failure did not retain its rejected pixels, so the same cause cannot be established retrospectively.

### Calibrated recorded-media timing

The A/V workflow records a generated canvas/audio reference and the received stream, matching numbered visual flashes to audio pulses. The first analyzer incorrectly treated decoded audio as a gapless timeline, producing a false drift reading. Its correction maps each detected sample through its own decoded frame timestamp. The original analysis remains preserved.

Offline controls measured identical media at 0 ms and deliberate audio shifts at exactly +150 ms and −150 ms; both shifted cases were rejected. Corrected analysis of the initial sixty-second signed VT recording matched 28 pulses, with additional received skew from **−32 to +23.5 ms**, median −19.5 ms, within the preset 50 ms limit. This measures paired events in recorded media, not physical display/speaker latency, HTML/OBS presentation, or continuous recording coverage between pulses. The long-run results below extend this initial calibration.

The subsequent signed **VT 720p60 long-run comparison passed**. Initial and final recording starts were 1,817.878 seconds apart, with the same publisher active throughout. The two sixty-second phases matched 28 and 29 pulses. Additional skew ranged from −30.5 to +41.5 ms initially and −43.5 to −17 ms finally; median offset changed from −12 to −28 ms, a −16 ms drift within the preset 30 ms limit. Every paired event stayed within the preset 50 ms skew limit. All 372 periodic publisher/receiver health samples and clean shutdown passed. This qualifies the bounded start/end comparison, not continuous A/V measurements during the hold. The x264 comparison failed as described below.

A second offline calibration isolates the drift decision: deliberate +40 ms and −40 ms changes between two copied phases were measured correctly and rejected, while each phase individually remained inside the 50 ms skew limit. These controls use recorded media with no claimed elapsed application run. They ran sequentially at lower CPU priority during part of the unrecorded x264 hold; that workload is retained in its evidence.

The equivalent signed **x264 long-run comparison failed**. Its initial 28 paired events had additional skew from −17.5 to +34.5 ms (median −0.5 ms). The final 28 had −60.5 to −36.5 ms (median −45.25 ms). The **−44.75 ms median drift exceeded the 30 ms limit**, and some final events exceeded the 50 ms skew limit. All 372 health observations, source/receiver media-content checks and publisher shutdown passed; those successes do not override the timing failure. This remains a production blocker.

Offline review of receiver statistics found video jitter-buffer delay increasing from approximately 61 to 111 ms between phases, while audio increased from approximately 36 to 37 ms. These are differences of cumulative delay divided by emitted-count differences, following the [WebRTC statistics definition](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-jitterbufferdelay). This is consistent with the measured offset change but does not establish whether the cause is the publisher clock, receiver synchronization or recording behavior. No timing limit was relaxed and the failed artifacts are retained.

A separate native-backend diagnostic delivered 5,671 callbacks of 512 stereo frames at 48 kHz. The app currently truncates each callback duration, accumulating approximately 11.25 ms of timestamp loss per thirty minutes at that size. That is insufficient to explain the complete measured drift. A Mac-only candidate now carries the fractional duration between callbacks and clears it when the capture clock re-anchors. The Windows calculation is unchanged. Two-hour arithmetic checks across several callback sizes, variable-size/reset cases and both readiness/integrated Mac application compiler gates passed. These are gates only. This candidate is **not in the released binary and has not passed packaged application testing**; a new signed package and both long-run timing workflows are required. The machine has less than 0.5 GiB of free disk, limiting further package construction without additional space.

### Four-viewer room follow-up

Both signed VT and x264 workflows passed a thirty-second four-viewer load followed by the complete room control/rejoin workflow. Each run had three 720p30 HQ scene receivers and one independent 360p30 x264 director preview. Each encoder passed 1,264 consecutive 100 ms PCM windows across the four receivers, with stereo/channel/isolation checks and advancing audio packets. Video ranged from 29.897–29.997 fps for VT and 29.890–29.996 fps for x264. Compressed raw observations and summary hashes were independently checked. This short load is not sustained room endurance, calibrated A/V timing or physical playback.

### 1080p observer qualification

An installed-Chrome 1080p60 moving-detail attempt rejected disagreeing barcode rows during its initial picture check. The presentation observer previously sampled the live video element three times. It now freezes one `VideoFrame`, uses that image for all rows and retained failure pixels, and reports callback errors explicitly. That removed initial row disagreements in subsequent attempts; the original attempt did not save rejected pixels and is retained as failed.

A subsequent three-minute attempt decoded about 60 fps according to Chrome counters, but simultaneous decoded/presentation pixel observers processed only about 19 fps and the workflow failed. A single-crop optimization improved observed throughput, but duplicate pixel observers remained below target; that diagnostic attempt was intentionally stopped through the owned publisher's Quit command. The runner now uses one decoded-content observer plus presentation callback timing during performance intervals. Initial and functional-control presentation checks still inspect pixels. Content, frame-order, cadence, dimension and audio requirements remain unchanged; presentation timing alone cannot satisfy a content assertion. These diagnostic attempts do not qualify 1080p output.

With that measurement correction, both encoders completed all three-minute 1080p60/8 Mbps moving-detail intervals and subsequent functional controls, but **both failed sustained performance**. VT missed the target in 8/18 intervals (54.518–59.930 received fps); x264 missed in 11/18 (53.962–58.873 fps). The threshold remains 95% of requested/source cadence. All 1,833 VT and 1,836 x264 continuous audio windows passed. In a failing VT interval, publisher dropped frames rose from 10 to 40 while receiver decoding also slowed, so this is not explained solely by observer throughput. Host snapshots show substantial remote-desktop CPU activity; the connection was left intact. Confirm this workload in a clean local session or with an independent receiver machine before attributing a cause or claiming 1080p60 qualification. The earlier 720p60 endurance passes do not qualify this heavier workload.

### Real browser download and replacement

Installed desktop Chrome downloaded the published ZIP with its original `com.apple.quarantine` attribute, and the archive hash matched the signed release. Extraction preserved quarantine. macOS presented the normal downloaded-app **Open** prompt, including its successful malicious-software check, on both launches. Both launches used App Translocation; executable hashes and deep signatures matched the delivered app. GUI controls responded, capture stayed off, a private preference persisted across same-version archive replacement, and shutdown/discovery cleanup passed. The first extracted app was retained before replacement.

The preceding headless-browser attempt had no quarantine attribute and was rejected. A subsequent launch-harness attempt timed out at the normal Open prompt; that prompt was cancelled and the complete workflow repeated with a narrowly scoped normal-Open action. No quarantine removal, trust-store change or untrusted-app override was used. This existing development Mac does not establish fresh-machine permissions, minimum-OS behavior or a cross-version upgrade.

### Integration with current Windows main

Windows [0.2.64 has its own packaged qualification](release-0.2.64-windows-validation.md). A separate `macos-main-integration` branch reconciles the experimental Mac source with that newer main branch, preserving its README, version and AMF changes. The Mac's longer WHIP gathering allowance is confined to macOS so Windows retains its existing ten-second limit. All 27 changed Mac/shared translation units passed an isolated arm64 compiler gate using existing dependency headers; one file first required its generated Qt meta-object include. This was not a linked package build. Source reconciliation and secret/compiler checks are gates; this integrated source is not a newly qualified package. Published Mac and Windows assets remain unchanged by this work.

## Evidence identifiers

Raw recordings, logs, private local-control files and interval payloads remain in local `native-qt/qa/reports/`; they are not published wholesale. The principal report identifiers are:

- Receiver comparison: `macos-rtmp-investigation-2026-10-16/92641233-5cbc-48d6-9af9-16b636801738`.
- RTMP via RTSP: `macos-rtmp-corrected-recorder/62976911-b577-4f9d-8d00-3689c78dde77`.
- Direct RTMP: `macos-rtmp-direct-reception/2ac8ad5e-5a94-4687-a148-87494b1cf92a`.
- Other mux outputs: `macos-signed-mux-qualification/a0049c74-56ce-4135-9256-d8705a68bacb`.
- Window suspension: `macos-signed-mux-audio-suspension/7ea5e627-cf6c-4ae2-b7de-641ee106c73c` and `858dc112-cabf-4c22-a33f-2eed2730ad0d`.
- Per-interval audio validation: `macos-signed-audio-intervals/1f4c0e9f-9aef-43fc-8244-0e4938668d00`.
- Failed long VT/audio run: `macos-signed-vt-audio-endurance/e33f0a5b-8b15-414e-b9bf-e7c903887817`.
- Three-minute identity replay: `macos-signed-identity-replay/abd735ac-1a59-40fe-9726-2988cb9cd645`.
- Fifteen-minute reproduction: `macos-signed-vt-audio-reproduction/07f4dfc6-0abb-465f-a2da-940ed9abaa08`.
- Expected diagnostic rejection: `macos-observer-negative-control/003f3da2-e843-4432-b5c6-8434912ebbd7`.
- Thirty-minute corrected-reader x264: `macos-signed-x264-three-row-endurance/0ca9aeae-7f50-4f8a-a904-9137a888566d`.
- Thirty-minute continuous VT: `macos-signed-vt-continuous-endurance/fbad1cc4-dd75-48a2-a76a-c393b269762e`.
- Brief audio-concealment transient: `macos-continuous-audio-qualification/ab8ac562-43c3-4824-b836-55ce28250c33`.
- Cursor-obscured x264 rejection: `macos-signed-x264-continuous-endurance/59e815f0-2684-478f-b0f9-c6cc5217d9d6`.
- Corrected-reader occlusion control: `macos-three-row-occlusion-control/bb44bb85-a5d1-45db-97e6-edf15baf33ff`.
- Corrected-reader reversal rejection: `macos-three-row-negative-control/af34cbb0-8f8a-453e-840f-6d522eddea9b`.
- A/V initial recording: `macos-signed-av-calibration/828e3929-449a-4989-9e60-a29d8772132a`; corrected analysis: `macos-av-analysis-correction/5432f129-8d8b-46a7-9f00-56799b53482c`.
- Long-run VT A/V comparison: `macos-signed-av-drift/93259a69-8466-41d8-8577-e750d56391fe`.
- Offline drift-specific calibration: `macos-av-drift-calibration/51150480-7c46-4109-b7af-be4747b7edd0`.
- Offline A/V calibration: `macos-av-analyzer-calibration/3ac342ee-5f76-46b8-ad78-21c27c3842e4`.
- Fractional-clock arithmetic/compiler gate: `macos-sample-clock-gate/80ca03c1-e496-46b6-972e-70b066ef2689`; integrated application compile gate: `macos-integrated-clock-compile-gate/269fbead-c043-42bf-9725-7d6d422068d3`.
- Failed 1080p60 workload with corrected observer: `macos-signed-1080p-chrome-detail/b0be8865-743a-4ca4-b71e-1812a1ae5d94`. Earlier diagnostic attempts: `d56a3830-a395-4526-88d5-5d2c8d2c43fa`, `f49a8b2d-c169-4531-81c3-203fbaf67e4c`, and intentionally stopped `3bd0d2ee-8519-443d-9f8c-77d8e39b91ea` in the same category.
- Four-viewer room qualification: `macos-signed-room-four-viewer-qualification/5df2b76e-12c9-412a-bf0d-f13a530142d1`.
- Native callback diagnostic: `macos-audio-clock-diagnostic/56ecf122-7396-4bce-b393-643b060b69ab`.
- Failed x264 long A/V comparison: `macos-signed-av-drift/9ffbef4c-c15b-4f4e-b6c8-f9d266b77fc9`.
- Chrome download: `macos-desktop-browser-download/ee0a52ea-37b8-4642-87cd-47f2dc6f255e`.
- Quarantined replacement: `macos-quarantined-replacement-launch/2eeb89a2-7875-4aea-a9f4-9c9ae4b08b6b`.

## Reproduction

The [QA changes](https://github.com/steveseguin/game-capture/tree/macos-production-readiness) are on `macos-production-readiness`, based on the beta tag; the Mac runtime remains separate from Windows production. Use that branch, the signed, extracted beta app and compiled fixture helpers; choose a fresh report category for each attempt. Reports receive a unique identifier automatically. For the window/audio endurance workflow on this machine:

```sh
node native-qt/e2e/macos-window-publish.js \
  '--app=/path/to/Game Capture.app' \
  --reports=native-qt/qa/reports/macos-window-audio-repeat \
  --encoder=videotoolbox --performance-seconds=1800 \
  --audio=selected-window --continuous-audio=true --compact-performance-report=true \
  --source-ui-helper=native-qt/build-macos-arm64/bin/macos-ui-control
```

Use `--encoder=x264` for software encoding. A targeted identity replay additionally accepts `--fixture-start-id=42000`; shortening that replay is diagnostic only. The source helper explicitly activates the owned fixture browser. Keep other capture workflows stopped during performance observation.

The recorded-media drift workflow keeps one publisher live between its initial and final samples. Repeat separately for `videotoolbox` and `x264`:

```sh
node native-qt/e2e/macos-av-sync.js \
  '--app=/path/to/Game Capture.app' \
  --reports=native-qt/qa/reports/macos-av-drift-repeat \
  --encoder=videotoolbox --seconds=60 --hold-seconds=1740 \
  --width=1280 --height=720 --fps=60 --bitrate-kbps=4000 \
  --source-ui-helper=native-qt/build-macos-arm64/bin/macos-ui-control
```

The expanded room runner accepts `--extra-scenes=2 --performance-seconds=900 --compact-performance-report=true --continuous-audio=true`, in addition to its explicit app, camera fixture, audio fixture and report arguments. That observes four actual browser receivers: one 360p preview and three 720p scene views at 30 fps. With `--continuous-audio=true`, it retains consecutive received PCM windows and advancing packet/concealment counters for every receiver, plus the existing periodic spectra. This does not measure calibrated A/V drift. Both encoders passed the initial thirty-second four-viewer workflow and subsequent controls; the fifteen-minute expansion remains pending.

For Windows integration regression, build and freeze a **new package from the integrated candidate**, record its source revision and artifact-manifest digest, and pass that package to the existing release-readiness workflow. Reusing the frozen Windows 0.2.64 production package would not qualify these shared changes. The GitHub workflows require a prepared Windows self-hosted runner; none was registered when checked.

## Remaining production work

- Investigate any recurrence of the early audio-concealment transient with the new retained PCM/counters. Both thirty-minute VT and x264 workflows now passed. The original VT identity rejection has insufficient saved evidence to establish its cause retrospectively.
- Fresh-machine download/launch and permissions, cross-version upgrade, minimum macOS 14.2 and another Apple Silicon Mac. Quarantined Chrome download/launch and same-version replacement passed on this existing machine.
- Physical device hotplug/busy recovery, permission denial/revocation, sleep/wake and display/audio-device changes.
- Resolve the failed x264 long-run A/V comparison and complete expanded room/workload coverage. VT passed its long-run recorded-media skew/drift limits. The 1080p60 moving-detail workload failed sustained delivery with both encoders on this cohosted M1 setup; it needs clean-session or independent-receiver confirmation. Broader sustained gameplay and receiver/network coverage remain open.
- Remote services and trusted RTMPS, plus remaining advanced-feature qualification. Local protocol success is not a production-service interoperability claim.
- Packaged Windows regression of the port's shared-code changes before those changes enter a future Windows release. The independently qualified Windows v0.2.64 production release is unchanged by this work.

Syntax, source/hash checks, signing verification and secret scans are separate gates. The media workflows above run the shipped app and verify actual received output.
