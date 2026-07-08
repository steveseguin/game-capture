# FFmpeg Alpha Release Plan

Date: 2026-07-07
Status: initial implementation complete; release compliance/source-hosting review still required
Scope: Windows Game Capture releases, VP9 alpha, Spout2 transparency, chroma fallback, and FFmpeg distribution.

## Goal

Ship a Windows Game Capture build where transparent Spout2 and window sources work reliably without asking users to install FFmpeg themselves.

The desired default user path is:

1. Install or run Game Capture.
2. Select a Spout2/window source.
3. Use either VP9 alpha for the VDO.Ninja OBS native receiver or chroma background for H.264/NVENC.
4. Avoid silent alpha loss, random system FFmpeg behavior, and opaque fallback when the user explicitly selected the alpha workflow.

## Current Confirmed Facts

- The repository license is AGPL-3.0.
- VP9 alpha support currently depends on `ffmpeg.exe` with `libvpx-vp9`.
- Current Windows CMake logic stages a deterministic `VERSUS_FFMPEG_ROOT` bundle, defaulting to `native-qt/third_party/ffmpeg-win64`.
- Current installer logic installs bundled FFmpeg under `ffmpeg/` and removes it on uninstall.
- Current release packaging creates staged zip, portable, and installer artifacts from `native-qt/qa/build-release.ps1`.
- The release script now validates a pinned FFmpeg bundle, fails release packaging when the bundle is absent unless explicitly allowed, and emits a versioned FFmpeg source/build-info archive.
- The current resolver checks explicit config, then bundled app-local paths, then development overrides. Arbitrary PATH FFmpeg is gated behind `VERSUS_ALLOW_SYSTEM_FFMPEG=1`.
- README text no longer tells users to add FFmpeg to PATH; it points to the bundled FFmpeg and explicit custom path override.
- Earlier workflow validation proved the VP9-alpha transport path with a temporary FFmpeg build; current validation covers the packaged release staging path with bundled FFmpeg.
- Current packaged-artifact validation shows the staged release build uses bundled FFmpeg, ignores a fake PATH `ffmpeg.exe`, fails visibly when bundled FFmpeg is missing, and passes OBS native receiver alpha pixel checks.
- The current VP9 alpha path uses an external `ffmpeg.exe` process over stdin/stdout. `video_encoder.cpp` also has conditional libav include support behind `VERSUS_HAS_FFMPEG`; this plan does not change Game Capture into an FFmpeg-library-linked application.

## External Constraints

These are planning inputs, not legal advice.

- FFmpeg states that it is LGPLv2.1-or-later by default, but optional GPL or nonfree components can change redistribution obligations. Source: https://www.ffmpeg.org/legal.html
- FFmpeg's own compliance checklist says to build without `--enable-gpl` and without `--enable-nonfree`, distribute matching source, document the exact build, include notices, and avoid GPL libraries such as libx264. Source: https://www.ffmpeg.org/legal.html
- WebM says VP8/VP9 are available for no charge and covered by a patent grant, while also noting third-party patent-pool demands cannot be made impossible. Source: https://www.webmproject.org/about/faq/
- AOMedia publishes a no-charge, royalty-free patent license for AV1 implementations with conditions and defensive termination language. Source: https://aomedia.org/license/patent-license/
- Shipping a separate FFmpeg executable is still distribution of FFmpeg. It avoids linking Game Capture against FFmpeg libraries, but it does not remove FFmpeg source, license, notice, and provenance obligations for the bundled binary.

## Product Decisions For This Plan

- Bundle FFmpeg by default in Windows release artifacts.
- Do not show an installer checkbox for FFmpeg. This is a runtime dependency for advertised VP9 alpha behavior, and making users choose creates support burden.
- Do not add FFmpeg to PATH.
- Do not automatically prefer arbitrary PATH-installed FFmpeg in release builds.
- Keep a user-controlled FFmpeg path override in the UI and CLI for advanced users and diagnostics.
- Keep environment-variable override support for development and CI, but make it clearly lower priority than an explicit UI/CLI path and suitable bundled path.
- Defer adding `game-capture.exe` itself to PATH until headless CLI workflows are more formalized and there is a separate installer decision for that feature.
- Use native/system H.264/H.265 encoders through Media Foundation where possible. Do not bundle software AVC/HEVC encoders.
- Target a distributable FFmpeg build that is LGPL-compatible and includes libvpx for VP8/VP9.
- Do not use `--enable-gpl`.
- Do not use `--enable-nonfree`.
- Do not include libx264, libx265, libxvid, libfdk_aac, or other GPL/nonfree codec libraries in the bundled FFmpeg.
- Treat the bundled FFmpeg as part of the release artifact: it needs pinned provenance, source/build info, checksums, and notices.
- Prefer an isolated bundled layout such as `ffmpeg/bin/ffmpeg.exe` for dynamic builds so FFmpeg DLLs do not pollute the app root or collide with Qt/runtime DLLs.

