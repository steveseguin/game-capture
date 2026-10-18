# Packaged Mac H.264 endurance

Use the intended released `.app`, its independently verified executable hash,
and an unlocked Mac session with the existing capture permissions. This workflow
captures only its generated window and selected-application tones. It does not
qualify physical devices, gameplay, calibrated A/V sync, or general picture
quality. The source and browser receiver run on the same machine.

From `native-qt`, run the two encoders sequentially with unique report roots:

```sh
node e2e/macos-window-publish.js \
  '--app=/path/to/Game Capture.app' \
  --reports=qa/reports/released-vt-endurance \
  --encoder=videotoolbox --performance-seconds=1800 \
  --width=1280 --height=720 --fps=60 --bitrate-kbps=4000 \
  --motion-pattern=tiles --audio=selected-window --continuous-audio=true \
  --compact-performance-report=true --collect-performance-failures=true \
  --source-ui-helper=/path/to/macos-ui-control
```

Repeat with `--encoder=x264` and a different report root after VT finishes. The
source helper requires existing Accessibility authorization; do not modify
system permissions or terminate unrelated applications to obtain a pass. Keep
builds, other media campaigns and large transfers separate from the timed run.
At least 512 MiB free is required before each long workflow; a 128 MiB reserve
guard stops a run if space becomes insufficient.

The workflow retains ten-second received-frame observations, source identities,
100 ms continuous stereo PCM summaries, periodic spectra, application counters,
publisher RSS, whole-host CPU, and an independently re-encoded audio recording.
It then exercises controls, silence/resume, static content, resize, late joining
and shutdown/source loss. Collected failures stay failed even when later phases
work. The recording does not establish physical speaker output or clock accuracy.

After the processes exit, audit each completed `results.json`:

```sh
python3 e2e/macos-endurance-audit.py \
  --report qa/reports/released-vt-endurance/RUN_ID/results.json \
  --output qa/reports/released-vt-audit.json \
  --expected-seconds 1800 \
  --expected-executable-sha256 RELEASE_EXECUTABLE_SHA256
```

The expected hash identifies `Contents/MacOS/game-capture`, not the ZIP. Bind it
to the intended release manifest. The audit refuses to overwrite its output,
checks compressed and uncompressed evidence hashes, recalculates cadence and
delivery ratios, and checks PCM continuity across interval boundaries. It also
requires the requested hardware/software path, artifact identity, duration,
dimensions and post-endurance functional result. Barcode agreement does not
prove equality with every source pixel. RSS observations do not prove absence
of a memory leak, and whole-host CPU is not isolated encoder cost.

Running the application and inspecting received behavior is testing. Syntax,
artifact/signature checks, and audit-tool positive/negative controls are gates.
Offline auditing analyzes the retained application testing; it is not another
application run. Preserve failed observations and their original thresholds.
