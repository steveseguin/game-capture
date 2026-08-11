# Dual-Stream Room Quality Plan

Last updated: 2026-08-07
Status: LOCKED
Owner: Publisher pipeline (`native-qt/src/app` core module)

## Goal

Implement role-aware dual-stream publishing with at most two concurrent video encodes:

- `HQ` for scene/view use-cases.
- `LQ` for group-room guests/directors/viewers.

This is intended to reduce upstream load in room workflows while keeping gameplay smooth.

## Locked Product Decisions

`DEC-001` Stream tiers
- Maximum two concurrent video tiers: `HQ` and `LQ`.
- Never create a third encoder instance.

`DEC-002` LQ profile
- Codec: H.264.
- Encoder: CPU (`HardwareEncoder::None`).
- Resolution: 640x360.
- Framerate: 30 FPS.
- Bitrate target: 2000 kbps.

`DEC-003` HQ profile (superseded by `DEC-010` on 2026-08-07)
- The original v1 decision forced H.264 whenever Room Quality was enabled.
- This is retained only as decision history and must not be implemented as current behavior.

`DEC-004` Room-aware behavior
- Direct view/push links (no room): HQ only. LQ encoder must not start.
- Room links: default route is LQ.
- Room links upgrade to HQ only when data-channel init says role is `scene`.

`DEC-005` Data-channel gating
- For room links, do not send media to a peer until a valid init object is received over data channel.
- Init may declare peer role and media preferences (`audio` / `video`).
- If the stock viewer opens the data channel without app-specific init metadata, implicitly treat it as `viewer`/`LQ` for compatibility.
- If the data channel never opens, close that peer session after timeout.

`DEC-006` Security model
- No auth guard on role claim for HQ/LQ selection.
- Spoofing is accepted risk for this feature.
- Overload protection is max-connections (`maxViewers`) only.

`DEC-007` Encode on demand
- Do not encode HQ if no HQ peers currently need video.
- Do not encode LQ if no LQ peers currently need video.
- Start/stop tier encoders lazily based on active peer demand.

`DEC-008` Audio routing
- Respect per-peer init flags:
- `video=false` means no video packets sent to that peer.
- `audio=false` means no audio packets sent to that peer.

`DEC-009` Publisher info payload
- Continue sending label/stats/system info via data channel.
- Extend info with role/tier assignment and media-enable state for that peer.

`DEC-010` Explicit codec and transparency settings take priority
- HQ uses the codec and alpha workflow explicitly selected by the publisher; entering a room must never silently replace the codec or disable alpha.
- The optional LQ tier is H.264-only. If the selected primary codec is not H.264, Room Quality becomes unavailable and all video-enabled room peers use HQ.
- An alpha-capable receiver must receive the HQ primary and alpha tracks together. It must never be downgraded to a tier that cannot preserve the requested transparency workflow.
- The UI must make an unavailable Room Quality option visibly disabled/unchecked, and runtime/CLI paths must emit an explicit informational warning before continuing HQ-only.
- If the selected codec or alpha workflow cannot initialize, startup fails visibly (or follows the existing explicitly reported encoder fallback contract); room mode alone is not permission to change it silently.

`DEC-011` VP9 dual-track SDP layout is stable across transport generations
- When the VP9 alpha workflow is selected, reserve the primary video, audio, `video-alpha`, and data-channel sections in that exact order in the first offer.
- Preserve that section set and order across ICE restarts, transport rebuilds, and codec fallback. Receiver capability gates alpha packets only; it never adds, removes, or reorders the alpha section.
- Activating an alpha-capable receiver must not require a second offer or replace the logical peer session.

## Role Routing Matrix

| Context | Init role | Assigned tier | Notes |
|---|---|---|---|
| Direct (no room) | any/none | HQ | Current behavior, no LQ |
| Room | `scene` | HQ | Full-quality scene path |
| Room | `director` | LQ when compatible; otherwise HQ | LQ is 640x360@30, 2 Mbps; `DEC-010` forces HQ when the selected codec/alpha path is incompatible. |
| Room | `guest` | LQ when compatible; otherwise HQ | LQ is 640x360@30, 2 Mbps; `DEC-010` forces HQ when the selected codec/alpha path is incompatible. |
| Room | `viewer` | LQ when compatible; otherwise HQ | LQ is 640x360@30, 2 Mbps; `DEC-010` forces HQ when the selected codec/alpha path is incompatible. |
| Room | unknown/missing before data channel | no media then disconnect on timeout | Fail closed |
| Room | missing init after data channel opens | LQ when compatible; otherwise HQ | Implicit compatibility fallback, subject to `DEC-010`. |