## Compliance Model

The intended release model is:

- Game Capture remains the app executable and invokes FFmpeg as a child process.
- FFmpeg is distributed as a separate executable bundle, not linked into `game-capture.exe`.
- The release bundle must include FFmpeg notices and must provide matching FFmpeg and dependency source/build information.
- The bundled FFmpeg build must be LGPL-compatible by construction.
- The release cannot depend on a random system FFmpeg to satisfy advertised VP9 alpha behavior.
- A user-supplied FFmpeg override is allowed, but that is an explicit user/admin choice. The project should warn or block based on missing features, but the bundled-release compliance target applies to the bundled FFmpeg.
- Any future switch to linking against FFmpeg libraries is a separate licensing and architecture decision, not covered by this plan.

## Open Questions To Resolve Before Coding

### FFmpeg Build Source

Unknown: whether to self-build FFmpeg or consume a third-party prebuilt.

Recommendation: self-build or create a fully auditable pinned build pipeline unless a prebuilt package can provide exact source, configure line, dependency license inventory, reproducible version pinning, and redistribution terms.

Decision criteria:

- Exact FFmpeg git tag or release tarball is pinned.
- Exact dependency versions are pinned.
- Configure line is committed or generated into a manifest.
- Binary provenance can be explained in release notes.
- Matching source archive can be hosted beside release assets.
- Build can be reproduced by another maintainer.
- The selected process produces a license/dependency inventory, not only `ffmpeg.exe`.
- The process can be repeated when an FFmpeg security update lands.

### Static vs Dynamic FFmpeg Bundle

Unknown: whether the safest Windows package is a single `ffmpeg.exe` or `ffmpeg.exe` plus FFmpeg DLLs.

Recommendation: investigate a dynamic LGPL build first because it makes DLL inventory and LGPL boundaries easier to inspect. This is not because Game Capture links to FFmpeg; it does not in the current VP9 alpha path. If a static `ffmpeg.exe` is chosen, verify the obligations for every compiled-in external library and document why the single-binary package is still redistributable.

Decision criteria:

- The packaged files are understandable to users and AV scanners.
- LGPL relinking/source obligations are satisfied.
- Installer, portable SFX, and zip artifacts include every required DLL or support file.
- The app can reliably locate the intended bundled binary.
- FFmpeg DLLs, if any, are isolated under an FFmpeg subdirectory instead of being scattered into the app root.
- The chosen layout works with Windows DLL search rules without adding anything to PATH.

### Codec/Library Inclusion

Unknown: whether bundled FFmpeg should include AV1 immediately.

Recommendation for first bundled release:

- Required: FFmpeg CLI, rawvideo demuxer, IVF muxer, libvpx VP9 encoder.
- Include if low-risk after audit: VP8 via libvpx and FFmpeg scale/format/rawvideo support.
- Defer unless explicitly needed: libaom AV1, SVT-AV1, rav1e.
- Defer audio libraries unless an actual Game Capture FFmpeg path needs them.
- Exclude: libx264, libx265, GPL filters/codecs, nonfree CUDA/NPP paths, fdk-aac.

AV1 can be a second step after the VP9 alpha release is stable. It is not needed for Leah's Spout2/OBS alpha workflow.

Current implementation note: the first working bundle uses the pinned BtbN LGPL shared build `ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip`. It is GPL/nonfree clean and includes `libvpx-vp9`, but it also includes a broader LGPL/permissive dependency set than Game Capture strictly needs, including AV1 libraries, hardware encoder wrappers, and `libopenh264`. Before treating this as the long-term release bundle, review whether to replace it with a smaller self-built FFmpeg that only includes the required rawvideo/format/scale/libvpx pieces.

### FFmpeg Hardware Encoders

Unknown: whether to expose FFmpeg NVENC/QSV/AMF from the bundled FFmpeg.

Recommendation: do not rely on bundled FFmpeg for hardware AVC/HEVC in the first safe distribution pass. Keep Game Capture's native Media Foundation path for H.264/H.265 hardware where available. Advanced users can still select their own FFmpeg through the explicit override.

