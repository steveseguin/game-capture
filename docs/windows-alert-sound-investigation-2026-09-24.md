# Windows alert sound investigation — 2026-09-24

Confirmed in the packaged v0.2.57 application: ordinary status-label changes
play the Windows `SystemAsterisk` sound. Both user actions and background source
refreshes can trigger it.

## Cause and correction

`MainWindow::updateStatus()` sent `QAccessible::Alert` whenever the visible
status label changed. Qt's Windows accessibility backend handles that event by
calling `PlaySoundW("SystemAsterisk", ...)`, even without a screen reader.
See the [Qt 6.10.0 Windows accessibility implementation](https://github.com/qt/qtbase/blob/v6.10.0/src/plugins/platforms/windows/uiautomation/qwindowsuiaaccessibility.cpp#L51-L108).

That shared path is used for source selection, stream start/stop, copied-link
feedback, and runtime events. The source list also refreshes every three
seconds. When a selected window disappears, the status returns to
"Select a window to capture" and previously played a sound without any click
inside Game Capture. Switching source modes can change the status twice in
one action and request two sounds.

The correction uses a polite `QAccessibleAnnouncementEvent` on Qt 6.8 and
newer. Older Qt builds use `NameChanged` so the accessible label still updates
without a system alert. The existing changed-text and visible-label guards
remain. Message boxes and tray notifications retain their existing behavior.

## End-to-end testing

Ran the actual Windows GUI with native mouse and keyboard input, checking the
visible status text after each action. A separate controlled source window was
created and closed to exercise background refresh. Frida observed
`QAccessible::updateAccessibility`, `PlaySoundW`, `MessageBeep`, and `Beep`;
the hooks recorded calls without suppressing sounds or replacing app behavior.

| Workflow | Released v0.2.57 sound calls | Fixed build sound calls |
| --- | ---: | ---: |
| Switch to Spout2 using the source selector | 2 | 0 |
| Switch back to Window using the keyboard | 1 | 0 |
| Click the controlled window in the source list | 1 | 0 |
| Click Refresh while the selected window remains available | 0 | 0 |
| Close the source externally and wait for automatic refresh | 1 | 0 |
| Leave the resulting status unchanged for seven seconds | 0 | 0 |

Every baseline sound was `PlaySoundW("SystemAsterisk", ...)`, with the stack
passing through Qt's Windows accessibility backend. The fixed build emitted
five announcement events and zero calls to the monitored sound APIs. All
status-text assertions passed in both runs. This verifies sound requests, not
a microphone recording or subjective listening assessment.

Baseline: `native-qt/dist/game-capture-0.2.57-win64/game-capture.exe`, SHA-256
`ffe317a2a0a1234d6af7c920b64509c90300c631898f10da29964aeb88575166`, matching its
release manifest. Bundled Qt version: 6.10.0.

Fixed: Release executable staged with the same packaged dependencies at
`native-qt/dist/beep-investigation-fixed/game-capture.exe`, SHA-256
`a1be665246aba0e7bc76a8b818cfb83cd70e7832dc11763ae14df47a37e069a6`.
This is a local validation artifact, not a published release; the baseline
package was left intact. App preferences were restored after each run, and
logs were isolated through a process-specific `LOCALAPPDATA` directory.

Local reproduction script and raw event traces are in
`.playwright-mcp/beep-investigation/` (`probe.py`, `baseline-events.json`, and
`fixed-events.json`). The script uses locally installed Frida and pywinauto
dependencies under that directory.

Additional gates: Release build passed; existing main-window Qt gate reported
91 passed, 0 failed, and 1 skipped (system tray unavailable under the offscreen
platform). These gates are separate from the GUI end-to-end testing above.
The first gate invocation needed the Qt platform-plugin path corrected before
it could run. Live streaming, screen-reader speech, the older-Qt fallback, and
tray/dialog sounds were not exercised in this investigation.

## Follow-up: origin, coverage gap, and adjacent findings

The alert call was introduced by `eba6657ecdfcf12b9fb39f8241d5651d30c6e80a`
on August 24, 2026 (`fix: stabilize capture streaming and desktop UX`). The
same change added accessible names, descriptions, and keyboard/UI improvements,
so the apparent intent was to expose status changes to assistive technology.
Git records the code change, not the author's reasoning. The commit spans
28 files, with 1,453 insertions and 231 deletions.

The reviewed coverage did not establish quiet desktop behavior:

- `test_main_window.cpp::testStatusLabelUpdates` only checks the initial label
  text and word wrapping. It does not trigger a status transition or observe
  accessibility/sound events. Its fixture constructs `MainWindow(nullptr)`.
- Streaming workflows such as `refresh-e2e.js`, `control-e2e.js`, and
  `director-room-e2e.js` launch the publisher with `--headless`; that path
  does not construct `MainWindow`. Their real media-output coverage cannot
  establish the behavior of this GUI status code.
- `source-selection-packaged-e2e.ps1` does exercise the packaged Windows GUI,
  including accessible selection and automatic refresh. It checks selection,
  Go Live availability, and source titles, but does not observe sound.
- No system-sound assertion was found in the release-readiness entrypoint or
  the main-window/source-selection checks reviewed here. The sound observer
  used for the initial investigation was a local diagnostic, not an enforced
  release step at that time.

The direct `QAccessible::Alert` misuse occurred in one shared function. No
second explicit alert/beep implementation was found in production source.
A bounded follow-up audit did, however, reproduce these adjacent behaviors
in the unchanged v0.2.57 package:

1. **Custom FFmpeg validation blocks the desktop UI and hides the timeout.**
   With AV1 selected in advanced settings, setting the custom FFmpeg path to
   the repository's existing `ffmpeg_probe_hang_helper.exe` caused the edit
   operation to take 3.052 seconds. A separate observer sent `WM_NULL` with a
   100 ms timeout: 18 samples failed during the operation, with successful
   replies before and afterward. The status then read "Using custom FFmpeg:"
   followed by the helper path, without the probe's timeout error.
   `refreshFfmpegStatus()` runs the synchronous probe from `textChanged` and
   never displays `info.error`. The existing bounded/cached probe gate checks
   that timeout and caching work; it does not check desktop responsiveness or
   the resulting user-facing error. This is a confirmed additional UI defect
   under a deliberately unresponsive custom executable, not a claim that the
   bundled FFmpeg normally stalls.
2. **The close-to-tray hint is requested on every close.** Two close operations
   each called `Shell_NotifyIconW` with "Still running in system tray (next to
   the clock)" and `dwInfoFlags=0x24`, without `NIIF_NOSOUND`. The observer
   restored the hidden window with native `ShowWindow` between closes. This
   confirms repeated notification requests; Windows delivery and audible
   notification playback were not measured. Whether the hint should be
   one-time or repeatable is a UX decision, separate from the status-alert fix.

