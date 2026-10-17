# Hosted Windows packaged qualification — October 17, 2026

The Windows package built from the Mac integration source passed real GUI shutdown/snapshot and window-capture workflows in [run 39078856254](https://github.com/steveseguin/game-capture/actions/runs/39078856254). The public Windows release is unchanged. This adds bounded software-encoder coverage; it does not qualify physical NVIDIA/Intel/AMD encoders, Windows audio or all consumer Windows environments.

Source revision: `a801f6bf0189a88b6fd52b6ada5448da4c6be61c`. The existing release builder produced the ZIP, installer and portable executable. The ZIP was extracted and exercised with developer Qt/DLL paths removed. Installer and portable files were built and integrity-checked, not installed or launched. The pinned official Qt 6.9.3 build uses an explicit `Imported` dependency profile; the production profile and its existing DLL list remain the default. Import inspection covered 31 PE binaries; the package manifest bound 81 payload files.

- ZIP SHA-256: `e42c8576774fd48ce9e72261b1f8c145abb1fbcf94f00b8b3a8356974509a3dc`
- Executable SHA-256: `a71967de0a53049077fafd98ad566c3184d4f8d7c2a98bed2d348a3c1d4470da`
- Manifest SHA-256: `487c80f51b08a665b3879e10c44527f9451909b016640f175008381bcc7a67e0`

The hosted Windows Server 2022 machine reported an interactive session, four logical CPUs and Microsoft Hyper-V Video. Native logs confirmed Windows Graphics Capture and the software `H264 Encoder MFT`, with hardware encoding false. Requested output was 640×360, 30 fps, 2 Mbps, without audio. A real VDO.Ninja browser decoded and inspected the generated frame identities:

| Phase | Observed frames | Distinct picture identities | Result |
| --- | ---: | ---: | --- |
| Moving picture, six seconds | 176 | 176 | passed |
| Static picture, 2.5 seconds | 75 | 1 | passed; paced output retained |
| Resized source, four seconds | 120 | 120 | passed |
| Late viewer, three seconds | 87 | 86 | passed |

Every phase remained decoded H.264 at 640×360 with zero unreadable picture identities. The initial publisher snapshot recorded zero encode failures/timeouts. Destroying the owned source produced the expected exit code 3 and removed control discovery. This was an expected source-loss result, not a crash.

Two GUI launches also passed seven shutdown/snapshot assertions: clean exit and discovery removal for each launch; 37,523 concurrent reads with no incomplete JSON; current diagnostics written on ordinary shutdown; and the previous snapshot retained when a deliberately held handle denied replacement.

Both earlier unsuccessful attempts remain preserved:

1. [39077184658](https://github.com/steveseguin/game-capture/actions/runs/39077184658) passed compilation/backend gates, then stopped because the fixed production DLL list required `brotlicommon.dll` from a different Qt distribution. Application testing was not reached. The opt-in import profile now checks actual normal/delayed imports while retaining explicitly required runtimes; it does not change the production default.
2. [39077927959](https://github.com/steveseguin/game-capture/actions/runs/39077927959) packaged successfully and ran the GUI workflow, but failed the ordinary snapshot-replacement assertion. Its observer repeatedly used ordinary Python file opens, which can deny atomic rename. The corrected observer explicitly permits read/write/delete sharing, while the separate locked case still denies replacement. Windows documents that [delete sharing also governs rename](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew). The revised run passed without an application runtime change. Workflow outcomes are now retained independently, so a diagnostics assertion cannot prevent the media workflow from running.

Compilation, dependency inspection, package hashes and fixture checks are gates. The GUI and decoded-media workflows above are application testing. Remaining Windows coverage includes physical GPU encoders, audio/input devices, GUI publishing, external outputs/recovery, sustained workloads, installer/portable launch and representative Windows 10/11 machines.

[Allowlisted observations and all attempts](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-independent/windows-measurements.json) bind the package and harnesses. Freeze `0f1759e7-253c-4fd4-ae4a-8bab3a9499f1` retains both failures and the pass, alongside the [independent Mac reception evidence](macos-independent-receiver-2026-10-17.md). No release asset was replaced.
