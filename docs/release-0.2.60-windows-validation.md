# Game Capture 0.2.60 Windows validation

Final packaged release readiness passed in
[CI](https://github.com/steveseguin/game-capture/actions/runs/37652698292).
Both required 30-minute streaming soaks passed without retries.

## Problems found and fixed

Additional testing of the published 0.2.59 application found that incomplete
local-control requests could hold connections indefinitely. Malformed HTTP
request lines and headers were also accepted. The optional loopback server now
has a 10-second absolute connection deadline, a 32-connection limit, bounded
reads, a 16 KiB header limit, strict framing validation, and one request per
connection. Fragmented valid requests continue to work.

The MCP bridge accepted a 128 KiB discovery file and read discovery files without
a bound. It now reads at most 16 KiB plus one overflow-detection byte, requires a
regular file, and preserves UTF-8/BOM support. Failed attachment leaves the
previous valid target selected. The dependency updates reviewed alongside this
work resolve the five reported Dependabot alerts.

Capture explicitly checks for the optional Windows border interface and skips
inapplicable permission requests in unpackaged builds. The compatibility
workflow denies that interface in the actual packaged process, then verifies
real H.264 and VP9 receiver decoding. This is fault injection on Windows 11;
native Windows 10 testing was not available.

Packaging from an ordinary PowerShell session exposed a dependency difference:
`windeployqt` omitted `dxcompiler.dll`, `dxil.dll`, and `vc_redist.x64.exe` outside
the Visual Studio developer environment. The release helper now resolves and
requires those files independently and treats deployment failures as fatal.
The final package includes all 96 payload files; the three restored files match
the prior release byte for byte. The incomplete candidate was not published.

## Frozen package identity

| Item | SHA-256 / commit |
| --- | --- |
| Packaged source commit | `a8105704a013a5d7bef656cc8b8d40dd203969f3` |
| Packaged game-capture.exe | `96de368122a1cae932c3b2f3e174e63941dc08efd05ab0ff5f1a1e2a374da572` |
| Release artifact manifest | `3757b080fed50b38efa8f06d32e1ed8afa8002dc5d20144a1d440bdbba8f00aa` |
| Native source snapshot, 221 files | `27150e5d28bb4ecf1df46f0b4858c7a19736f28d13d8153127ee43f3690b1c98` |

`native-qt/qa/build-release.ps1` produced the final package from an ordinary
PowerShell session. Full CI uses that frozen package and verifies its
independently recorded manifest hash. The manifest's dirty flag records the
pre-existing untracked v0.2.57 document outside `native-qt`; that unrelated file
is preserved and excluded from this release.

After freezing the package, commit
`ba9953fa8d3f8d6a2159629012fcc5415e182018` corrects only a fuzz-workflow
assertion. Runtime source and all release artifacts are unchanged.
Commit `74c357be8c4643d5e117090f4a7f900949257d4a` adds browser candidate
acceptance results to the signaling evidence, also without runtime changes.
Commit `6f0415ce8d2dc6218bd6c18cd19b87ffdb41e74d` binds desktop automation to
the unique visible native window handle; it changes only the GUI workflows.
Commit `d18bf0a5b161906804a2d1ada99cde9d7f157783` selects visible codec options
by label instead of racing popup focus with keyboard navigation.

The EXEs carry the existing project's signing certificate and a DigiCert
timestamp. Windows reports the self-signed root as untrusted; this is not a
publicly trusted-signature claim. VirusTotal submission was skipped.

## Additional packaged workflows

The new local-control workflow exercises malformed framing and authentication,
oversized headers/bodies, fragmented Unicode reports, deeply nested and random
JSON commands, partial and trickling connections, connection saturation,
request pipelining, concurrent clients, recovery, and clean shutdown. Release
readiness runs 256 JSON inputs for each of three deterministic seeds:
`2601007`, `42`, and `4294967295`.

The MCP edge workflow uses the real SDK client, bridge, packaged application,
Spout source, and Edge receiver. It covers simultaneous launches, invalid tool
arguments, malformed/stale/oversized discovery files, exact-limit and BOM files,
token redaction, external ownership, disconnect during startup, and clean exit.
A source name containing spaces, quotes, and an ampersand is streamed while 256
mixed HTTP requests run concurrently; receiver frame advancement is verified.

Before the final CI run, the corrected MCP workflow passed 142 assertions.
Additional checks against the frozen final executable accepted fragmented
requests totaling 65,536, 900,000, and exactly 1,048,576 bytes, and rejected a
request totaling 1,048,577 bytes. User settings were restored afterward.

The final run 37652698292 passed all three local-control seeds: **291 assertions each,
873 total**, including the new immediate health check after oversized input.
The packaged desktop workflow passed 22 assertions, and capture without the
optional border interface passed 32 assertions.
Its MCP edge workflow passed all 142 assertions. The accompanying normal
MCP workflow verified real H.264 and VP9 receiver playback and recovery, stopping
streams, owned-process cleanup, and preservation of an externally attached app.

Its update workflow passed **592 assertions and 5,689 responsiveness
samples**, with no update sounds or accessibility alerts and with settings
restored. It verified the loaded packaged executable and Schannel module paths,
made real GitHub HTTPS requests, read the visible footer, clicked the actual
Releases link, and confirmed the default browser's address was
`https://github.com/steveseguin/game-capture/releases`.

Actual socket/HTTP/TLS fixtures exercised DNS failure, connection refusal,
untrusted certificates, malformed TLS, authentication challenges, rate limits,
server errors, rejected redirects, malformed/truncated/oversized/compressed
responses, and stalled or trickling transfers. Certificate verification remained
enabled. Measured timeouts were **10.09 seconds** for connection/TLS,
**15.02 seconds** for a stalled body, and **15.03 seconds** for a trickling body.
The workflow also verified prerelease/draft exclusion, restart suppression,
pending-request shutdown, forced termination, cached failures and recovery,
clock correction, daily expiry, corrupt/oversized caches, and locked/unwritable
cache recovery. This uses process-local URL interception for fault fixtures;
production has no configurable update endpoint and real GitHub cases use none.

The full signaling suites passed **107 checks in each of Edge, Playwright
Firefox, and installed Firefox**. Control Center negotiation passed **58 checks
in each browser**. That run's Edge relay-only case passed with the added
candidate diagnostics. Dual-quality roles, churn, initialization fuzz, and
requirements passed. The OBS seven-case transparency matrix passed.

The dual-quality soak passed **four runs and 309 viewer join/decode cycles over
1,825 seconds**, without retries. The separate playback soak passed **five runs
and 100 iterations over 1,804 seconds**, also without retries. The configured
retry allowance in the reports was not used.

Independent bounded probes recorded 94 successful TURN-HTTP/WebSocket pairs
through the final run. Resource sampling recorded 86 observations across 36
publisher process IDs: peak sampled working set 279.1 MiB, private bytes
340.7 MiB, and 1,010 handles. These observations do not establish that all
possible network failures or memory leaks are excluded.

The first CI attempt stopped before application testing because the runner had
not loaded the Visual Studio compiler environment. The runner wrapper was
corrected before starting the linked final run. Failed and preliminary reports
remain available; they have not been rewritten as passes.

A subsequent run was canceled after an oversized-request assertion required an
HTTP 400 response even when Windows correctly reset the connection because
unread input remained. That case now accepts either HTTP 400 or a confirmed
connection close, still rejects timeouts, and immediately verifies application
health. It passed again against the unchanged frozen executable before the full
rerun. Registry settings were restored from the preceding workflow's snapshot;
the interrupted update fixture's cache was replaced with the real GitHub result
recorded earlier in that run. A durable user-state backup was made before the
final CI run.

The next run passed the desktop, compatibility, fuzz, MCP, and update workflows
but failed one Edge relay-only connection. The equivalent Firefox case passed.
That run was canceled for investigation and its reports were preserved. Six
focused Edge relay workflows then passed: three against downloaded v0.2.59 and
three against the unchanged v0.2.60 candidate, each proving real data and media
over a relay pair. The earlier failure was not reproduced and its cause is not
claimed as resolved. Candidate-acceptance diagnostics were added before another
full CI run; no networking requirements were relaxed and no runtime networking
code was changed in response.

Run [37628941242](https://github.com/steveseguin/game-capture/actions/runs/37628941242)
passed every required stage except the separate playback soak. Its first three
24-iteration segments passed; segment four lost viewer playback on iteration
23. The retry logged timeouts fetching the TURN registry and connecting to the
signaling WebSocket, then exited cleanly with code 3. The soak stopped after
1,761 seconds, so it does not satisfy the required 30-minute playback run.
That run's dual-quality soak passed independently over 1,834 seconds.

Afterward, the TURN endpoint returned HTTP 200, the signaling WebSocket handshake
completed in 164 ms, and both downloaded v0.2.59 and the unchanged candidate
passed three fresh browser-playback iterations. These establish subsequent
reachability and playback recovery; they do not establish the cause of the
earlier interruption. A new full readiness run was started without changing the
application, reducing any required duration, or relaxing the failure criteria.

During the failed full run, 50 process-resource samples covered eight observed
publisher processes. Peak sampled working set was 273.8 MiB, private bytes
338.2 MiB, and handle count 886. These are observations, not a proof that all
possible leaks are excluded.

The subsequent rerun encountered a UIA lookup with two matching title/process
entries during a rapid application restart in the update workflow. Its settings
were restored, and the run was canceled. The desktop helpers now enumerate the
actual process's visible, unowned Win32 window and bind UIA to its handle. They
still fail if multiple real visible main windows exist. Real GitHub checking and
a cached restart then passed 22 assertions, and the shared desktop workflow
passed 22 assertions. The current CI run includes this harness correction and
independent bounded network-reachability samples.

Run 37645693531 was canceled after the desktop workflow's keyboard codec
navigation selected H.265 instead of the intended AV1. The failure screenshot
showed a responsive application with the wrong selection. The workflow now
clicks the actual visible option by its label for every codec transition. Three
complete packaged GUI repeats passed afterward (22, 32, and 22 assertions),
including missing-border-interface capture, H.264/VP9 browser decoding, stalled
FFmpeg recovery, and quit during a pending probe. Each restored user settings.

Run 37649678980 lost its runner during the assistant server restart, after the
build gate and before packaged application workflows. GitHub continued showing
the offline job as active; it was canceled and its runner logs retained. The
replacement runner is launched independently from the assistant tool session.

## Final readiness and publication

All required readiness stages passed. Coverage includes the actual desktop and update
footer, real network failures, missing capture interface, all three HTTP fuzz
seeds, MCP controls and edge cases, browser and OBS playback, encoder policies,
and both 30-minute soaks. Build, CTest, static contracts, installer construction,
dependency audits, and artifact identity checks are gates, not application
testing.

Auto, software, NVIDIA, and Intel encoder policies passed. The AMD-specific
workflow was not run because no AMD adapter was available. All eight release
assets and the manifest were rehashed after readiness and remained unchanged;
runtime source also remains unchanged from the packaged source commit.

Draft upload, downloaded-asset verification, and post-publication old/new
version checks are the remaining publication steps.

The current process is not elevated, so an actual administrator installer /
firewall / uninstall workflow is not claimed. Packaged application testing
uses the release payload directly.

## Evidence

- [Final full release-readiness CI](https://github.com/steveseguin/game-capture/actions/runs/37652698292).
- `native-qt/qa/reports/control-fuzz-baseline/8d7282e47f144a80837a30e3d144fc7b/results.json`.
- `native-qt/qa/reports/control-fuzz-fixed/7edc6fdb7c0541e98184fde877fbe9ce/results.json`.
- `native-qt/qa/reports/control-body-boundary-0.2.60/results.json`.
- `native-qt/qa/reports/mcp-edge-e2e/1791376314714/results.json` (baseline).
- `native-qt/qa/reports/mcp-edge-e2e/1791376445127/results.json` (corrected).
- `native-qt/build-reliability-final-package.log` and `build-reliability-detached-ci.log`.
- `native-qt/qa/reports/release-0.2.60/ci-final/release-readiness-20261007-123856.md`.
- `native-qt/qa/reports/release-0.2.60/ci-final/dual-quality-soak-2026-10-07T17-47-47-131Z.md`.
- `native-qt/qa/reports/release-0.2.60/ci-final/soak-2026-10-07T18-17-51-035Z.md`.
- `native-qt/qa/reports/release-0.2.60/final-observation-summary.json`.
- `native-qt/qa/reports/release-0.2.60/ci-framing-assertion/` (canceled run).
- `native-qt/qa/reports/release-0.2.60/ci-edge-relay-failure/` (canceled run).
- `native-qt/qa/reports/release-0.2.60/ci-playback-network-failure/` (failed full run).
- `native-qt/qa/reports/release-0.2.60/ci-uia-ambiguity/` (canceled run).
- `native-qt/qa/reports/release-0.2.60/ci-codec-selection-race/` (canceled run).
- `native-qt/qa/reports/desktop-codec-fixed-{1,2,3}/` (three passing GUI repeats).
- `native-qt/qa/reports/update-check-hwnd-fixed-live/results.json`.
- `native-qt/qa/reports/desktop-hwnd-fixed/4f5635df-9d30-4d36-acb4-763a3ed43cb5/results.json`.
- `native-qt/build-reliability-full-ci.log` and `build-playback-network-recovery.log`.
- `native-qt/qa/reports/release-0.2.60/signaling-recovery-probe.json`.
- `native-qt/qa/reports/release-0.2.60/soak-resource-samples-ci-37628941242.jsonl`.
- `native-qt/qa/reports/relay-reliability-repro/` (six passing focused comparisons).
- `native-qt/qa/reports/release-0.2.60/local-assets.json`.
