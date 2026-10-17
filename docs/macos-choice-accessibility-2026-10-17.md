# Mac configuration-menu crash fix — October 17, 2026

**Unreleased signed candidate; production qualification remains open.** Runtime [`5888246`](https://github.com/steveseguin/game-capture/commit/5888246ab9c443b459393bd44cfdf5bee9ba99be); executable SHA-256 `17314b8f7eea037e113e7b8d465ca39dc23d7b9d1d1189644c2d7c90f15c0e6c`. All 39 application units were rebuilt from frozen source. The public download remains [Mac Beta 2 — Experimental](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.64-beta.2); this candidate is not notarized.

Further packaged testing found the [previous output-only fix](macos-output-profile-fix-2026-10-17.md) was too narrow: selecting 60 fps on the third launch crashed `8f40168` in Qt's generic accessible table-cell selection path. The replacement applies owned accessible rows to all 16 Mac dropdowns, retires rows after device/model changes, refuses non-selectable entries, and tolerates a selection signal destroying its row or view. The runtime change is Mac-only.

Completed packaged application testing on this exact candidate:

- Two accessibility-driven menu workflows: eight normal launches/exits, 336 selection checks, 318 actual changes and 80 device-model refreshes. The expanded workflow also verified editable resolutions, preservation of the last valid resolution after invalid input, eight keyboard popup commits and four Escape cancellations.
- Mouse row selection: two normal launches/exits, 108 checks, 105 actual changes and 20 refreshes, including camera resolution/frame rate. Popups were opened through accessibility before clicking. This is not a complete manual or VoiceOver qualification.
- Audio-route GUI: 30 observations across Window, Camera and Syphon, including refusal of unavailable app-audio selection and saved-setting recovery. Capture stayed off.
- Output profiles: six normal launches/exits, seven separate destination profiles, editing isolation, owned-Keychain-item loss, cancelled/confirmed Reset and recovery. Both owned items were cleaned up. This does not establish delivery over seven protocols or locked-Keychain behavior.
- Existing virtual camera plus virtual stereo input: GUI source selection, VideoToolbox delivery, decoded movement/orientation/audio, mute/unmute, silence/resumption, late reception, stop/restart and graceful quit passed. Physical devices and every camera capture mode remain unqualified.

Both encoders passed separate one-minute H.264 1920×1080/60 VDO.Ninja workflows at requested 8 Mbps, followed by controls, static/silence/resumption, resize, late-viewer video/audio and expected shutdown:

| Encoder | Passed intervals | Received fps | Audio windows | Publisher RSS MiB |
| --- | --- | --- | --- | --- |
| videotoolbox | 6/6 | 59.788–59.999 | 609 | 154.4–155.1 |
| x264 | 6/6 | 59.479–59.891 | 613 | 173.8–189.1 |

All 1,222 continuous 100 ms audio windows passed. Source and receiver shared an M1/8 GiB Mac on macOS 26.4.1, Chromium 145.0.7632.6, with remote desktop active. Moving tiles were 1920×930, aspect-fitted into 1080p. These are delivered-media checks, not matched OBS/FFmpeg quality, WHIP, independent-receiver, thermal or CPU-efficiency measurements. The earlier thirty-minute result belongs to a different executable.

Retained unsuccessful runs include the original crash, an AXFocused-based keyboard attempt that moved the wrong control, and an immediate mouse click that failed to commit. The final driver explicitly opens the keyboard popup and allows mouse-popup settling, without retrying failed selections. AXFocused-only behavior and broader VoiceOver interaction remain open.

Separate **gates** passed: accessible-row lifetime/reentrancy, ASan/UBSan, signatures, evidence hashes, and [Windows build/link/backend selection](https://github.com/steveseguin/game-capture/actions/runs/39064131632) at `2a5e9a0914315912a73dc87a15791a7a1dc47f40`. The old adapter was rejected by the lifetime gate's negative control. The Windows job compiled 28 application units and ran one capability gate; **packaged Windows application testing is still required**. Sanitizers covered the adapter and isolated gate, not all Qt code or whole-process leaks.

[Measurements and evidence index](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-17-apple-m1-choice-ui) bind each run to its artifact. Freeze `c73da67b-b9b9-45b1-9fde-e591b9304083` contains an index of 258 local files; manifest SHA-256 `5f18a837ac073a1ce9612b7fce1e8785d6d470ad49e533638c21fd1440575ee0`. All 12 media observations were hash-verified and their cadence and PCM decisions recomputed. Raw settings, credentials, accessibility snapshots and crash reports stay local. Reproduction harnesses are on [macos-production-readiness](https://github.com/steveseguin/game-capture/tree/macos-production-readiness/native-qt/e2e): `macos-choice-controls.py` (AX or `--row-action click`), `macos-audio-source-controls.py`, `macos-output-profiles.py`, `macos-camera-publish.js`, and `macos-window-publish.js`.

Remaining production work includes real Windows workflows, another/fresh and minimum-OS Mac, physical devices/privacy transitions, sleep/wake/display/audio-route changes, independent reception and gameplay/thermal loads, trusted remote RTMPS, broader current-artifact accessibility coverage, and distribution/notarization.
