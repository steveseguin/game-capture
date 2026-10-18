# Current Mac candidate delivery qualification — 2026-10-17

The current lifecycle candidate is Developer ID signed, Apple-notarized and stapled. It passes local browser-download quarantine, extracted GUI settings/replacement/relaunch, and fresh macOS 14.8.9 VM startup/x264 media workflows. It remains an **unpublished experimental draft**; public Mac Beta 2 and Windows stable v0.2.64 are unchanged.

## Exact artifacts

| Item | SHA-256 / revision |
| --- | --- |
| Runtime source | `325b70822a6172d874534c7910df0d7e544f1e7f` |
| Signed executable | `cea19c786e764670927ce00399b32db3ef5c5310ccc2ffe3820a7483d7f05d9d` |
| App ZIP | `33c649b8596f93895548b4e1578957b87f61218a9623e809e14f06a50bf522dc` |
| Corresponding-source archive | `a230f50584180e02ca99a9e5df055bac5859442ab820b6d88e1095f6b9b33457` |

Draft release ID: `416161711`. Apple accepted submission `2cb44e3c-7c01-4db7-b0dc-600c84096ba1` with zero issues. Staple validation, Developer ID signatures, Gatekeeper assessment and archive/source checks passed. These are gates, not application testing. The source archive verifies 10,619 payloads, 12 native dependency repositories, 8 upstream archives and all 16 packaged Mach-O binaries.

The executable is unchanged from the [VT/x264 viewer-cycle and Windows regression workflows](macos-track-close-2026-10-17.md). Notarization adds distribution evidence; it does not substitute for application behavior.

## Local browser and GUI workflows

A real headed Chromium browser downloaded the audited ZIP from an owned loopback HTTP server. The completed original file was retained without rewriting its quarantine metadata, and its SHA-256 matched the delivery manifest. This covers local download/quarantine behavior, **not the public GitHub download path**.

The downloaded archive was extracted into an owned directory. Launch Services ran the exact signed executable under App Translocation twice. GUI controls responded; stream/room/label, viewer limit, gain and limiter settings were changed in isolated preferences. After Quit, the first extracted app was preserved, replaced from the same downloaded archive, and relaunched. All configured settings were restored, and both launches stayed idle with capture/publishing off. The workflow verified 524 bundle entries and 16 Mach-O binaries, retained quarantine on replacement, and quit both owned instances.

Two earlier attempts failed the strict quarantine-preservation check: both `ditto` and `cp` reserialized spaces in Chrome's quarantine-agent text. The corrected harness renames the completed owned download on the same filesystem, then still requires exact metadata equality. It does not synthesize, strip or waive quarantine. Both failures remain bound in the evidence. Their two byte-identical duplicate ZIPs were removed after preserving hashes and quarantine bytes, freeing about 60 MB; the canonical ZIP is retained.

An earlier source-package gate correctly refused a sparse checkout. Packaging passed after populating the isolated checkout completely; that failed gate is retained too.

## Fresh macOS 14 VM

[Run 39085116699](https://github.com/steveseguin/game-capture/actions/runs/39085116699) downloaded and verified the pinned draft app and matching source. The host was Apple M1 (Virtual), arm64, macOS 14.8.9. Two packaged startup/quit workflows passed, including authenticated diagnostics, exported diagnostics, isolated settings handling and explicit missing-source/camera refusal.

The extracted app then captured an owned window and sent x264 H.264 to a browser. Moving picture, static content, resize, late joining and expected source-loss exit 3 passed. Received frames had zero fixture-identity read failures. Requested output was 640×360 at 30 fps with audio disabled.

| Phase | Seconds | Observations | Distinct images | Distinct images/s |
| --- | ---: | ---: | ---: | ---: |
| moving | 6.006 | 173 | 139 | 23.14 |
| static | 2.508 | 63 | 1 | 0.40 |
| resized | 4.029 | 102 | 54 | 13.40 |
| lateViewer | 3.003 | 86 | 53 | 17.65 |

The VM **did not establish sustained 30 fps presentation**: moving/resize/late phases were below that target. This is functional compatibility evidence; it does not identify the limiting component or qualify physical hardware VT, audio, gameplay/thermal load, privacy transitions, exact macOS 14.2, or current-binary endurance. Screen-recording permission was already granted on the runner; no permission settings were changed.

## Evidence and remaining work

The 30-file manifest retains both browser-copy failures, the source-package refusal, successful local workflows and hosted results. Raw control tokens, settings values, signing credentials and unrestricted logs remain local. Manifest SHA-256: `7298747f7aa7da15033b16c1597e3639c9575ed221c93d22dceae7eaa14324d7`. [Measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-track-close/delivery/measurements.json), [manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-track-close/delivery/evidence-manifest.json), [validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-track-close/delivery/validation.json).

Public GitHub delivery of this unpublished candidate, physical minimum-OS/privacy/device testing, sleep/wake and route/display changes, current-binary endurance, broader Windows qualification and the earlier recorder-clock findings remain open. This report adds no matched OBS/FFmpeg/WHIP quality or encoder-efficiency claim.
