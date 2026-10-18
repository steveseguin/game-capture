# Notarized Mac defaults candidate — 2026-10-18 UTC

The [streaming-defaults candidate](macos-defaults-integration-2026-10-18.md) now has Apple notarization, a stapled ticket, matching source materials, local browser/quarantine/replacement workflows and fresh macOS 14 VM startup/media evidence. It remains an **unpublished experimental draft**. Public Mac Beta 2 and Windows v0.2.64 are unchanged.

| Artifact | Revision / SHA-256 |
| --- | --- |
| Runtime | `c459d7ada325c02945e460378d4f4acab8f1b755` |
| Executable | `ca2ecda2b36551dcb0eee8bd86c5dc8860782b9c6c04d6813438a18885ee68de` |
| App ZIP | `ebcad72fa5869250ea8216581f951b15650eabd1384c2eb036ed3ea5ecbe8237` |
| Matching source | `879d7e3c964b07db2b21276367b2b7dc1daf4f16420142a04c76a799d7602844` |

Draft release `416176031`, tag `macos-v0.2.64-defaults-candidate.1`, retains both archives and verified checksums. Apple accepted submission `173bfb81-a725-44b1-861a-d52fad9a97c0` with zero issues. Signature, Gatekeeper, staple and packaging gates passed. Source packaging verified 10,629 payloads, 12 dependency repositories, 8 upstream archives and 16 packaged Mach-O binaries. These are gates, separate from application testing.

## Real local delivery workflows

A headed Chromium browser downloaded the ZIP from an owned loopback HTTP server. The retained file matched the manifest and preserved its original quarantine metadata exactly. Both extracted Launch Services launches ran the same executable under App Translocation. The GUI stayed idle; settings changed through its controls survived Quit, replacement from the same archive and relaunch. Verification covered 524 bundle entries and 16 Mach-O binaries. This covers the local delivery path on an existing Mac, not a public GitHub download or fresh-user permission onboarding.

## Fresh macOS 14 workflow

[Run 39087687702](https://github.com/steveseguin/game-capture/actions/runs/39087687702) acquired the pinned draft app and corresponding source and verified both checksums. The application job had read-only repository permissions and excluded workflow credentials from the application environment.

The runner was Apple M1 (Virtual), arm64, macOS 14.8.9 (23J631). Two extracted-package startup/quit workflows and x264 moving/static/resize/late-viewer/source-loss workflows passed. The publisher requested 640×360 at 30 fps with audio disabled. The receiver decoded fixture identities in each phase; expected source loss returned exit 3.

| Phase | Seconds | Observations | Distinct images | Distinct images/s |
| --- | ---: | ---: | ---: | ---: |
| moving | 6.018 | 174 | 160 | 26.59 |
| static | 2.513 | 74 | 1 | 0.40 |
| resized | 4.012 | 112 | 77 | 19.19 |
| lateViewer | 3.018 | 87 | 63 | 20.88 |

These short observations are functional compatibility evidence, not sustained 30 fps qualification. The retained host/probe records distinguish this macOS 14 VM from physical minimum-version hardware. Screen-recording permission was already granted; no permission or machine-wide security settings were changed. Physical VT/devices, exact macOS 14.2, fresh-user privacy, audio, sleep/wake and long-run gameplay/thermal behavior are outside this result.

## Evidence and disk reclamation

[Measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/delivery/measurements.json), [hosted results](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/delivery/hosted-results.json), [manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/delivery/evidence-manifest.json), [binding validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/delivery/validation.json). The manifest binds 51 local files; SHA-256 `4737f615cd43dc0a0cdf6a7d05542f3e547895903681c7b3dee7b3d4b8d9655d`. Raw tokens, private preferences and unrestricted signaling logs stay local.

Transparent APFS compression reduced allocated storage for 29 older JSON evidence files by 790,712,320 bytes (754.1 MiB). Every original logical file, path, modification time and SHA-256 was preserved and checked again. The separate earlier source-archive deduplication produced no measurable free-space gain; it is not counted here. No unique release archive or application bundle was deleted.

Current-binary endurance and broader independent gameplay, physical Mac/minimum-OS/privacy/device/accessibility coverage, sleep/wake/display/audio-route changes, broader Windows qualification and earlier recorder-clock/abrupt-close findings remain open. The same executable's local VT/x264, WHIP/AAC, GUI migration and Windows packaged results remain in the [media report](macos-defaults-integration-2026-10-18.md). No new matched OBS/FFmpeg/WHIP picture-quality or encoder-efficiency claim is made.
