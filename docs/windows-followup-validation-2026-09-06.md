# Windows follow-up validation, September 6, 2026

This continues the [v1.1.68 validation](plugin-1.1.68-alpha-validation-2026-09-06.md).
The publisher is the complete `native-qt/dist/qsv-pooled-upload` package,
SHA-256 `b7ae24f9ef6c1e8c86b1a33cca5aba704212b0cd994bd04959a585bb3ed1838f`.
Native application runs use isolated OBS 32.2.2 and the exact v1.1.68 DLL,
SHA-256 `09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb`.

## Actual failure workflows

Each injected fault must produce a failing probe and saved evidence. Failure is
the expected result here, not an unexpected product regression.

| Fault | Observed behavior |
| --- | --- |
| No matching Spout sender | Publisher logged the unmatched sender and exited 2; probe failed in 3.37 seconds. |
| Sender terminated as publisher starts | Same explicit unmatched-sender error, publisher exit 2, probe failed in 3.38 seconds. |
| Publisher forcibly terminated during viewing | Probe failed playback validation. This simulates abrupt termination, not an actual application crash or crash-dump test. |
| Chromium unexpectedly closed | Probe failed with a closed-browser error; publisher quit normally with exit 0. |
| Live Spout sender terminated | Browser retained a playing color track but lost fixture motion; the probe correctly failed. Publisher quit normally with exit 0. |

Evidence index: `native-qt/qa/reports/windows-fault-summary.json`; individual
artifacts are under `windows-fault-*`. The review-only injector is
`native-qt/qa/reports/windows-fault-injection.cjs`, and its batch runner is
`native-qt/qa/reports/run-windows-faults.ps1`. Only harness-owned processes are
targeted. These are failure detection/cleanup cases; previous application runs
cover source restart and viewer reconnection.

Abrupt termination exposed a small harness defect: Node reports a signal exit
with `exitCode=null`, but the probe treated that as still running. It waited an
unnecessary ten seconds and omitted the signal from the report. The probe now
checks both exitCode and signalCode and records publisherSignalCode. Repeating
the termination case failed as expected and recorded SIGTERM:
`native-qt/qa/reports/windows-fault-publisher-exit-fixed/57aa0f40-d230-4ffa-be57-989b95f419d8/results.json`.
No production connection or media logic was changed.

## Real TURN application workflows

Both checks played moving color video in the ordinary browser with audio
disabled and alpha enabled in the publisher. Receiver getStats evidence uses
the transport's selectedCandidatePairId, not merely gathered candidates.

- Browser forced to relay: selected local candidate was UDP relay through
  `turn-cae1.vdo.ninja:3478`, remote candidate was srflx. Playback passed and
  publisher exited 0. Evidence:
  `native-qt/qa/reports/windows-browser-relay/e929faf8-a060-40b7-ab2b-f922d8953966/results.json`.
- Both sides forced to relay: publisher used `--ice-mode=relay`, browser used
  iceTransportPolicy=relay. Both selected candidates were relay; playback
  passed and publisher exited 0. Evidence:
  `native-qt/qa/reports/windows-both-relay/1ea03c0f-fb7a-4815-bb62-196060d900a8/results.json`.
- Browser forced to TURN over TCP: only TCP TURN URLs were offered to the
  browser. Playback passed, and the selected local relay candidate reported
  relayProtocol=tcp. Evidence:
  `native-qt/qa/reports/windows-browser-relay-tcp/a3d0f0c4-4043-4248-935e-9887f9a57375/results.json`.

The review-only scripts are `native-qt/qa/reports/browser-relay-review.cjs` and
`both-relay-review.cjs`, derived from the hash-bound ordinary-page probe.
These establish browser VP9/color playback over real UDP and TCP TURN, not
native OBS TURN, TURN audio, TLS fallback, cellular access or physical network
switching. The TCP probe is `native-qt/qa/reports/browser-relay-tcp-review.cjs`.

## Supplemental gates

Thirty consecutive full native-media-linked fixture repetitions passed under
the streaming workload in 65.11 seconds. The new timeout diagnostics remain
enabled, but the intermittent timeout did not recur. Log:
`C:/Users/Steve/code/ninja-plugin/artifacts/gamecapture-current-review-20260906/linked-during-soak30.log`.

The release ZIP's actual install/uninstall PowerShell entrypoints were exercised
for current and legacy packages in disposable directories. Fresh install copied
the expected DLL and locale; reinstall repaired a deliberately corrupted DLL;
uninstall removed the payload while preserving an unrelated file. Evidence:
`C:/Users/Steve/code/ninja-plugin/artifacts/windows-package-install-check/results.json`.
Execution policy was bypassed only in the invoking process. These are packaging
gates, not an installer-GUI or real version-to-version upgrade validation.

## Stability run

The stability run uses QSV H.264, 1920x1080 at 60 FPS, a moving Spout alpha
fixture, output-loopback tone audio, ordinary Chromium, and native OBS alpha
samples. It requests twenty 30-second measurement windows, alternating browser
reload and publisher transport refresh. Recovery and image checks add wall time
beyond the ten minutes of measured streaming.

Artifacts: `native-qt/qa/reports/windows-next-soak/4ba1e408-0d12-4866-99b4-f56fef866d5a`.
`resources.jsonl` samples the publisher's private bytes, working set, handles,
threads and cumulative CPU time. NVIDIA readings are whole-device values and
do not measure Intel QSV utilization or attribute GPU memory to this publisher.
The run passed: 600.24 measured seconds over 764.78 wall seconds, with twenty
measurement windows, ten browser reloads and ten transport refreshes. Browser
video measured 59.978–60.035 FPS, 36,015 decoded frames, zero reported dropped
frames, freezes or lost video packets within the measurement windows. Audio
remained present in every window (RMS 0.08094–0.08103), with zero reported lost
audio packets or concealed samples. These counters describe the measured
windows after recovery, not uninterrupted presentation during each deliberate
reload. All twenty native alpha sequences passed, with 200 useful composite
screenshots. Native alpha sampling does not independently prove native 60 FPS
output cadence.

Publisher private memory ranged from 129.15 to 138.16 MiB in 23 samples; the last
sample was 129.15 MiB, below the first 129.29 MiB. Handles ranged from 721 to 744
and ended at 721. Encoder child processes were additionally sampled during the
final portion: their private memory stayed around 185 MiB and 100.5 MiB in four
samples each. This short observation does not establish hour-scale leak freedom.
Child evidence is in `encoder-resources.jsonl`.

Shutdown completed normally in 439 ms, exit 0, with zero remaining encoder
processes. The exact loaded plugin hash was verified. `summary.json` contains
the aggregate metrics and `results.json` the complete stage evidence. The
resource monitors also exited, and no Game Capture, Spout fixture or OBS process
remained. Regular OBS was not replaced.

This is a bounded session run, not a 1–2 hour soak. Audio presence is measured;
long-term A/V synchronization and drift are not established by these counters.
