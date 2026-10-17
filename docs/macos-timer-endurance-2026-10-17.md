# Mac frame timer: sustained delivery — October 17, 2026

**Experimental, unpublished; production qualification remains open.** This follows the [frame-timer investigation](macos-frame-timer-2026-10-17.md) using the identical notarized packaged app: runtime `77e887ac50c1623836578676d87753c719f4654a`, executable SHA-256 `dc4311c7c648fdf8d5cf3a196e8bfd1ee9160e96c34420132ff83a3f39b36dc4`. Public Mac downloads remain Beta 2.

Each encoder ran a separate requested 30-minute 1920×1080/60 H.264 stream at 8 Mbps, followed by live controls, static picture/silence, resumption, resize, late-viewer video/audio and shutdown. The receiver decoded picture identities and continuously inspected stereo PCM; successful transmission alone was not the pass condition.

| Encoder | Complete workflow | Passing ten-second intervals | Received distinct fps | Publisher RSS (MiB) | 100 ms PCM windows |
| --- | --- | --- | --- | --- | --- |
| x264 | passed | 180/180 | 59.680–60.098 | 164.5–188.6 | 18,323 |
| videotoolbox | passed | 180/180 | 59.785–60.098 | 124.5–150.2 | 18,347 |

The x264 workflow deliberately destroyed the capture source and verified the expected source-closure exit code 3. VideoToolbox verified an ordinary quit with exit code 0.

The two runs observed 36,670 PCM windows. Per-interval picture identities, cadence calculations, decoded identity wraps and audio decisions were checked again against retained compressed observations and their hashes. RSS is the observed application range, not a leak guarantee or total system memory. Source and receiver shared an M1/8 GiB Mac on macOS 26.4.1 with remote desktop active; the controlled 1920×930 source was fitted into 1080p. CPU allocation was uncontrolled. These runs do not measure independent reception, representative gameplay, power or thermal stability.

The independent recording checks remain separate from live received playback:

- **x264**: retained continuous-playback evidence passed; independently decoded recording PCM passed; recorder clock **failed**, maximum timestamp discontinuity 10.000 ms. The recorder-clock limit remains 3 ms.
- **videotoolbox**: retained continuous-playback evidence passed; independently decoded recording PCM passed; recorder clock **failed**, maximum timestamp discontinuity 5.000 ms. The recorder-clock limit remains 3 ms.

A separate browser-only diagnostic generated stereo tones, sent them through two real local WebRTC peers and recorded the received track with the same recording helper. It used no Game Capture publisher, VDO.Ninja service or physical input. Its continuous-playback evidence passed, decoded PCM passed, and recorder-clock gate **failed**, with maximum timestamp discontinuity 5.000 ms. The discrepancy can therefore occur without this app publishing. This does not identify a specific defective component or explain every recording discrepancy. The probe is a measurement diagnostic, not additional application testing. Original failed gates remain preserved.

Mouse-driven output setup completed 2 passing cases: hardware VT with RTMP and encrypted SRT, including decoded video/audio, silence/resumption, receiver/server recovery and clean shutdown. The 4 earlier failed attempts remain preserved. They exposed harness assumptions about the full microphone label, offscreen controls and Qt's flattened accessibility tree/string-valued scrollbar limits. [Harness revision b1e0672](https://github.com/steveseguin/game-capture/commit/b1e0672) matches the exact clicked label and scrolls the requested control into view. The guard continues to refuse pointer events targeting another process. No packaged application change was needed.

Beta 2 package replacement passed, including restoration of selected preferences and capture remaining off at startup. Saved-WHIP migration passed for both encoders: the new executable reused the same isolated preferences and Keychain reference without re-entering credentials, then delivered decoded video/audio and recovered after a local server restart. These are local replacement/profile workflows, not fresh-machine or public-WHIP qualification.

Follow-up [packaged keyboard workflows](macos-keyboard-2026-10-17.md) passed 14 editing/relaunch/reset steps and six expanded forward/reverse Tab layouts on this same app. Two earlier observer failures remain preserved. This adds scoped UI behavior coverage, not full accessibility or media qualification.

Remaining qualification includes browser download/quarantine, physical devices and privacy transitions, sleep/wake/display/audio changes, exact minimum OS with hardware VT, independent receivers, gameplay/thermal load, trusted remote RTMPS and actual packaged Windows workflows. The existing Windows build/backend gates are not Windows application testing.

These are Game Capture delivery results, not matched OBS/FFmpeg/WHIP picture-quality scores or encoder-efficiency comparisons. [Measurements and evidence index](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-17-apple-m1-timer-endurance) contain exact requested settings, observed values, harness hashes and reproduction arguments. Freeze `aa0fbe5e-8912-4aed-97af-bf2a6793fed0` indexes 1275 local files; manifest SHA-256 `a509cad9f83638ef67d89b9a0e765078bfc8b528aae8e810fdedc961d2c3cb33`. Raw recordings, settings, credentials and logs remain local. Earlier evidence freezes are unchanged.
