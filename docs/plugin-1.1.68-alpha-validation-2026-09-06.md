# Game Capture with OBS plugin v1.1.68

This review uses the exact Windows v1.1.68 plugin from
`C:/Users/Steve/code/ninja-plugin/_downloads/v1.1.68/current`, rather than the
different plugin artifact used in earlier Game Capture runs. The package's
`obs-vdoninja.dll` SHA256 is
`09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb`.
Portable OBS 32.2.2 and the plugin were copied into an isolated runtime under
`native-qt/qa/reports/ninja-168-runtime`; each application run verified the loaded
DLL path and hash. The original portable OBS configuration was not used for
these native application runs.

## Blank-browser failure: old executable confirmed

The plugin repository's historical `artifacts/windows-v1.1.68/review-browser.ps1`
hardcodes Game Capture 0.2.52. Its `review-browser.cjs` probe was copied unchanged
and run twice with OBS closed. Both runs used Spout's 640x360 moving-alpha fixture,
VP9 alpha output at 1280x720/30 FPS, no publisher audio, and the ordinary
`cleanoutput=1&noaudio=1` VDO.Ninja viewer. Separate unique stream IDs prevented
stale session overlap.

| Publisher | Page's own video before diagnostic intervention | Alpha transceiver |
| --- | --- | --- |
| Packaged 0.2.52 | Blank: width 0, readyState 0, time 0; selected muted MID `video-alpha` | `recvonly` in browser |
| Current pooled-upload package | Playing: 1280x720, readyState 4, time 19.168 s; selected unmuted MID `video` | `inactive` |

For 0.2.52, separately attaching the color receiver produced playable 1280x720
video at time 28.102 s, while the original page remained blank. That intervention
diagnoses the old failure; it does not count as ordinary-page success. The
current package was already playing before any diagnostic elements were added.

Old publisher SHA256:
`153c397f8f06114e3178983e7fa0def3a3be4e69ab0b462597ef7648e77da87d`.
Current publisher (`native-qt/dist/qsv-pooled-upload/game-capture.exe`) SHA256:
`b7ae24f9ef6c1e8c86b1a33cca5aba704212b0cd994bd04959a585bb3ed1838f`.
Identical browser probe SHA256:
`a47c58719af2a988143f5196ed3a48f6d89254647ad0018864e009f7b6093a6f`.

Evidence lives in the plugin repository at
`artifacts/gamecapture-current-review-20260906`: `old-alpha.json`,
`current-alpha.json`, their manifests/screenshots/logs, and `compare-browser.ps1`.
The older review artifacts remain intact.

The existing Game Capture fix is `7e4d6a5b`: reserve the optional alpha
transceiver but keep it inactive until that receiver advertises alpha support.
The current executable includes it. This comparison establishes an outdated
publisher-package problem; it does not indicate a v1.1.68 compositor regression.

## Exact audio-disabled browser plus native alpha workflow

The new `native-qt/e2e/alpha-track-review.js` runs the packaged publisher and
portable OBS. It never attaches receiver tracks to diagnostic video elements.
Instead, it maps each ordinary page video track to its receiver MID, records
SDP and per-receiver statistics, requires advancing playback, and checks the
fixture's moving blue pixels. Ordinary-browser alpha must remain inactive.

With the current publisher and the exact v1.1.68 DLL, all five stages passed:

1. Ordinary browser alone.
2. Native OBS alpha viewer attached.
3. Browser reload while native alpha is active.
4. Publisher transport refresh with both viewers connected.
5. Native viewer closed while the browser remains connected.

The ordinary page selected unmuted MID `video` throughout; no page video element
selected `video-alpha`. Native OBS passed ten useful moving-alpha composite
samples both before and after transport refresh. The publisher exited normally
with code 0. Screenshots also show the ordinary page's color fixture.

Artifacts:
`native-qt/qa/reports/plugin-168-alpha-track/cce732b4-4274-4f43-af69-43d55d287282`.
Its `results.json` records the loaded DLL path and hash, selected tracks, SDP,
playback times, pixel motion, native composite evidence, and publisher exit.