Reasons:

- The alpha workflow needs VP9/libvpx, not hardware H.264.
- Shipping wrappers for patented codec paths adds legal and support questions.
- Native Media Foundation keeps the actual AVC/HEVC implementation in the user's OS/driver stack rather than in the shipped FFmpeg bundle.

### Patent Risk Boundary

Unknown: the exact commercial/patent exposure for every codec in every jurisdiction.

Working boundary:

- VP8/VP9/libvpx are acceptable for the planned bundle, subject to including notices and license text.
- AV1 is likely acceptable after license and dependency audit, but not required for this release.
- AVC/HEVC software encoders are out of scope for bundled FFmpeg.
- If Steve wants a hard legal guarantee, this needs lawyer review. The engineering plan can reduce risk; it cannot make codec patent risk literally zero.

### Release Artifact Size

Unknown: final package size increase.

Decision criteria:

- Measure setup, portable, and zip sizes before and after adding FFmpeg.
- If the size increase is acceptable, keep no installer choice.
- If it is not acceptable, prefer a separate "full" artifact over asking ordinary users about FFmpeg during install.

### VirusTotal / Reputation Impact

Unknown: whether bundled FFmpeg changes AV detections.

Decision criteria:

- Submit setup and portable artifacts through the existing VirusTotal release step.
- Track whether detections point at FFmpeg files or the SFX wrapper.
- If detections increase materially, test dynamic vs static packaging and code-signing order.

### Source Hosting And Notices

Unknown: exact source-hosting mechanics for FFmpeg and dependency source.

Recommendation: upload a source/build-info archive as a release asset beside the Windows binaries and link it from README/docs/download pages.

Current implementation note: release packaging creates `game-capture-<version>-ffmpeg-source-info.zip` and the stable `game-capture-ffmpeg-source-info.zip`. These archives contain build/provenance info, checksums, source URLs, and license files. They do not currently mirror every corresponding source tarball. Decide before release whether upstream source URLs plus build info are sufficient for this distribution model or whether the release should also upload a full matching source archive.

Decision criteria:

- The source archive corresponds exactly to the shipped FFmpeg binary.
- The release notes or download page identify where the source archive is.
- Notices are present inside installed, portable, and zip builds.
- The process is repeatable for stable aliases and versioned artifacts.

### Security Update Cadence

Unknown: how often bundled FFmpeg should be refreshed.

Recommendation: tie FFmpeg updates to release readiness, with an explicit audit when FFmpeg publishes security-relevant releases.

Decision criteria:

- The pinned FFmpeg version is visible in diagnostics and release notes.
- Updating FFmpeg is one documented script/runbook operation.
- A release can be rebuilt with a newer FFmpeg without touching unrelated app code.

## Implementation Plan

### Phase 1: Build/Bundle Decision Artifact

Deliverable: a pinned FFmpeg bundle manifest and build/fetch script.

Tasks:

- Add `native-qt/third_party/ffmpeg/README.md` or equivalent describing the selected FFmpeg source, build method, license constraints, and update process.
- Add a script such as `native-qt/tools/build-ffmpeg-lgpl.ps1` or `native-qt/tools/fetch-ffmpeg-lgpl.ps1`.
- Write the selected FFmpeg version, dependency versions, configure line, and SHA256 hashes into a generated manifest.
- Ensure the configure line contains no `--enable-gpl` and no `--enable-nonfree`.
- Ensure `ffmpeg -encoders` shows `libvpx-vp9`.
- Ensure `ffmpeg -version` output is captured into the manifest.
- Produce a staging layout that release packaging can consume consistently.

Preferred staging layout:

```text
native-qt/third_party/ffmpeg-win64/
  bin/
    ffmpeg.exe
    *.dll if dynamic build is selected
  licenses/
    FFmpeg license files
    libvpx license files
    dependency notices
  SOURCES.txt
  BUILDINFO.txt
  SHA256SUMS.txt
```

Do not commit large binaries unless this repository intentionally accepts them. If binaries are kept out of git, the script must recreate or download them deterministically.

### Phase 2: Packaging Integration

Deliverable: release artifacts always include the intended FFmpeg bundle unless explicitly disabled for developer builds.

Tasks:

