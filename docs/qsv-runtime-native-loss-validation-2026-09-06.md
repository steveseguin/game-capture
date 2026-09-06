# QSV runtime isolation and native OBS loss/opacity validation

Follow-up: the [pooled hardware upload review](qsv-dynamic-upload-validation-2026-09-06.md)
validates an application fix with the installed runtime, avoiding the older-runtime
override described here.

This follows the [sustained streaming review](sustained-stream-validation-2026-09-06.md).
The package under review is `native-qt/dist/browser-cadence-trace/game-capture.exe`,
SHA256 `d06a09b0fb99075283aa7fb754b176e212b6ea6690ec116ea57297628cdafe2f`.
Application binaries and installed drivers are unchanged. Changes in this review
extend the E2E harness and document a process-local Intel runtime workaround.

## Runtime comparison

The host has an Intel Core Ultra 7 265K, Intel Graphics driver `32.0.101.6881`,
and a TITAN RTX with driver `32.0.16.1047`. Two Intel media runtime versions
were already present in the Windows Driver Store:

| Runtime | Driver Store folder below `C:\Windows\System32\DriverStore\FileRepository` |
| --- | --- |
| Current `25.04.25.d24cd8b9` | `iigd_dch.inf_amd64_85e8c2b0ad672377` |
| Older `24.10.12.a2a30988` | `iigd_dch.inf_amd64_b57fc4f35ff4051b` |

Current `libmfx64-gen.dll` SHA256:
`a371947319976254c062bd2af08ae9932766409fda32cdb5ffeb502ba68b153e`.
Older DLL SHA256:
`4a810abc195cce972d9687daeb27e81712e3dfa224c8468ee48cc9cc9e552f80`.

