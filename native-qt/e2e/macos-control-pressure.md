# Packaged Mac local-control pressure with received media

Run the real deployed app with an owned moving window, selected-window stereo
tones and a VDO.Ninja browser receiver. Both encoders run sequentially by default.
Existing Screen Recording permission and the Playwright dependency are required.
No system settings, physical microphones or unrelated windows are used.

```sh
node native-qt/e2e/macos-window-publish.js \
  '--app=/path/to/Game Capture.app' \
  --reports=/path/to/new/reports \
  --control-pressure=true --control-seed=20261018 \
  --audio=selected-window \
  --width=1280 --height=720 --fps=60 --bitrate-kbps=4000
```

An existing compiled `macos-ui-control` helper can be supplied through
`--source-ui-helper=/path/to/helper` when the owned source browser needs native
activation. Run with an unlocked graphical session. The run creates its own
publisher, browsers and loopback control endpoint and closes them afterward.

The fault phase sends three seeded batches of 128 fragmented requests and 24
explicit framing/health/authentication requests. It then checks the absolute
deadline for idle, trickled-header and incomplete-body clients, fills 48 client
slots to verify the 32-connection limit, and checks authenticated recovery and
single-request handling of a pipelined command. That command targets only this
workflow's publisher; an unexpected execution fails the workflow.

Five consecutive five-second decoded-track observations overlap the fault phase.
The checks require progressing H.264 frame identities, no arrival/media gaps over
500 ms, continuous 48 kHz stereo PCM with the intended tones and exclusion of the
unrelated tone, and unchanged encoder error counters. PCM startup settling is
500 ms; final partial 100 ms windows are excluded. A separate received-audio
MediaRecorder file is retained. Normal static, audio silence/resume, resize,
late-viewer and shutdown/source-loss workflows follow.

Results retain raw observations, seeds, request fragmentation and redacted framing
templates. Keep publisher logs and discovery credentials private. The frozen
harness and exact executable hash identify what actually ran. These are bounded
local-control resilience workflows, not perceptual-quality measurements, network
impairment, physical-device coverage or endurance. Offline evidence audits and
JavaScript syntax checks are gates, not application testing.