- Replace "find whatever FFmpeg CMake can see" with a deterministic bundle path for release packaging.
- Keep `VERSUS_BUNDLE_FFMPEG` or replace it with `VERSUS_FFMPEG_ROOT`; document whichever option remains.
- Make release packaging fail if FFmpeg is missing from release staging, unless a deliberate `-AllowMissingFfmpeg` or development flag is passed.
- Make release packaging fail if the bundled manifest shows `--enable-gpl`, `--enable-nonfree`, or missing `libvpx-vp9`.
- Copy FFmpeg notices and build manifest into the zip, portable, and installer staging directories.
- Stage dynamic FFmpeg files under an isolated `ffmpeg/` directory rather than app root, unless the selected artifact is a single-file executable.
- Add FFmpeg contents to `RELEASE-NOTES.txt`.
- Ensure the NSIS installer installs the FFmpeg files under the app directory.
- Ensure uninstall removes bundled FFmpeg files, directories, and notices.
- Ensure portable SFX contains the same files as the zip.
- Ensure stable release aliases and versioned release files have identical FFmpeg contents.

Files likely touched:

- `native-qt/CMakeLists.txt`
- `native-qt/installer.nsi`
- `native-qt/qa/build-release.ps1`
- `native-qt/qa/release-and-publish.ps1`
- `docs/RELEASES.md`

### Phase 3: Runtime Resolver Policy

Deliverable: Game Capture uses the intended FFmpeg by default and does not silently pick up stale/random PATH copies.

Recommended resolver order:

1. Explicit UI/CLI `--ffmpeg-path`.
2. Bundled app-local `ffmpeg/bin/ffmpeg.exe`.
3. Bundled app-local `ffmpeg.exe` for single-file or legacy staging.
4. Development/CI environment override such as `VERSUS_FFMPEG_PATH`, only when no bundled FFmpeg exists or when a deliberate override flag is set.
5. Optional developer-only PATH search, gated behind a clearly named environment variable such as `VERSUS_ALLOW_SYSTEM_FFMPEG=1`.

Changes:

- Remove default `SearchPathW` fallback in release behavior.
- Remove current documentation telling users to add FFmpeg to PATH.
- Keep the UI field and CLI flag so users can intentionally choose their own FFmpeg.
- Report the resolved path in diagnostics.
- Warn when an explicit override is used and differs from bundled FFmpeg, so support logs show the actual binary.
- Add an `ffmpeg -version` or equivalent capability probe at startup/first use, cached so it does not add repeated latency.
- Validate `libvpx-vp9` before starting VP9 alpha, not after a failed stream attempt.
- For the bundled binary, treat GPL/nonfree configure flags as a release/build error. For a user override, show a diagnostic warning but do not claim that custom binary is project-supplied.

Files likely touched:

- `native-qt/src/video/video_encoder.cpp`
- `native-qt/src/ui/main_window.cpp`
- `native-qt/src/main.cpp`
- `docs/local-control-api.md`
- `README.md`
- `docs/gamecapture.html`

### Phase 4: UI And Diagnostics

Deliverable: users know whether bundled FFmpeg is present and suitable before they go live.

Tasks:

- Show FFmpeg status near alpha/codec settings:
  - bundled FFmpeg found
  - user override active
  - missing FFmpeg
  - FFmpeg found but libvpx-vp9 missing
  - GPL/nonfree flags detected in a user override, if detectable from `ffmpeg -version`
- Use concrete remediation text:
  - use bundled release
  - repair/reinstall
  - choose a custom FFmpeg path
  - use chroma background with H.264/NVENC
- Add diagnostics fields:
  - `ffmpeg_resolved_path`
  - `ffmpeg_version`
  - `ffmpeg_configuration`
  - `ffmpeg_has_libvpx_vp9`
  - `ffmpeg_is_bundled`
  - `ffmpeg_is_user_override`
  - `ffmpeg_bundle_manifest_hash`
- Log the FFmpeg binary path and version once per live session.
- Do not log full command lines if they can contain sensitive paths or tokens beyond the FFmpeg path and codec settings.

### Phase 5: Documentation And Notices

Deliverable: release users and maintainers can understand the dependency and its legal surface.

Tasks:

