# Window cursor parity

Windows starts Graphics Capture with `IsCursorCaptureEnabled(false)`. The
released Mac 0.2.65 Beta 1 uses `SCStreamConfiguration.showsCursor = YES`.
The Mac correction sets it to `NO` in the configuration shared by stream
startup, enlargement and previews. Windows code and signaling are unchanged.

Build the owned fixture after other timed media campaigns finish:

```sh
xcrun --sdk macosx clang++ -std=c++17 -fobjc-arc -arch arm64 \
  -mmacosx-version-min=14.2 e2e/macos-cursor-fixture.mm \
  -framework AppKit -framework CoreGraphics -o /tmp/macos-cursor-fixture
```

From `native-qt`, run the released package as a positive control:

```sh
node e2e/macos-cursor-publish.js \
  '--app=/path/to/released/Game Capture.app' \
  --fixture=/tmp/macos-cursor-fixture \
  --reports=qa/reports/cursor-baseline-vt \
  --encoder=videotoolbox --expected-cursor=included
```

Repeat against the separately packaged corrected candidate with
`--expected-cursor=excluded`, for both `videotoolbox` and `x264`, using unique
report roots. An included-cursor positive control is not a Windows parity pass;
the report records these outcomes separately. Inspect the executable and fixture
source/binary hashes before comparing results.

The fixture draws a moving identity barcode, transparent and opaque regions,
and a moving blue bar. It moves the normal system pointer between two known
positions without replacing its image or requiring the source to be foreground.
The harness checks received H.264 pixels in headless Chromium, retaining
per-frame counts and a PNG for each phase. Each 40×40 probe is entirely inside a
flat-color region, away from drawn edges and moving content. Received colors
have a ±20 tolerance per RGB channel to allow ordinary H.264 conversion.

The released positive control must show at least 100 unexpected pixels beneath
the pointer and zero in the untouched probe. The initial parked-pointer phase
checks the empty transparent probe. Corrected output must have **zero unexpected
pixels in both probes in every observed frame**, including the parked phase.
Frame progression, exact pointer position before and after observation, actual
encoder choice, normal shutdown and pointer restoration are also checked.
Failed pixel phases stay failed while subsequent pixel phases are retained.

Only explicit fixture stdin commands move the pointer, within the fixture's
own window. The fixture remembers its initial position at the first command,
refuses further warps after independent pointer movement, and restores position
on normal exit only while the pointer remains under its control. It exits after
100 seconds even if its stdin controller stalls. Use an unlocked, otherwise
undisturbed session; no trust, privacy or default-device setting is changed.
Fixture stdin commands are private controls, not VDO.Ninja APIs.

The released 0.2.65 Beta 1 positive control passed 540 received observations
across three phases: the normal cursor affected 159–164 pixels beneath it,
while the untouched probe remained clean. Earlier custom-marker attempts are
retained as failures: the source could not establish foreground cursor ownership
and the released output contained the system I-beam instead of the requested
magenta marker. The current workflow checks the actual system cursor and uses
stricter clean-probe assertions; it does not relabel those earlier attempts.

This workflow alone does not qualify cursor exclusion after capture enlargement,
GUI previews, paired alpha masks, sustained performance, physical devices or
general image quality. Run the relevant packaged workflows separately. The four
earlier VFR alpha-pixel mismatches also remain unexplained: that source did not
record cursor position. New controlled evidence cannot prove their cause.

For live capture reconfiguration, add `--enlargement=true` to the corrected
candidate runs. The receiver sends the existing authenticated VDO.Ninja
`requestVideoHack` width/height messages, as used by `macos-load-recovery.js`.
It verifies 640×360 → 960×540 → 640×360 configured and received dimensions,
the native capture enlargement log, and all three pointer positions at each
size. Probes use native received pixels (40×40 or 60×60), without downsampling.

For GUI coverage, run `macos-cursor-preview.py --app ... --fixture ...
--ui-helper ... --reports ...`, then `node macos-cursor-preview-review.js REPORT`.
The GUI workflow selects the owned window, waits for the ordinary thumbnail
retry without pressing Refresh, and captures only the application and source
windows. Workflow completion and pixel qualification are separate results.
The reviewer checks selected-preview cursor regions, preview color against the
native source screenshot in sRGB, and a real thumbnail in the filtered source
list. It does not qualify cursor positions in the cached thumbnail or arbitrary
image quality. Use the helper built from the same recorded source.
