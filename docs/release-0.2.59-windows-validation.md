# Game Capture 0.2.59 Windows validation

Release candidate validation is in progress. This document does not claim that
v0.2.59 has been published or that the complete release-readiness run has passed.

## Change

The existing installed-version footer now checks the public GitHub latest-release
API asynchronously. The checker requires explicit stable/non-draft metadata and a
stable semantic-version tag. It caches attempts, last-success metadata, and whether
the latest attempt succeeded in `%LOCALAPPDATA%\GameCapture\update-check.ini`.
An unsuccessful refresh preserves the last valid metadata but displays unavailable.
Cached metadata is reevaluated against the build's `APP_VERSION` on every launch.

The request has a 10-second connection/TLS deadline, a 15-second total deadline,
and a 1 MiB response limit. Redirects, cookies, and credential reuse are disabled;
authentication requests are aborted. Certificate verification remains enabled.
Shutdown cancels the request and disconnects callbacks. The Windows package must
include `tls/qschannelbackend.dll`.

## Validation approach

The new packaged workflow runs the actual GUI, reads its footer through Windows
accessibility, clicks Releases, checks the default browser's address, records the
loaded executable and TLS-backend paths, and observes Windows sound/Alert requests.
It samples window responsiveness and verifies normal process exit during a request.
Settings and the update cache are restored after each run.

Real GitHub HTTPS runs without a URL override. Fault cases redirect only the
update URL inside the validation process to local socket/HTTP/TLS fixtures using
Frida. The production binary has no endpoint override. These fixtures exercise
actual refused connections, malformed TLS, an untrusted certificate, stalled TLS,
stalled response bodies, HTTP errors, and oversized responses. HTTPS certificate
verification is never disabled, and the fixture certificate is never trusted.
Synthetic release metadata checks draft/prerelease handling and the available UI.

The older comparison package contains the new checker with build version 0.2.58;
it is a validation artifact, not the previously published v0.2.58 executable.
The published v0.2.58 predates this feature.

## Gates and publication

The initial fresh build, all 21 CTest groups, and QA entrypoint contracts passed.
These are gates, not end-to-end testing. Completed packaged workflows and final
artifact hashes will be recorded here after the release-readiness run.

GitHub currently reports zero registered self-hosted runners for this repository.
The QA Fast Gate workflow requires a self-hosted Windows X64 runner, so CI has not
been verified for this change. Publication remains pending validation and CI.

The unrelated local `docs/release-0.2.57-installer-closeout-2026-09-07.md` file is
preserved and excluded from this change.
