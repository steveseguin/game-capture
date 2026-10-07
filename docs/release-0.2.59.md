# Game Capture v0.2.59

Game Capture's version footer now quietly checks this project's GitHub releases
about once every 24 hours. A successful check displays **You're up to date**, or
**New version available: vX.Y.Z** and a **Releases** link that opens the release
overview in your default browser.

- Checks exclude drafts, GitHub prereleases, and prerelease version tags even
  when a release is accidentally marked stable. Numeric semantic-version
  comparisons ignore build metadata and never recommend an older stable version
  to a newer development build.
- Check attempts and the last valid release metadata survive restarts. Cached
  metadata is compared with the installed build version after an upgrade.
- Offline connections, TLS failures, rate limits, malformed or oversized
  responses display **Update check unavailable** without popups or sounds.
- Requests run asynchronously with a 10-second connection limit, a 15-second
  total limit, bounded response storage, and cancellation on application exit.
- Windows packages include Qt's Schannel HTTPS backend and keep certificate
  verification enabled. Only public release metadata is requested; no settings,
  credentials, or media are sent. No automatic downloads or installation.

Validation and publication status are recorded in
[the Windows validation report](https://github.com/steveseguin/game-capture/blob/main/docs/release-0.2.59-windows-validation.md).
