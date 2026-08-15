# Encoder, ICE, and Control Center Correction Plan

Status: Agreed implementation plan  
Date: 2026-08-15

## Requirements

1. Auto ICE is the default for new installations and invalid or missing settings.
   - Allow host, server-reflexive, peer-reflexive, and relay candidates.
   - Configure STUN and TURN services so ICE can gather the available candidates.
   - Let the ICE implementation perform candidate prioritization and selection.
   - Do not filter, reorder, or otherwise interfere with Auto-mode candidates.
   - TURN must be available by default when direct paths do not work.
   - If TURN configuration retrieval fails, record the failure clearly in the log.

2. Preserve existing saved ICE settings.
   - A valid saved selection always wins over the new default.
   - Do not migrate or overwrite an explicit existing choice.

3. Apply truthful encoder-selection policies.
   - Auto: try healthy hardware encoders, then fall back to software.
   - Microsoft AVC DX12 is a valid hardware result in Auto mode, not an NVIDIA fallback failure.
   - NVIDIA: allow confirmed NVIDIA Media Foundation or FFmpeg NVENC only.
   - Intel: allow confirmed Intel/Quick Sync encoders only.
   - AMD: allow confirmed AMD/AMF encoders only.
   - Software: allow software encoding only.
   - An explicit selection must fail visibly instead of silently changing encoder category.
   - An explicit encoder selection takes precedence over codec fallback behavior. An unsupported encoder and codec combination must fail visibly instead of changing encoder category.

4. Run the FFmpeg `h264_nvenc` retry only for an explicit NVIDIA selection, never for Auto.

5. Report encoder state separately:
   - Requested encoder mode.
   - Active encoder name and category.
   - Fallback reason, when a fallback occurred.

6. Correct Control Center quality behavior.
   - Continue supporting video Off and On. On restores the peer's assigned stream tier.
   - Return an explicit unsupported response for per-peer `bitrate` and `optimizedBitrate` Low or High requests until they genuinely change per-peer output.
   - Keep authorized shared-stream `targetBitrate` changes supported because they genuinely change the shared encoder target.
   - Never report that a quality change succeeded when the encoded or routed output did not change.

7. Report the selected ICE path without exposing addresses.
   - Display only `HOST`, `STUN`, or `TURN/RELAY`.
   - Classify the selected pair as `TURN/RELAY` if either candidate is relay, `STUN` if either remaining candidate is server-reflexive or peer-reflexive, and `HOST` otherwise.
   - Do not persist, log, or display local, public, or relay candidate IP addresses.

8. Leave the current Room Quality name and behavior unchanged in this work.

## Packaged-Application Testing

Before publishing, run the packaged release application through real end-to-end workflows and verify:

- Auto ICE includes TURN as an available path and ICE selects the working path without application interference.
- A packaged workflow establishes an actual `TURN/RELAY` connection under relay-only test conditions without changing Auto-mode behavior.
- A valid saved ICE selection is preserved, while a fresh, missing, or invalid selection defaults to Auto.
- A TURN configuration retrieval failure is clearly recorded in the log.
- Diagnostics report the selected path as `HOST`, `STUN`, or `TURN/RELAY` without an IP address.
- Auto encoder mode uses a healthy hardware encoder, including Microsoft AVC DX12 when selected, and falls back to software when necessary.
- Every explicit encoder mode resolves only to its requested category or fails visibly.
- Unsupported explicit encoder and codec combinations fail visibly instead of changing encoder category.
- Actual NVENC use is confirmed on NVIDIA hardware, including an active NVIDIA encoder session.
- Control Center connects and keeps decoded video running in Edge and Firefox.
- Control Center video Off and On change actual media delivery, and On restores the assigned stream tier.
- Unsupported per-peer Low and High requests receive an explicit unsupported response and are not falsely acknowledged.
- Authorized shared-stream `targetBitrate` changes still change the actual encoder target.
- Runtime encoder and connection diagnostics match actual behavior.

Test only hardware that is actually available. Record unsupported Intel, AMD, NVIDIA, or software cases as not tested rather than claiming coverage.

Build, lint, unit, component, and smoke checks remain release gates; they are not substitutes for these packaged-application end-to-end workflows.

## Release

1. Complete the implementation and release gates.
2. Bump the application version.
3. Build and sign the final installer, portable executable, and ZIP.
4. Run all required packaged-application workflows against those exact final artifacts.
5. Verify artifact identities, signatures, and hashes.
6. Publish those artifacts unchanged. Do not replace or silently modify the existing 0.2.49 release.
