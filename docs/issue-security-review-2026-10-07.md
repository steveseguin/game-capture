# Issue and dependency review — October 7, 2026

## Issue disposition

- [#2: crash after Go Live](https://github.com/steveseguin/game-capture/issues/2):
  the reported Windows 10 failure concerns the optional
  `IGraphicsCaptureSession3` interface. Capture now queries that interface with
  `try_as` before setting `IsBorderRequired`. It also skips the borderless consent
  request without package identity, and checks that the consent API exists before
  using it. These changes are on `main` for the next binary release.
- [#3: custom resolution](https://github.com/steveseguin/game-capture/issues/3):
  still valid, retained open and labeled `enhancement`. The GUI still offers
  1920×1080, 1280×720, and 960×540 for window output; arbitrary or higher output
  resolutions are not implemented in that selector.

The missing border property is documented by
[Microsoft](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired):
it requires build 20348 / Universal API Contract v12. An explicit interface query
avoids relying on how a particular C++/WinRT projection handles an unavailable
interface.

The downloaded v0.2.59 package already survived an injected `E_NOINTERFACE`
during H.264 startup. That baseline workflow then failed the new assertion about
skipping the unnecessary consent request. It did **not** reproduce the original
v0.2.55 access violation. The explicit guard is nevertheless appropriate for the
reported root cause. No native Windows 10 host was available: the compatibility
condition was exercised inside real Windows 11 capture sessions.

## Dependency changes

[Dependabot PR #4](https://github.com/steveseguin/game-capture/pull/4) was reviewed,
installed with `npm ci --ignore-scripts`, exercised, and merged as `570aa1f`.

| Dependency in the optional MCP bridge | Previous | Updated | Alerts |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.31.0 | #25 |
| `proxy-addr` | 2.0.7 | 2.0.8 | #24 |
| `fast-uri` | 3.1.7 | 3.1.8 | #23 |
| `ip-address` | 10.7.0 | 10.7.3 | #21, #22 |

GitHub marks all five alerts **fixed**, with zero open Dependabot alerts after the
merge. `npm audit` reports zero vulnerabilities for both `native-qt/tools/mcp`
and `native-qt`. These are dependency gates, not end-to-end testing or a claim
that all possible vulnerabilities have been eliminated.

The bridge uses MCP stdio and a token-protected loopback app API. It does not use
the HTTP OAuth client implicated in the
[SDK advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h),
or run an Express HTTP server. Updating the lockfile removes the vulnerable
packages even though those specific network paths are not used here.

[PR #1](https://github.com/steveseguin/game-capture/pull/1), requesting `ws` 8.20.1,
was closed as superseded: the main manifest and installed lockfile already use
8.21.0. The MCP bridge is distributed from source separately from the Windows app;
pull the current source and repeat `npm ci --prefix native-qt/tools/mcp
--ignore-scripts` to update an existing bridge installation.

## Completed application testing

The updated MCP dependencies ran against the **downloaded v0.2.59 release
executable**, SHA-256
`2118f31581a03d216e30029e8d32091262bf1c1ee3497c43f723de2e2a9d5ebd`.
The official MCP client exercised tool discovery, app launch and attachment,
schema/status, all source lists, logs, reports, error handling, monitoring,
transport recovery, stop, export, quit, and disconnect ownership. Non-loopback
attachment was rejected and bearer tokens stayed out of MCP output.

Real Edge playback passed for H.264 and VP9 alpha, before and after transport
recovery. Each three-second sample decoded 89–90 frames. Native OBS received the
VP9 alpha stream and passed moving-alpha checks before and after recovery. Its
four-second recording contained 120 frames, 119 changing-frame transitions,
no held frames, and no render or output skips.

The capture hardening was compiled in Release configuration and staged with the
downloaded v0.2.59 runtime. This **unreleased candidate**, SHA-256
`3f668bef679ed7e7e865fba22a37376546c7e1981e04697309f3a7344cf1cc6d`,
is separate from the unchanged published release assets. It passed:

- **30 GUI assertions** on the supported Windows 11 border API path.
- **32 GUI assertions** with `IGraphicsCaptureSession3` returning
  `E_NOINTERFACE`, including the documented PowerShell runner.
- Actual source selection, Go Live, H.264 and VP9 browser decoding, stop/restart,
  source removal, FFmpeg timeout responsiveness, tray behavior, and clean exit
  during a probe. Both runs restored application preferences.

The observer verified the executable path and each codec's actual capture-session
query. Fault injection changes only that optional COM query result; frame
capture, encoding, signaling, and playback remain real. The supported path still
requests the border preference; the unsupported path never calls that property.
Neither candidate path attempts consent without package identity.

An initial supported-path run exposed a test-harness race: an accessibility node
had no automation ID during source removal. The selector now tolerates that
missing ID. Its completed rerun passed; the earlier failure remains recorded.

Release compilation, source-lifetime, and QA-entrypoint contracts passed as gates.
The dependency PR's CI job was queued without an available Windows runner and
was canceled after merge; this review does not claim a new CI pass. The testing
above ran locally against the actual packaged application and staged candidate.
No additional desktop release was published during this review.

## Local evidence

- `native-qt/qa/reports/mcp-e2e/1791374474359/results.json` and
  `obs/obs-runtime-results.json` in the same directory.
- `native-qt/qa/reports/issue-2-baseline/f48629ee-eb7a-413d-83fc-8a42bc973bc6/results.json`.
- `native-qt/qa/reports/issue-2-fixed-supported/c7a662bb-933e-4e11-80e9-7f96f965742f/results.json`.
- `native-qt/qa/reports/issue-2-fixed-unsupported-final/f9d531d1-ff23-4980-9267-40dfdae6ef44/results.json`.
- `native-qt/qa/reports/issue-2-fixed-package/compatibility-validation-manifest.json`.
- `native-qt/.cache/mcp-audit-after.json` and `native-audit-review.json`.

The unrelated local `docs/release-0.2.57-installer-closeout-2026-09-07.md` remains
untouched and untracked.
