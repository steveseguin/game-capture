# Radeon RX 9060 XT codec results

Windows 11, AMD driver **32.0.22042.14002**. Intel Graphics and an NVIDIA
TITAN RTX are also installed. This is not qualification of an AMD-only PC,
other Radeon drivers, HDR/10-bit, or a demanding game competing for GPU time.

## Actual application playback

The signed Game Capture **0.2.64** package captured a moving window and its
stereo audio at 1280×720, 30 fps, 4,000 kbps. Each case included initial playback,
viewer reload and publisher transport restart in Edge with VDO.Ninja.

| Selected codec | Actual encoder | Receiver result |
| --- | --- | --- |
| H.264 + AMD | `h264_amf` | H.264 video and audio; 29.99–30.06 fps |
| AV1 + AMD | `av1_amf` | AV1 video and audio; 29.99–30.06 fps |
| VP9 + Auto | `libvpx-vp9` (software) | VP9 video and audio; 29.97–29.99 fps |
| HEVC + AMD | `hevc_amf` starts | Edge rejected HEVC and the app recovered using H.264 |

The H.264, AV1 and VP9 measurement windows reported **zero dropped frames and
zero freezes**. They are short, local playback/reconnect measurements, not a
promise about every network or GPU workload. Video changed, received audio had
nonzero energy, the selected codec/encoder was checked, and publishing shut
down without surviving encoder children.

VP9 is a software encoding path in these apps. Explicitly selecting AMD + VP9
fails with an explanation instead of silently switching encoder categories.
Hardware video decoding is a separate capability from hardware encoding.

The final Game Capture executable SHA-256 is
`67de007fa66e004c31f23b1aa91aa723332b4dde3121e450bed7f862ed0d3c29`.
The preceding review package provided the HEVC fallback and explicit AMD/VP9
rejection checks; the three successful playback codecs above were repeated on
the final signed package.

## HEVC and receiver compatibility

HEVC encoding starts on the Radeon, but the tested native OBS Ninja receiver
supports only H.264 and VP9. Its log explicitly rejected H.265; a Studio test
received audio and a black picture. That is a failed HEVC playback result.
It is not evidence of successful HEVC transport or an AMD encoder failure.
Use **H.264 for this OBS receiver**. AV1 and HEVC remain experimental options,
and destination codec support matters. External RTMP/SRT/WHIP/RTSP/UDP/RIST
outputs in the current apps use H.264; choosing AV1 does not enable it there.

A separate check used the **bundled FFmpeg and the real AMD driver**, encoding
the same moving stereo fixture with H.264, HEVC and AV1 AMF, low-latency balanced
CBR at 4 Mbps. All three produced 300 frames, decoded without errors, and had
strictly increasing timestamps with at most 34 ms between frames. This confirms
HEVC encoding/decoding in the driver path; it does not replace an end-to-end
HEVC application receiver test.

## Reproduction

- `e2e/amd-codecs-packaged.py`: complete package → captured window/audio →
  browser playback, reload and transport restart. Defaults to H.264/AV1/VP9.
- `e2e/amd-codec-receiver.js`: observes an already-running publisher. The native
  OBS path also decodes its recording and rejects silent, frozen or blank output.
- `e2e/amd-driver-characterization.py`: supplemental driver check, explicitly
  separate from application testing.
- [Auto selection and failed-AMF recovery](radeon-rx9060xt-validation-2026-10-16.md).

Ignored evidence is in `native-qt/e2e/reports/release-0.2.64/amd-codecs` and
`amd-driver-r2`. Earlier failures and receiver incompatibilities remain in
`rx9060xt-codecs-2026-10-16`; they were not relabeled as passes. Raw logs,
temporary stream identifiers, local API credentials and recordings are not
published with this document.