`ffmpeg-memory-review.js` now accepts `--runtime-path`, `--log-level`, and
`--dispatcher-log=1`, and records the loaded media runtime modules. The runtime
override sets `ONEVPL_PRIORITY_PATH` only in the child process environment.
[Intel's dispatcher documentation](https://intel.github.io/libvpl/latest/programming_guide/VPL_prg_session.html)
defines this variable as a higher-priority runtime search directory. Enumeration
can load more than one candidate DLL, so a module list alone does not establish
which implementation owns the encoding session.

Each isolation experiment encoded 18,000 synthetic 1280x720 frames with the
same QSV options. These are diagnostic experiments, not packaged application
testing. Linear private-memory trends below exclude samples before frame 2,000.

| FFmpeg | Runtime selection | Private bytes/frame, fitted trend | Outcome |
| --- | --- | ---: | --- |
| Bundled | Explicit current-runtime priority | 2,309 | Continuing growth |
| 2026-09-06 build | Default runtime | 2,277 | Continuing growth |
| Bundled | Older-runtime priority | 39 | Plateaus around 162 MiB |
| Bundled, repeat with dispatcher log | Older-runtime priority | 31 | Plateaus around 162 MiB |

Explicit current-runtime priority is a control for the dispatcher's generic
initialization path: merely setting the priority variable does not remove growth.
This supports a runtime-version-dependent issue on this host. It does not
establish the responsible internal allocation or guarantee compatibility on
other GPUs. The FFmpeg update alone did not solve it.

Bundled FFmpeg: `n8.1.2-34-g9b6c8969e0-20260731`, executable SHA256
`cfa7457eab838db74cb8888ccaf46549a931a2913312e8dede423a26ddac33d5`.
Comparison FFmpeg: `N-126435-gf93cd72dde-20260906`, executable SHA256
`39fcd7e6395df0f3cdde299c84d6584ba84115b5eabad41bc3052a8836934a7d`,
extracted separately from [BtbN's builds](https://github.com/BtbN/FFmpeg-Builds/releases).
The bundled package was not replaced.

Artifacts below `native-qt/qa/reports/qsv-version-review`:

- Current priority: `current-priority-clean/2a7d0f08-8897-40aa-a7eb-399f048a8f56`.
- New FFmpeg: `runs/86b92821-1e0a-4645-b235-7f4b14248065`.
- Older priority: `runs/0b099a29-b2bc-4e48-9384-4382309239df`.
- Older priority repeat: `runs/e6578a27-bb07-4c8c-9f89-98669b1a168b`.

## Allocation profiling limits

Microsoft CDB `10.0.29617.1000` attached to an isolated FFmpeg process owned by
this review. Two snapshots showed its main NT heap commit increasing from
77,168 to 82,956 KiB, with only 644 and 769 KiB respectively reported as
ordinary free blocks. The later LFH summary contained 15,447 blocks in the
2,192-byte bucket. The accompanying 2,048-3,072-byte front-heap histogram
reported 15,492 busy blocks and only 73 free blocks while encoder progress
was held at frame 15,157 for the snapshot. This favors retained
allocated objects over a cache consisting solely of freed allocator blocks.
The allocation size is consistent with the observed per-frame growth, but
without successful allocation/free stack tracing it does not identify the
owner or establish whether the runtime considers those objects reachable.

Evidence: `native-qt/qa/reports/qsv-allocation-profile/heap-first.txt` and
`heap-sizes.txt`, associated with experiment
`runs/c757883a-94eb-4875-9c1b-5507fa93837d`. Debugger pauses invalidate its
wall-clock performance measurements. A separate conditional-breakpoint attempt
did not yield usable allocation stacks; its interrupted current-priority run
is excluded from the comparison table. Dr. Memory also failed inside its
instrumentation before encoding. These failures are not application failures.
No system tracing registry settings or security software were changed.

## Native loss and half-opacity workflow

`--native-loss=5` now relays actual local native OBS UDP media through test-owned
sockets. It rewrites unencrypted ICE signaling to prevent a direct-path bypass,
then forwards encrypted DTLS/SRTP payloads unchanged. During a 12-second fault,
it drops five consecutive RTP packets per hundred publisher-to-receiver packets.
This is a deterministic burst model, not independent random loss. STUN, DTLS,
and RTCP pass through. The RTP/RTCP distinction follows
[RFC 5761](https://www.rfc-editor.org/rfc/rfc5761.html#section-4).
Destinations and senders are restricted to IPv4 addresses on this host.

The harness identifies the newly attached native OBS peer, saves per-session
and per-SSRC counts, and requires actual native drops. It checks alpha recovery
and makes an actual OBS recording afterward. Browser counters alone are not
treated as proof of native loss. This does not cover WAN jitter, reordering,
TURN routing, or independent alpha-only loss.

`--obs-half-opacity=1` restarts the Spout fixture with a static half-opacity
pattern, validates ten native OBS composites, rebuilds the transport and
validates ten more, then restores the moving fixture. A purple composite
against the known backdrop verifies blending, rather than merely receipt of
an alpha track. The workflow also exercises live resolution/FPS controls,
browser reattachment, signaling recovery, source recovery, and graceful shutdown.

Completed native runs:

- NVENC: `native-qt/qa/reports/native-loss-half/abcab28d-242b-49dc-ac6f-be000eed2bf5`.
- QSV and VP9: `native-qt/qa/reports/native-loss-half-qsv-vp9/cd123d2d-1afe-4980-a118-fcff0ae7fece`.
  QSV used the older-runtime override. VP9 used `libvpx-vp9`.

| Codec/encoder | Native color/audio/alpha packets dropped | Total | Three OBS recordings, distinct changes/sec | Half-opacity max channel error | Shutdown |
| --- | --- | ---: | --- | ---: | ---: |
| NVENC H.264 | 648 / 59 / 38 | 745 | 59.88 / 59.88 / 59.88 | 1/255 | 438 ms |
| QSV H.264 | 113 / 61 / 36 | 210 | 59.88 / 59.88 / 59.88 | 1/255 | 437 ms |
| VP9 | 66 / 66 / 33 | 165 | 59.88 / 59.88 / 59.88 | 1/255 | 438 ms |

The color/audio/alpha SSRCs are 2222222, 3333333, and 4444444 respectively.
There were no relay socket errors. Both half-opacity checkpoints and subsequent
moving alpha checks passed for every codec. The measured static checkpoint
images were RGB `(143,48,254)` against expected `(143,48,255)`.

All **nine actual OBS recordings** had 439.94-440.09 Hz audio, no clipped
samples, and no silent 100 ms analysis windows (0.5 seconds trimmed at each
end). Source restart, signaling recovery, and the final soak passed in all
three workflows. Every shutdown exited zero without remaining encoder children.

## Long packaged QSV validation

The older-runtime packaged session completed **20.48 minutes** with two
persistent browser viewers. Artifact root:
`native-qt/qa/reports/qsv-runtime-sustained/aa83ea79-7574-4875-bfd9-644a6932223b`.

| Measurement | Earlier default runtime | Older-runtime override |
| --- | ---: | ---: |
| Post-warm-up encoder private memory | About 165-323 MiB | 140.97-144.47 MiB |
| Fitted encoder private-memory trend | 7.88 MiB/min | 0.023 MiB/min |
| Publisher private memory | About 100-102 MiB | 101.84-106.39 MiB |
| Encoder processes throughout soak | One | One, same PID throughout |
| Graceful shutdown | 333 ms | 325 ms |

Five actual receiver recordings measured **59.36, 59.56, 58.56, 59.06, and
59.56 distinct changes/sec**, with 99.83-100% decoder-counter coverage and no
unreadable frame IDs. The 41 normal/recovered measurement windows per viewer
reported no video drops, freezes, packet loss, or concealed audio samples;
minimum decoded rates were 59.83 and 59.96 FPS. All five tone probes found
439.45 Hz with no clipped samples.

The deliberately impaired window is separate: the affected viewer reported
11 video packets lost, six dropped frames, two freezes totaling 0.418 seconds,
70 audio packets lost, and 33,419 concealed samples. It recovered before the
next recording. Transport rebuilding, a five-second signaling outage, and
viewer reload also passed. Shutdown exited zero without remaining encoder
children.

Publisher last-sent input age stayed at **101.31-116.99 ms**, compared with
85.31-101.96 ms in the earlier default-runtime run: approximately one frame
higher. These non-atomic component timestamps are not direct glass-to-glass
latency measurements, but the difference should be retained as a potential
tradeoff. Receiver processing delay was bounded at 21.27-45.91 ms for the
loss-exposed viewer and 9.02-9.50 ms for the second viewer.

This validates the process-local override for this workload and host. It does
not repair the current runtime or establish a universal replacement driver.
The default runtime's continuing growth remains an upstream/runtime concern.

## Reproduction

From the repository root, use the existing extracted E2E dependencies:

```powershell
$env:NODE_PATH = (Resolve-Path native-qt/qa/reports/receiver-runtime/node_modules).Path
```

An isolated encoder comparison:

```powershell
node native-qt/e2e/ffmpeg-memory-review.js `
  --ffmpeg=native-qt/dist/browser-cadence-trace/ffmpeg/bin/ffmpeg.exe `
  --encoder=h264_qsv --frames=18000 --dispatcher-log=1 `
  --runtime-path=C:\Windows\System32\DriverStore\FileRepository\iigd_dch.inf_amd64_b57fc4f35ff4051b `
  --reports=native-qt/qa/reports/qsv-runtime-comparison
```

The native OBS workflow uses the previously prepared portable OBS/plugin
runtime, with plugin DLL SHA256
`396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47`:

```powershell
node native-qt/e2e/encoder-receiver-review.js `
  --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe `
  --sender=native-qt/build-review2/bin/spout_test_sender.exe `
  --reports=native-qt/qa/reports/native-loss-half `
  --width=1280 --height=720 --fps=60 --cases=nvenc:h264 `
  --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 `
  --combined-video-controls=1 --require-codec=1 `
  --obs-plugin-repo=native-qt/qa/reports/fresh-phase-obs-runtime `
  --expected-plugin-sha256=396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47 `
  --obs-cadence=1 --native-loss=5 --obs-half-opacity=1 --faults=1 --soak-ms=30000
```

The QSV/VP9 run used the same command with `--cases=qsv:h264,auto:vp9` inside
the runtime-override block below and a separate reports directory.

For the older-runtime QSV workload, set the runtime variable in the launching
process and restore it afterward. This does not edit user/system environment
settings or install a driver. The folder is machine-specific; it is not a
production default or a portable dependency bundled by this project.

```powershell
$previousRuntimePath = $env:ONEVPL_PRIORITY_PATH
try {
  $env:ONEVPL_PRIORITY_PATH = 'C:\Windows\System32\DriverStore\FileRepository\iigd_dch.inf_amd64_b57fc4f35ff4051b'
  node native-qt/e2e/encoder-receiver-review.js `
    --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe `
    --window-video=native-qt/qa/reports/browser-reference-60.mp4 `
    --reports=native-qt/qa/reports/qsv-runtime-sustained `
    --width=1280 --height=720 --fps=60 --cases=qsv:h264 `
    --frame-identity=1 --identity-recording=1 --require-codec=1 `
    --sustained=1 --soak-ms=1200000 --packet-loss=5 --faults=1
} finally {
  $env:ONEVPL_PRIORITY_PATH = $previousRuntimePath
}
```

To use the same process-local override in the normal application, replace the
`node` command inside that block with
`& .\native-qt\dist\browser-cadence-trace\game-capture.exe` and select Intel
Quick Sync in the UI. The application and its encoder children inherit the
override. Closing that application and launching normally restores default
runtime selection; this review does not silently select an older runtime for
all users.

`analyze-sustained-review.js` summarizes the completed `qsv-h264-sustained.json`.
`analyze-native-loss-review.js <results.json>` collects native SSRC drop counts,
measures half-opacity screenshot colors, and runs `analyze-recorded-tone.js`
on every actual OBS MP4 with the bundled FFmpeg.
JavaScript syntax and diff checks are gates; they do not replace these E2E
workflows or recording analysis.