- Update README to say Windows releases include FFmpeg for VP9 alpha.
- Remove "add FFmpeg to PATH" as a recommendation.
- Document that `--ffmpeg-path` is an explicit override for advanced users.
- Add a third-party notices file to release artifacts.
- Add website/download-page text required by FFmpeg's compliance checklist.
- Add versioned FFmpeg source/build-info archive links beside the versioned release artifacts.
- Add About/status text inside the app stating FFmpeg is used under LGPLv2.1-or-later and where source/build info is available.
- Document that VP9 alpha is CPU encoded.
- Document that H.264/H.265 hardware paths use OS/driver/native encoders and are separate from bundled FFmpeg.
- Document the two recommended VTuber workflows:
  - Spout2 + VP9 alpha + OBS native receiver for true transparency.
  - Spout2 + chroma background + H.264/NVENC for hardware encoding compatibility.

Files likely touched:

- `README.md`
- `docs/gamecapture.html`
- `docs/RELEASES.md`
- new `THIRD-PARTY-NOTICES.txt` or `native-qt/resources/THIRD-PARTY-NOTICES.txt`

### Phase 6: Verification Gates

These are checks and gates, not "testing" under this repo's terminology.

Gates:

- Build release artifacts from a clean build directory.
- Verify `ffmpeg.exe` and notices are present in:
  - staged win64 directory
  - zip artifact
  - portable SFX extraction
  - installer destination
- Verify FFmpeg DLLs, if any, are isolated under the expected FFmpeg directory.
- Verify `ffmpeg -version` output matches the manifest.
- Verify `ffmpeg -encoders` contains `libvpx-vp9`.
- Verify configure output contains no `--enable-gpl` and no `--enable-nonfree`.
- Verify the FFmpeg source/build-info archive exists and matches the manifest hashes.
- Verify uninstall removes the bundled FFmpeg directory.
- Verify `git diff --check`.
- Run existing CTest/build gates.
- Run `node --check` on changed E2E scripts if any are touched.

### Phase 7: Actual End-To-End Testing

This section uses "testing" in the repo-specific sense: run shipped/release-style app artifacts through real workflows and verify behavior/output.

Required workflow tests:

- Installed setup build, no system FFmpeg on PATH, VP9 alpha from deterministic Spout sender to OBS native receiver at 1920x1080@60.
- Portable build, no system FFmpeg on PATH, VP9 alpha from deterministic Spout sender to OBS native receiver at 1920x1080@60.
- Installed setup build, VTube Studio or VTube Studio-like real Spout sender, VP9 alpha to OBS native receiver at a realistic VTuber resolution and at 1920x1080@30.
- Chroma fallback: Spout2 source to H.264/NVENC browser viewer and/or OBS, verifying the background color is stable and no true-alpha path is required.
- Explicit custom FFmpeg override to a known temp FFmpeg path, verifying diagnostics show override active.
- Bad FFmpeg on PATH while bundled FFmpeg is present, verifying bundled FFmpeg is used and the bad PATH copy is ignored.
- Missing bundled FFmpeg simulation, verifying the app shows a visible warning and refuses opaque H.264 fallback for explicit VP9 alpha.
- Viewer bitrate/LQ routing check, verifying alpha is not silently removed without warning for alpha-capable OBS native receiver.
- Installed build uninstall/reinstall cycle, verifying bundled FFmpeg files are removed and then restored.

Pass criteria:

- OBS native receiver reports alpha composition active.
- Pixel checks over a bright background confirm transparent areas are truly transparent.
- Primary and alpha packet counters increase.
- No permanent H.264 fallback when VP9 alpha is explicitly selected.
- No encode hard failures or timeout storms during steady-state.
- FFmpeg status UI and diagnostics match the actual binary used.
- Artifacts contain FFmpeg notices and manifest.

## Risks And Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Bundled FFmpeg accidentally includes GPL/nonfree components | Legal/release blocker | Pin configure line, fail packaging if `--enable-gpl` or `--enable-nonfree` appears, maintain license manifest |
| Release accidentally ships without FFmpeg | VP9 alpha fails for normal users | Make release packaging fail when FFmpeg is absent |
| Random PATH FFmpeg is used | Unreliable behavior and support confusion | Remove automatic PATH fallback from release behavior |
| Bundled FFmpeg lacks libvpx-vp9 | VP9 alpha fails | Probe `ffmpeg -encoders` before stream start |
| Static bundle has unresolved LGPL obligations | Legal/release blocker | Prefer dynamic build or document static compliance after review |
| FFmpeg DLLs collide with Qt or other runtime DLLs | Launch/runtime failure | Isolate FFmpeg under `ffmpeg/bin` and run that exact executable path |
| Artifact size grows too much | Release friction | Measure size; if unacceptable, consider separate full artifact, not installer checkbox |
| AV detections increase | User trust/support issue | Code-sign, submit to VirusTotal, compare static/dynamic packaging |
| FFmpeg security issue requires update | Shipping stale dependency | Pin version, keep update script, document update cadence |
| Users with slow CPUs still cannot run 1080p60 VP9 alpha | Poor user experience | Keep chroma fallback, show CPU-encoded warning, suggest 1080p30/720p60 |
| AV1 scope expands the release | Delay | Defer AV1 unless VP9 alpha bundle is stable |