## Data Channel Contract (v1)

Viewer to publisher init message:

```json
{
  "init": {
    "role": "scene|director|guest|viewer",
    "room": true,
    "video": true,
    "audio": true,
    "label": "optional client label",
    "system": {
      "app": "game-capture-web",
      "version": "x.y.z",
      "platform": "win|mac|linux|ios|android",
      "browser": "chrome|edge|firefox|safari"
    }
  }
}
```

Publisher info response additions:

```json
{
  "info": {
    "assigned_role": "scene|director|guest|viewer|unknown",
    "assigned_tier": "hq|lq|none",
    "requested_video_bitrate_kbps": 0,
    "requested_audio_bitrate_kbps": 0,
    "room_init": true
  }
}
```

## Implementation Sequence

1. Policy model extraction
- Add pure policy helpers for role parsing and tier assignment.
- Add a peer media state struct (`role`, `tier`, `initReceived`, `videoEnabled`, `audioEnabled`, `initDeadlineMs`).

2. Peer session updates
- Extend `PeerSession` in the app core header with room-init and tier metadata.
- Track whether peer is currently eligible for HQ/LQ routing.

3. Dual encoder plumbing
- Add second `VideoEncoder` instance for LQ.
- Add demand counters for HQ/LQ active peers.
- Initialize/shutdown each encoder lazily.

4. Routing split
- Refactor `encodeAndSendVideoFrame` to produce up to two encoded packets per frame (`HQ`, `LQ`).
- Route per peer by assigned tier and `videoEnabled`.
- Keep periodic keyframe logic for both tiers.

5. Audio routing flags
- Update `sendAudioPacketToPeers` to honor peer `audioEnabled`.

6. Data-channel init handling
- Parse incoming `init` object in `handlePeerDataMessage`.
- Apply role/tier/media state changes in-session.
- For room peers, block media until init is received.
- Enforce init timeout disconnect.

7. Info/stats payload extensions
- Add assigned tier/role/media flags to info payload.
- Keep existing mini stats; add tier counts (`hq_peers`, `lq_peers`) for diagnostics.

8. Recovery and lifecycle
- On reconnect/new peer, reset to conservative room defaults.
- Ensure tier state survives normal control messages and stats requests.

## Required Code Touch Points

- `native-qt/include/*/app/*` (app core header declarations)
- `native-qt/src/app/*` (publisher routing/runtime behavior)
- `native-qt/include/*/video/*` (only if helper API needed)
- `native-qt/tests/*` (new policy/unit coverage)
- `native-qt/e2e/*` (new dual-tier E2E coverage)

## Risks and Mitigations

`RISK-001` CPU overhead from LQ software encode
- Mitigation: lazy encoder start, stop when no LQ peers, telemetry warnings.

`RISK-002` Role spoofing
- Mitigation: accepted by design (`DEC-006`), constrained by max viewers.

`RISK-003` Codec mismatch complexity
- Mitigation: keep LQ H.264-only, preserve the selected HQ codec/alpha workflow, and disable the LQ tier when that primary negotiation cannot carry it (`DEC-010`).

`RISK-004` Reconnect/state drift
- Mitigation: reset peer tier to unknown until fresh init, enforce timeout.

## Definition of Done

Feature is complete only when all conditions are true:

- Dual-tier routing behavior matches matrix in this file.
- No more than two video encoders are ever active.
- No media is sent to room peers before init is received.
- Direct links still behave HQ-only.
- Selected HQ codec and alpha behavior are identical in direct and room modes.
- Non-H.264 room publishing stays HQ-only and never silently falls back because Room Quality was requested.
- Alpha-capable room receivers decode synchronized moving primary/alpha tracks through the ninja-plugin compatibility path.
- Max-viewer protection remains effective.
- All tests listed in `native-qt/qa/DUAL_STREAM_TEST_REQUIREMENTS.md` pass.