Follow-up evidence: `.playwright-mcp/beep-investigation/followup-audit-events.json`;
the local probe accepts `--audit` after its executable and run-label arguments.
At that stage both additional findings remained unchanged. This was a targeted
review of desktop side effects and their coverage, not a complete application audit.

## Correction and enforced desktop workflow

The follow-up implementation moves both the settings probe and startup preflight
off the UI thread, debounces edits, and discards results for superseded settings.
Probe errors are displayed explicitly. The tray reminder is limited to once per
app session. Runtime status and FFmpeg text use plain-text labels.

Extending the packaged workflow to the local diagnostics API reproduced another
UI stall: diagnostics synchronously re-probed FFmpeg and waited for the settings
probe's mutex. Diagnostics now read a bounded cache of completed results for the
requested configuration without starting a process or waiting for a probe.
Unknown metadata is identified through `ffmpeg_probe_error`.

`native-qt/e2e/run-desktop-ui-e2e.ps1` now runs these checks against a complete
Windows package and is required by release readiness. It observes sound APIs
without muting them, exercises source selection/removal, checks UI responsiveness
during settings validation and failed startup, checks the diagnostics API,
verifies stale-result handling, restores the window through its tray activation
callback, and quits through File -> Quit during an in-flight probe. It restores
the saved application settings and writes executable-bound JSON evidence.

The local fixed package passed this expanded workflow on September 24, including
a clean exit during a slow probe. GUI Start/Stop passed for H.264 and VP9 with
actual browser decoding at 960x540, 30 FPS; both receivers advanced 90 frames
during the three-second observation. The complete desktop run requested zero
sounds before the intentional tray reminder. Evidence is in
`native-qt/e2e/reports/desktop-ui/b5b1fde0-c007-4f25-8ba7-dab55228d300/`.
Separate window capture through a VDO.Ninja browser receiver also passed at
1280x720, 30 FPS. All 20 CTest groups passed as a gate. Release validation and
final artifact identity will be recorded separately for v0.2.58.