## Not In This Plan

- Adding FFmpeg to PATH.
- Adding `game-capture.exe` to PATH.
- Shipping software H.264/H.265 encoders such as x264/x265.
- Guaranteeing zero patent risk in every jurisdiction.
- Replacing native Media Foundation hardware encoding.
- Solving every VP9 performance issue before the bundled-FFmpeg release.
- Certifying or redistributing user-supplied custom FFmpeg builds.

## Suggested Implementation Order

1. Decide self-build vs auditable prebuilt and static vs dynamic.
2. Create the FFmpeg bundle script and manifest.
3. Integrate release packaging and make missing FFmpeg a release blocker.
4. Tighten runtime resolver order and remove default PATH fallback.
5. Add capability probing and diagnostics.
6. Update docs and legal notices.
7. Run gates.
8. Run actual workflow tests using release artifacts.
9. Only then revisit AV1, FFmpeg hardware wrappers, and optional CLI/PATH installer work for `game-capture.exe`.

## End Reminder

After the FFmpeg packaging and alpha reliability work is complete, revisit encode threading and run real workflow tests around it. The current serial primary/LQ/alpha encode path is conservative, but 1080p60 VP9 alpha still fails on some computers. We will likely need a focused threading/performance pass to support 1080p60 reliably.

## Acceptance Checklist

- [x] Pinned FFmpeg source/version/dependency manifest exists.
- [x] Bundle configure line excludes GPL and nonfree options.
- [x] `libvpx-vp9` is present in the bundled FFmpeg.
- [x] FFmpeg DLLs, if present, are isolated under the intended FFmpeg directory.
- [ ] Matching source/build info and notices are included or linked from every release download location.
- [x] Versioned release assets include or link the matching FFmpeg source/build-info archive.
- [x] Release packaging fails if FFmpeg is missing.
- [x] Release packaging fails if the bundled FFmpeg manifest is missing, GPL/nonfree, or lacks `libvpx-vp9`.
- [x] Zip, portable, and setup artifacts include FFmpeg and notices.
- [x] Runtime uses explicit override first, then bundled FFmpeg.
- [x] Runtime does not silently use arbitrary PATH FFmpeg in release behavior.
- [x] App shows missing/invalid FFmpeg before streaming VP9 alpha.
- [x] README no longer tells users to add FFmpeg to PATH.
- [x] Actual shipped-artifact VP9 alpha workflow test passes through OBS native receiver with pixel-verified transparency.
- [x] Actual shipped-artifact chroma fallback workflow test passes with H.264/NVENC.

## Validation Run: 2026-07-07

- Build/check gate: `native-qt/build-tests.bat` passed all 12 CTest checks after the packaging/runtime changes.
- Release gate: `native-qt/qa/build-release.ps1 -BuildDir build-test -Configuration Release -Version 0.2.44 -SkipVirusTotal` produced setup, portable, zip, staged directory, and FFmpeg source/build-info artifacts.
- Artifact checks: staged directory, zip, portable extraction, and setup listing all include `ffmpeg/bin/ffmpeg.exe` and `ffmpeg/bundle-manifest.json`.
- Resolver check: with a fake `ffmpeg.exe` first on PATH and no override variables, the packaged app used bundled `ffmpeg/bin/ffmpeg.exe`.
- Missing-bundle check: after temporarily moving the bundled `ffmpeg/` folder aside, VP9 alpha startup logged the missing FFmpeg/VP9-alpha failure and headless mode exited with code `3`.
- OBS native receiver workflow: packaged app with deterministic 1920x1080@60 Spout sender passed native alpha pixel validation.
- Real VTuber workflow: packaged app with `VTubeStudioSpout` at 1920x1080@30 passed OBS native receiver alpha pixel validation.
- Chroma fallback workflow: packaged app with `VTubeStudioSpout`, H.264/NVENC, and `--alpha-background=chroma --alpha-background-color=00FF00` produced decoded browser video; diagnostics showed H.264, `alpha_background_mode=chroma`, bundled FFmpeg resolved, and zero encode failures.