```powershell
$env:NODE_PATH = (Resolve-Path native-qt/qa/reports/receiver-runtime/node_modules).Path
node native-qt/e2e/alpha-track-review.js `
  --publisher=native-qt/dist/qsv-pooled-upload/game-capture.exe `
  --sender=native-qt/build-review2/bin/spout_test_sender.exe `
  --reports=native-qt/qa/reports/plugin-168-alpha-track `
  --obs-plugin-repo=native-qt/qa/reports/ninja-168-runtime `
  --expected-plugin-sha256=09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb
```

## 60 FPS native recovery and output quality

Both complete packaged workflows passed with the exact v1.1.68 DLL: 1280x720
at 60 FPS, combined resolution/bitrate/FPS changes to 640x360 at 30 FPS and back,
ordinary browser reload, native half-opacity composites, transport refresh,
5% native RTP loss, signaling outage, source restart, and normal publisher exit.
These workflows included the tone audio omitted from the focused probe above.

| Encoder | Native color/audio/alpha packets dropped | OBS recordings, distinct frames/s | Half-opacity max error | Publisher shutdown |
| --- | --- | --- | --- | --- |
| QSV H.264 | 108 / 61 / 36 | 59.88 / 59.88 / 59.88 | 1/255 | 429 ms |
| Software VP9 | 62 / 68 / 35 | 59.38 / 59.88 / 59.88 | 1/255 | 439 ms |

All six actual OBS recordings contained approximately 440 Hz audio, no clipped
samples, and no silent 100 ms windows after trimming 0.5 seconds at each end.
Half-opacity screenshots measured RGB `(143,48,254)` against `(143,48,255)`
before and after transport refresh. The ordinary browser's measured recovery
windows stayed near 60 FPS. Publisher shutdown was unforced and left no encoders.

Artifacts:
`native-qt/qa/reports/plugin-168-native-loss/8bfb543d-5e85-4e4c-ad67-e1a08d172702`,
including `results.json`, `native-loss-analysis.json`, actual OBS recordings,
composite screenshots, relay counters, and loaded-plugin identities.

## Separate RTC fixture timeout

The saved v1.1.68 failure log stops at `dc-offer-transport connecting`, then
fails the helper's 30-second sender-channel readiness wait. It does not reach
the separate-media-peer offer behavior under review. Reading the fixture found
no validated lost-candidate or callback defect; its relay queues candidates until
the remote description is installed. Earlier successful repetitions do not
explain the intermittent failure.

The plugin checkout now has a focused diagnostic addition in
`tests/native-media-linked/main.cpp`: on that timeout, capture both peers'
connection, ICE, gathering and signaling states, description presence, selected
candidate pair, each sender channel's open/closed state, and relay progress.
The callback-state lock is released before querying transport and relay locks.
The timeout remains 30 seconds, with no added retries. This is diagnostic
instrumentation, not a claim that the intermittent failure has been fixed.
The plugin diagnostic change is local commit `9bbb008`, based on the existing
checkout at `501f356`; its pre-existing commits and worktree changes were retained.

The Release diagnostic target compiled, and 20 consecutive repetitions of the
full native-media fixture group passed in 51.59 seconds with OBS stopped. The
intermittent timeout did not recur, so its cause remains unresolved and the new
timeout-reporting branch was not exercised by those repetitions. Clang-format
14.0.6 and whitespace gates also passed. These gates are distinct from the
actual packaged browser/OBS testing above. Log:
`C:/Users/Steve/code/ninja-plugin/artifacts/gamecapture-current-review-20260906/linked-repeat20.log`.

No plugin implementation or released DLL was changed. The browser fix already
exists in Game Capture; the corrective action for the historical review is to
use the current publisher executable and bind the evidence to its hash. The new
focused probe makes ordinary-page track selection an explicit pass/fail condition.
This review does not establish WAN/TURN behavior or explain the separate fixture
timeout.
