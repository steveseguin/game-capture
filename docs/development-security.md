# Local security checks and manual QA

Routine commits and pushes use local secret checks. This repository does not
start QA builds or soaks on pull requests, pushes or a nightly schedule. No
GitHub-hosted secret-scan workflow or paid security add-on is required by this
setup.

## Enable the local guards

In each clone, install Python 3 and run:

```powershell
python tools/secret_scan.py install
python tools/secret_scan.py history
```

Installation downloads Gitleaks 8.30.1 from its official release and verifies
a pinned SHA-256 before extracting the executable into ignored `.tools/`.
An already downloaded archive can be supplied with `--archive PATH`; the same
checksum is required. Existing custom hooks are preserved rather than replaced.

The local `core.hooksPath` setting enables:

- **Pre-commit:** scan the staged index, even if the working copy differs.
- **Pre-push:** scan all local Git history, including deleted secrets.
- Both guards reject missing scanners or failed scans. They do not download
  tools or upload code, reports or credentials while scanning.
- `.env` files, private keys and signing bundles are ignored and also rejected
  if force-added. `.env.example`, `.env.sample` and `.env.template` are allowed
  but still scanned. Public certificate fixtures need a deliberate reviewed
  exception; do not broadly exempt a directory.

The two Gitleaks exceptions require an exact file path **and** exact matched
text: a Windows COM interface identifier and a dummy credential used by a
mocked TURN test. Other credentials in those files remain detectable. Scanner
output includes file/rule locations, never matched secret values; temporary
reports are redacted and removed when the check exits.

Git does not install hooks when cloning. Each contributor must run setup.
These are local safeguards, not server enforcement: they can be bypassed with
Git options, do not cover GitHub web edits, and do not replace review. Before
merging an outside PR, fetch/inspect its commits and run the history scan
locally. Do not execute untrusted PR code on a machine with signing material.
Game Capture's existing GitHub secret protection remains separate.

## Optional GitHub QA

**QA Fast Gate** and **QA Soak (Manual)** use `workflow_dispatch` only and
require a self-hosted Windows X64 runner. They cannot select a GitHub-hosted
runner. Both share a concurrency group, have time limits, and use read-only
repository permissions. Actions are pinned to full commit hashes, checkout
credentials are not persisted, npm lifecycle scripts are disabled, and npm
Actions caching is off.

Reports and screenshots stay on the runner by default. Explicitly enable
`upload_reports` only when needed; uploaded artifacts expire after one day.
These can contain temporary test session details, so review them before sharing.
Release downloads remain separate from QA artifacts and are unaffected.

Soak parameters are passed through environment variables, parsed as integers,
and bounded before builds begin. Manual GitHub soaks allow 1-60 minutes with
1-60 second playback holds. For longer runs, use the local QA scripts directly.
Full release qualification still requires the documented durations and actual
packaged playback workflows; these cost controls do not waive release gates.

## Check the guards locally

```powershell
python tools/check_secret_guard.py --archive PATH_TO_PINNED_GITLEAKS_ARCHIVE
```

This exercises real commits and pushes against a temporary local bare remote:
clean changes, synthetic credentials, force-added private files, narrow
exceptions, missing scanners, tampered downloads and deleted historical secrets.
It uses no GitHub Actions and never contacts a publishing remote.

Configuration references: [Gitleaks](https://github.com/gitleaks/gitleaks/tree/v8.30.1)
and [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use).
