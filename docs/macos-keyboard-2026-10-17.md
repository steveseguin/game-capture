# Mac keyboard workflows — October 17, 2026

**Experimental, unpublished candidate.** The same notarized app used in the [30-minute VT/x264 runs](macos-timer-endurance-2026-10-17.md) passed keyboard editing, relaunch/reset and expanded Tab navigation. Public downloads remain Mac Beta 2; Windows stable is unchanged.

Runtime: `77e887ac50c1623836578676d87753c719f4654a`. Executable SHA-256: `dc4311c7c648fdf8d5cf3a196e8bfd1ee9160e96c34420132ff83a3f39b36dc4`. Host: Apple M1, 8 GiB, macOS 26.4.1.

The packaged app completed 14 keyboard workflow steps across three launches: Command-A/Backspace/text input, Tab/Shift-Tab between stream and password, Space on Advanced, arrow-key source selection, Space/Escape on the source menu, Command-Q, persistence after relaunch, About/Escape, Reset cancel/confirm and persisted defaults. Capture stayed off.

Six expanded settings layouts completed forward and reverse Tab cycles. Reverse order matched forward order exactly, and every required enabled text, combo, menu and numeric control was reached. Custom bitrate and audio encoding controls were expanded.

| Source | Output | Codec selection | Tab transitions each direction | Required settings controls | Unreached |
| --- | --- | --- | ---: | ---: | ---: |
| Window | VDO.Ninja (default) | Default | 26 | 24 | 0 |
| Camera / Webcam | WHIP | Default | 22 | 20 | 0 |
| Syphon (texture sharing) | SRT (caller) | Default | 24 | 22 | 0 |
| Window | RTMP / RTMPS | Default | 21 | 19 | 0 |
| Window | VDO.Ninja (default) | VP9 (Software, experimental) | 28 | 26 | 0 |
| Window | VDO.Ninja (default) | AV1 (Software, experimental) | 28 | 26 | 0 |

Each cycle includes one native-window focus stop. Two earlier attempts failed because the observer omitted focused native windows without identifiers. The second failure preserved the partial focus sequence; the corrected observer records that window stop. A four-layout pass preceded the expanded six-layout pass. All attempts remain indexed; no application change was needed.

Setup used accessibility actions and a click guarded against targeting another process; navigation used keyboard events directed to the owned app. The helper read the existing global keyboard preference and found no explicit `AppleKeyboardUIMode` override. It did not change that setting, and this read does not establish Full Keyboard Access state.

Buttons, checkboxes and radio rows were recorded separately and were not required by the Tab assertion. This is not complete keyboard accessibility, physical keyboard or VoiceOver qualification. The app remained idle: selecting Camera, Syphon, WHIP, SRT, RTMP, VP9 or AV1 here does not verify those media paths or physical devices.

Reproduction uses the [keyboard controls harness](https://github.com/steveseguin/game-capture/blob/3552330/native-qt/e2e/macos-keyboard-controls.py) and [Tab navigation harness](https://github.com/steveseguin/game-capture/blob/3552330/native-qt/e2e/macos-tab-navigation.py), with the signed candidate bundle and the compiled native UI helper. Exact harness/helper hashes and commands are in the [allowlisted measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-17-apple-m1-timer-endurance/keyboard/measurements.json).

Freeze `c2c16606-1792-49c0-b206-5a064de36e0b` indexes 57 local files; manifest SHA-256 `4facde7d253c8abd40c4ff7f0bdd85473fba3aae4bde6e8614b06ebadc4e9c70`. Raw settings, accessibility values, control credentials and logs remain local. These are UI behavior results, not encoder quality or performance measurements; [production qualification gaps](macos-timer-endurance-2026-10-17.md) remain open.
