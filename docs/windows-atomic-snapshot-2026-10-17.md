# Atomic diagnostics snapshot fix and teardown follow-up — 2026-10-17

The Windows shutdown-snapshot failure is fixed in repeated packaged workflows. Mac snapshot workflows also pass on the rebuilt source. The x264 track-close counter gate remains failed. Public release assets are unchanged; this is qualification evidence, not a production release.

## Windows failure and fix

Two packaged runs failed ordinary shutdown snapshot replacement while a concurrent reader was active: [39080791998](https://github.com/steveseguin/game-capture/actions/runs/39080791998) and [39081577216](https://github.com/steveseguin/game-capture/actions/runs/39081577216). The instrumented second run captured Qt `RenameError` (10), “Access is denied,” during commit. Deliberately locked snapshots remained intact, and video workflows passed in both runs.

[Native API probe 39081743377](https://github.com/steveseguin/game-capture/actions/runs/39081743377) reproduced replacement denial while the target reader was open, including delete-sharing readers, then success after closure. This is a gate, not application testing. Qt 6.9.3's [temporary-file engine](https://github.com/qt/qtbase/blob/v6.9.3/src/corelib/io/qtemporaryfile.cpp) uses its [Windows native rename helper](https://github.com/qt/qtbase/blob/v6.9.3/src/corelib/io/qfsfileengine_win.cpp) for this replacement path.

The application now retries Windows atomic-commit rename failures within a 500 ms window, with 5 ms pauses. Open/write errors still fail immediately. A persistent rename failure preserves the existing snapshot. Normal Mac replacement remains a single attempt. The application logs the failed stage and Qt error so future failures retain actionable evidence.

[Fixed packaged run 39081905958](https://github.com/steveseguin/game-capture/actions/runs/39081905958), source `8188f88c961569937e2fdb0c416bbb0a535c7d24`, passed:

- **70/70 assertions:** ten ordinary GUI shutdowns replaced their snapshots; ten deliberately locked snapshots remained intact; all twenty processes exited normally and removed discovery.
- **115,416 concurrent reads, zero incomplete JSON.**
- Real software H.264 Windows Graphics Capture: moving picture, static pacing, resize, late viewing and expected source-loss exit 3. Received output remained 640×360/H.264 with zero identity-read failures. Moving/resized/late observations contained 174/119/88 distinct fixture images; the static phase contained one repeated identity.

Windows executable SHA-256: `8d8d5a6c39fa23d52cde940b61736bb3cedcf2ad55d915ba010d2bd213b0494b`; ZIP SHA-256: `ea2167d8dfa3b8b01df87de1546cc7782200195db1442a930e307ff151e1ce06`; payload manifest SHA-256: `1d007c6b747c7cd441620a194f43268a7ff5591791867d168adb7e360414e741`. The extracted ZIP ran on an interactive Windows Server 2022 VM using software H264 Encoder MFT. Installer/portable launches, physical GPU/audio/devices and consumer Windows hosts remain outside this result.

## Mac snapshot preservation

All 39 Mac application units were rebuilt from the same `8188f88` source and Developer ID signed. Those are gates. The resulting local bundle, executable SHA-256 `9f8f95c8c14d3b050ea61720fb1ed17a58b426f2a20479858af78c769b51dbfd`, then passed four actual GUI shutdown cases: two successful snapshot replacements with 14,039 concurrent reads and no incomplete JSON, and two refused directory destinations whose sentinel contents remained intact. All four exits were 0 and removed discovery.

This bundle is not notarized or released. These checks cover diagnostics/shutdown; they do not requalify all media workflows on this new binary.

## Complete x264 departure/rejoin observation

The earlier diagnostic bundle (`3a0a17c`, executable `18b97911…`) completed five two-viewer Hang Up/rejoin cycles, all surviving-viewer picture/stereo checks, a final fresh viewer, and cleanup. Each surviving-viewer audio observation had 30 passing stereo windows; video identities advanced in every phase. Final peers were zero, publisher exit was 0, and discovery was removed.

The overall report still **fails** its counter gate: eight aggregate failed sends include three unavailable tracks, four unavailable transports, and one send exception (`Track is not open`). Encoder failures/timeouts and final audio-send failures were zero. The 15-second active-track checks passed; the last retained logical session was removed 67.126 seconds after the final page close. That last measurement is an observation of remaining session retention, not a claim that Hang Up latency is 67 seconds.

The harness now completes later media/cleanup phases after a counter-gate failure while retaining the overall failure. Earlier failed attempts and the baseline tab-close timing comparison remain unchanged. No new VDO.Ninja API or signaling command was used.

## Evidence

This follow-up binds 48 local evidence files. Manifest SHA-256: `45279357d836295db107cd46f9bff88ccbfdbd37148cb6b13f219d0125939079`. It references, rather than replaces, the earlier 64-file manifest `403636d8e670ba4826d5cecbcb810bf7b46e6b95bbb0d7b8f53f38868bd97321`. Exports retain both failed Windows attempts, the native API probe, the passing retry run, Mac snapshot cases and the failed x264 counter gate. Raw credentials, settings and signaling logs remain local.

[Machine-readable follow-up evidence](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-17-apple-m1-viewer-teardown/followup).
