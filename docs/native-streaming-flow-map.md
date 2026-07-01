# Native Streaming Workflow Map

Status: living architecture review artifact for Codex-assisted review.

Last reviewed: 2026-07-01.

Primary scope: native Qt publisher workflow for signaling, WebRTC peer sessions, video tracks, audio tracks, encoder state, room routing, recovery, and firewall reachability.

Reviewed change window: commits since 2026-05-28, pending 0.2.43 signaling/media validation fixes, and the adjacent late-May room recovery/microphone work because it directly affects peer-session and media-track behavior.

Recent commits in scope:
- `281c322` - Warn portable users about firewall rule.
- `a785f55` - Release 0.2.40 with firewall rule.
- Adjacent baseline for streaming workflow: `ca512da` - Fix room recovery and microphone input selection.

This file is intentionally code-free. It uses stable component names, state names, transition names, and invariants so it can be updated after each review without carrying the full burden of source code.

## Upstream VDO.Ninja Compatibility Contracts

Reference sources: `C:\Users\steve\Code\vdoninja\main.js`, `C:\Users\steve\Code\vdoninja\webrtc.js`, and `C:\Users\steve\Code\vdoninja\lib.js`, read-only review on 2026-06-30.

Additional compatibility source: `C:\Users\steve\Code\ninja-plugin\docs\vdoninja-workflow-map.md`, `C:\Users\steve\Code\ninja-plugin\src\vdoninja-signaling.cpp`, `C:\Users\steve\Code\ninja-plugin\src\vdoninja-signaling-protocol.cpp`, and `C:\Users\steve\Code\ninja-plugin\src\vdoninja-output.cpp`, read-only review on 2026-06-30.

These contracts describe message shapes and ordering expectations that the native publisher must stay compatible with.

- Publisher offers include `UUID`, `streamID`, `session`, and `description`; password-protected descriptions are encrypted with the VDO salt/key path.
- Publisher-to-viewer ICE candidates use `type: "local"`. Viewer-to-publisher ICE candidates arrive as `type: "remote"` from the publisher's perspective.
- Answers and ICE candidates may arrive through WebSocket signaling or through the already-bound data channel. Data-channel-scoped answers/candidates may omit `UUID` and `session` because the channel itself identifies the peer.
- Remote ICE candidates can legally arrive before a matching native peer session exists or before a matching remote description has been applied. Official VDO queues pending ICE by UUID/type and drains it after `setRemoteDescription` succeeds.
- Control Center resolution requests use `requestResolution: { w, h, s, c }`, where `w` and `h` are requested scale bounds, `s` is the snap flag, and `c` is cover behavior. Official VDO resolves these against the sender track's native width/height, chooses min(width scale, height scale) for fit or max(...) for cover, caps scale at 100%, and then applies the resulting sender scale. A payload such as `{w:4096,h:720,c:false}` means "fit to 720p without upscaling", not "set literal 4096x720".
- `bitrate` and `audioBitrate` are per-peer rate-limit requests. A zero value disables that peer's video or audio sender route without implying VDO UI mute state.
- `targetBitrate` and `targetAudioBitrate` are target sender-cap requests. A false value unlocks the target cap; for native video this also restores the configured publisher bitrate because positive target caps are approximated as a global encoder change. Zero route-disable behavior belongs to `bitrate` and `audioBitrate`, not the target-cap fields.
- `requestAs` is an official VDO routing wrapper for `targetBitrate`, `targetAudioBitrate`, and `requestResolution`. The receiver first validates `UUID` as the requester, then routes the target controls to `requestAs`; if that target is unknown, the controls are ignored. Native has one publisher aggregate, so it only accepts `requestAs` controls when the target matches the native `remoteStats` key/stream id and the requester is a director or presents the configured `remote` token.
- Data-channel `info` messages advertise initial video settings as `video_init_width`, `video_init_height`, and `video_init_frameRate`, plus current remote/mute/screen-share capability state.
- Data-channel `info.width_url`, `height_url`, `fps_url`, and `codec_url` describe the effective route for that peer. In room LQ paths these can be `640x360` even when the native HQ encoder/control target is larger.
- Control Center settings requests use `getAudioSettings` and `getVideoSettings`. Official VDO replies with `audioOptions`, `videoOptions`, and a separate `mediaDevices` list from the director-authorized control branch; remote tokens alone do not authorize this readback path.
- Remote video settings controls use `requestVideoHack` with `keyname`, `value`, `UUID`, and `ctrl`. Official VDO gates this behind director status or a valid remote token. Native only maps supported `width`, `height`, and `frameRate` keys into its runtime encoder reconfigure path. For width/height, `ctrl` means aspect-coupled resize; no `ctrl` means keep the other dimension fixed.
- Native `videoOptions` must advertise only settings backed by `requestVideoHack` mutations. Current native options expose `width`, `height`, and `frameRate`; unsupported browser camera controls such as `aspectRatio`, exposure, focus, PTZ, or white-balance fields must not appear in native settings readback unless native implements the matching mutation path.
- Remote device-switch responses use VDO-recognized `mediaDeviceChange` and/or `rejected` messages. Unsupported native live device switches must be explicit negative responses, not silent no-ops.
- Remote-token authorization uses the VDO field name `remote`. A top-level `token` field is not part of the reviewed official remote-control message shape and must not authorize native control messages.
- VDO has an encrypted `remote` helper for some browser-only control families. In the reviewed official paths, native-supported remote-token exceptions are `requestVideoHack`, `refreshVideo`, `refreshConnection`, and `refreshAll`; settings readback, microphone refresh, device changes, remote video mute, and volume rely on director identity. Browser-only PTZ/mirror/rotate controls may send `remote` as an encrypted two-item array and must not be implemented in native later without adding compatible decode support.
- Browser-only VDO Control Center commands that native cannot implement must fail through the VDO `rejected` family instead of disappearing silently. Current examples include advanced audio mutations, low-cut/audio-isolation controls, recording, order/URL/label changes, remote reload, sender scale, PTZ, periodic keyframe-rate control, WHIP restart, clock/group controls, rotate/mirror controls, connection map requests, and reconnect-peer requests.
- This browser-only rejection rule is a native capability boundary, not an exact copy of browser VDO director behavior. Official browser VDO can apply many of these fields for authorized directors because it owns WebAudio, camera constraints, document reload, and browser peer maps. Native rejects them for directors and non-directors until it has an honest owner for the same state and side effects.
- Data-channel request callbacks use `cbid`; the receiver answers with `{ cbid }`. `callbackID` and `requestID` are not part of the reviewed VDO callback path.
- Peer lifecycle cleanup can arrive through WebSocket signaling (`bye` or `request:"cleanup"`) or the bound data channel (`bye` or `request:"cleanup"`). Both represent an immediate peer cleanup request, but WebSocket cleanup must first resolve UUID/session through VersusApp's peer map.
- Remote endpoint stop uses data-channel `hangup: true`. This is distinct from `bye`: `hangup` stops the publisher/output endpoint after director or `remote` token authorization, while `bye` only cleans up the sending peer session. Unauthorized `hangup` returns VDO-shaped `rejected: "hangup"`.
- Peer recovery messages include WebSocket `iceRestartRequest` and data-channel `iceRestartRequest`. Both are unprivileged transport recovery requests for an existing peer and are separate from privileged Control Center `refreshConnection`.
- Control Center `refreshConnection` and `refreshAll` are publisher-wide recovery controls in official VDO.Ninja: after authorization, the recipient restarts every current `pcs`/`rpcs` peer connection. Native mirrors that by taking a snapshot of current PeerSessions and rebuilding each underlying PeerConnection; settings/device readback from `refreshAll` remains scoped to the requesting control peer.
- `optimizedBitrate` is a VDO visibility/optimization hint, not the same thing as `targetBitrate`. Official VDO stores it as a per-peer optimized cap and applies it through the bitrate limiting path. Native Game Capture maps it to the existing per-peer route bitrate cap, including `0` route-disable and false/unlock behavior, and must not map it directly to global encoder bitrate.
- Native libdatachannel/libjuice does not expose browser-style in-place `restartIce()` after candidate gathering begins. Recovery preserves the app-level `PeerSession` UUID/session but rebuilds the underlying PeerConnection, restores desired media tracks, and sends a new offer from that preserved session.
- Publisher-to-viewer status uses existing VDO message families: `info`, `miniInfo`, `remoteStats`, `pong`, `videoMuted`, `muteState`, and `rejected`. Custom `ack` envelopes are not part of the reviewed VDO message vocabulary.
- Native `remoteStats` is a publisher-aggregate compatibility payload keyed by the native stream id. Unlike a browser VDO session with multiple peer connections, it does not enumerate other publisher peers; `info` and `miniInfo` remain the peer-route-specific status payloads.
- Official director/API `action:"volume"` is resolved by VDO's local API handler into the normal top-level remote-volume request before it reaches the publisher; the older scene/direct `action:"volume"` path controls local scene playback volume. Native publisher control should continue to use top-level `volume` for director-requested outbound audio gain/mute state and should not treat arbitrary action/value scene messages as publisher media controls.

Comparison notes from the current review:
- Aligned WebSocket fields: `joinroom` with hashed `roomid`, `seed` with hashed `streamID`, `listing`, `transferred`, `offerSDP`, `sendoffer`, offer-request-compatible `play`, offer-request-compatible `joinroom` only when a stream id is also present, `iceRestartRequest`, `bye`, `request:"cleanup"`, `request:"alert"`, `request:"error"`, bare `alert`, encrypted/plain `description`, singular `candidate`, bundled `candidates`, `UUID`, `session`, `streamID`, and candidate `type`.
- VDO-known data-channel fields tracked in this map: scoped answers/candidates, `cbid`, `bye`, `hangup`, `iceRestartRequest`, `info`, `miniInfo`, `remoteStats`, `ping`/`pong`, `keyframe`, `requestKeyframe`, `keyframeRate`, `bitrate`, `audioBitrate`, `targetBitrate`, `targetAudioBitrate`, `requestAs`, `optimizedBitrate`, `requestResolution`, `requestVideoHack`, `getAudioSettings`, `getVideoSettings`, `audioOptions`, `videoOptions`, `mediaDevices`, `mediaDeviceChange`, `remoteVideoMuted`, `volume`, `videoMuted`, `muteState`, OBS/source-state fields such as `obsState`, `sceneDisplay`, and `sceneMute`, OBS-control request fields such as `obsCommand` and `getOBSState`, screen/director UI state such as `screenShareState`, `screenStopped`, `directVideoMuted`, `virtualHangup`, `directorSpeakerMuted`, `directorDisplayMuted`, `directorMirror`, `directorFlip`, `mirrorGuestState`, `mirrorGuestTarget`, `rotate`, and `rotate_video`, recognized unsupported commands such as `restartWhip`, `reload`, `scale`, `zoom`, `autofocus`, `exposure`, and `keyframeRate`, and `rejected`.
- Local extensions are allowed only inside VDO-extensible status containers. Current local extensions include assigned role/tier, requested bitrate state, audio source names, room-only tier stats, system metadata aliases, and alpha capability fields inside `info` or `miniInfo`.
- Confirmed incorrect field behavior fixed in this review: `targetAudioBitrate` had been handled as `audioBitrate` metadata only instead of changing sender audio target state.
- Confirmed incorrect field behavior fixed in this review: `targetBitrate:false` had been clearing peer route state without restoring the native global encoder target. The native approximation now restores the configured publisher bitrate after boolean false/unlock.
- Confirmed incorrect routing behavior fixed in this review: `requestAs`-wrapped stats/control messages were treated as ordinary direct target controls, so a message aimed at some other VDO target could reconfigure the native publisher. Native now only accepts routed target controls for its own stream-id stats key after director or `remote` authorization.
- Confirmed incorrect resolution behavior fixed in this review: object-form `requestResolution` was treated as literal encoder dimensions. Native now resolves VDO scale bounds against the current capture aspect, so the official Control Center stats picker shape `{w:4096,h:selectedHeight,c:false}` preserves aspect ratio and caps at native size instead of producing an ultra-wide encoder size.
- Confirmed missing message behavior fixed in this review: Control Center settings requests had no native `audioOptions`, `videoOptions`, or `mediaDevices` response, so the settings panels had no VDO-compatible payload to render.
- Confirmed incorrect authorization behavior fixed in this review: `remoteVideoMuted` and `volume` now stay director-only, matching the official VDO branch that rejects those messages from non-director peers even when a remote token is present.
- Confirmed incorrect authorization behavior fixed in this review: settings/device readback, microphone refresh, and live device-change responses no longer answer arbitrary peers or remote-token-only peers; `refreshVideo`, `requestVideoHack`, `refreshConnection`, and `refreshAll` remain the explicit remote-token exceptions.
- Confirmed incorrect authorization behavior fixed in this review: native no longer accepts a non-VDO `token` alias for remote-token authorization; only VDO's `remote` field can authorize the explicit remote-token exceptions.
- Confirmed missing message behavior fixed in this review: unsupported browser-only VDO Control Center commands now return VDO-shaped `rejected` responses instead of being silently ignored by the native publisher.
- Confirmed incorrect message classification fixed in this review: `hangup: true` is no longer treated as an unsupported browser-only command. Native now treats it as VDO's authorized endpoint-stop command and keeps it separate from peer `bye` cleanup.
- Confirmed missing message behavior fixed in this review: peer data-channel `bye` and `request:"cleanup"` now remove the native peer session immediately instead of waiting for later close/stale-prune callbacks.
- Confirmed missing message behavior fixed in this review: peer data-channel `iceRestartRequest` now starts native rebuild-based recovery for the existing peer session.
- Confirmed missing message behavior fixed in this review: WebSocket signaling `bye` and `request:"cleanup"` now remove the matching native peer session instead of being ignored.
- Confirmed state-transition behavior fixed in this review: WebSocket `iceRestartRequest` now sends a recovery offer on the existing PeerSession instead of being routed through the new `offerSDP`/peer-replacement path.
- Confirmed recovery semantics fixed in this review: native recovery offers now rebuild the underlying PeerConnection before offering because libjuice rejects local ICE credential changes once candidate gathering has started; normal media renegotiation still uses the existing PeerConnection.
- Confirmed Control Center recovery scope fixed in this review: `refreshConnection` and `refreshAll` now rebuild every current native PeerSession, matching official VDO's loop over all publisher peer connections, while data-channel/WebSocket `iceRestartRequest` remains scoped to the requesting/resolved peer.
- Confirmed state-transition behavior fixed in this review: WebSocket remote ICE candidates that arrive before the native PeerSession exists are queued with the same 15s/100-candidate bounds as official VDO and are drained only after the peer answer is accepted.
- Confirmed state-transition bug fixed in this review: peer answers no longer mark the session answered or flush buffered local ICE candidates until WebRTC accepts the remote description.
- Confirmed VDO compatibility behavior preserved in this review: answers and candidates sent over an existing data channel can carry a browser-side payload `UUID` that differs from native's peer UUID, while the session matches. Native accepts this only on the already-bound data channel; WebSocket signaling still requires an unambiguous peer lookup.
- Confirmed missing signaling-alias behavior fixed in this review: `transferred` and bare `listing` arrays now parse as room listings, and `sendoffer`, `play`, and stream-id-bearing `joinroom` now parse as offer-request aliases instead of being ignored.
- Confirmed missing signaling-alert behavior fixed in this review: `request:"error"` and bare `alert` now enter the same server-alert path as `request:"alert"`.
- Confirmed incorrect data-channel fanout behavior fixed in this review: repeated metadata/info refresh messages no longer return before processing later top-level VDO fields. A combined payload such as `info + requestStats + keyframe` now updates metadata and continues into stats/keyframe handling.
- Confirmed lifecycle invariant preserved in this review: initial offer creation/send failure does not leave a healthy-looking `PeerSession` behind. `sendPeerOffer` clears dispatch state before offering and removes the peer on create or signaling-send failure; post-send map mismatch is treated as an already-removed peer. This protects max-viewer accounting and empty-session UUID lookup from stale bootstrap sessions.
- Confirmed settings-surface invariant preserved in this review: native `videoOptions` only advertises `width`, `height`, and `frameRate`, matching the supported `requestVideoHack` key set. No browser-only camera setting is advertised without a corresponding native mutation path.
- Confirmed direct-volume mapping preserved in this review: native top-level `volume` remains director-only. Official `action:"volume"` API calls are converted by the VDO page into top-level `volume`, while scene/direct volume action messages are local playback controls and are not native publisher outbound-audio commands.
- Confirmed operator-health behavior fixed in this review: live bitrate/FPS readback is recent-window/smoothed rather than a lifetime average, and capture-frame overwrite drops are counted when the encode thread falls behind.
- Confirmed ICE reporting boundary in this review: native can report local/remote candidate evidence, including relay candidates, but it does not claim an exact selected ICE pair because the current libdatachannel/libjuice surface in use does not expose browser-style selected-candidate-pair stats.
- Confirmed mixed-audio robustness fixed in this review: primary game/app audio and additional microphone audio now have bounded per-source gain controls and a mixed-output soft limiter before Opus encoding.

Current official reference anchors reviewed on 2026-06-30:
- Settings-panel open paths send `getAudioSettings` and `getVideoSettings`; native must answer only from director-authorized peers with `audioOptions`, `videoOptions`, and/or `mediaDevices`.
- Device refresh/change paths send `refreshMicrophone`, `refreshVideo`, `changeCamera`, `changeMicrophone`, and `changeSpeaker`; native must split director-only operations from the remote-token `refreshVideo` exception.
- Mesh recovery paths send `refreshVideo`, `refreshConnection`, `refreshAll`, and `restartWhip`; native implements the first three as recovery/readback paths and rejects `restartWhip` because native does not own a browser WHIP output session.
- Remote-token API helpers add `remote` to `refreshVideo`, `refreshConnection`, and `refreshAll`; direct director mesh actions may omit `remote` because director identity is established through role/init state.
- Advanced browser media controls send `requestAudioHack`, `requestChangeEQ`, `requestChangeGating`, `requestChangeCompressor`, `requestChangeMicDelay`, `requestChangeSubGain`, `requestChangeLowcut`, and `requestChangeMicPanning`; native must reject these rather than inventing partial WebAudio behavior.
- Official browser directors can apply browser-only media and page controls when the browser owns the relevant surface. Native's rejection of those same fields is correct only as long as the native app lacks an equivalent owner; do not later mark these as unsupported if a real native state owner is added.
- Peer lifecycle/recovery paths send WebSocket `bye`, WebSocket `request:"cleanup"`, WebSocket `iceRestartRequest`, data-channel `bye`, data-channel `request:"cleanup"`, data-channel `hangup`, and data-channel `iceRestartRequest`; native must close the peer for cleanup messages, stop the publisher/output endpoint for authorized `hangup`, and rebuild the underlying PeerConnection before sending a recovery offer from the existing PeerSession for `iceRestartRequest` without requiring a Control Center remote token.
- Room admission paths can send `request:"listing"` or `request:"transferred"` with a `list`, while older/alternate shapes may carry a bare `listing` array. Publisher offer requests can arrive as `offerSDP`, `sendoffer`, `play`, or a compatible `joinroom` request that includes a stream id; plain `joinroom` remains room admission and must not create a native PeerSession.
- Pending ICE paths queue candidates before a peer connection exists and also re-queue candidates that arrive before remote description application. Native mirrors this as a VersusApp pre-peer queue plus a WebRtcClient pre-remote-description queue.
- Browser page controls send `reload`; sender encoder controls send `scale`; PTZ controls send `pan`, `tilt`, `zoom`, `focus`, `autofocus`, and `exposure`, with `abs` as a PTZ parameter. Browser publishers can also accept `keyframeRate` as per-peer periodic PLI/keyframe cadence. Native must reject these because it does not own a reloadable browser page, browser sender transceiver scale, camera PTZ surface, or per-peer browser PLI timer.

## Adjacent Ninja Plugin Cross-Reference

Read-only source: `C:\Users\steve\Code\ninja-plugin`.

Confirmed same model:
- The OBS plugin map treats WebSocket signaling, data-channel signaling, data-channel control, and OBS output state as separate owners. This matches the native map split between VdoSignaling, WebRtcClient, VersusApp, and capture/encoder owners.
- The plugin echoes `ping` with `pong` using the same token value, treats incoming `pong` as a no-op, echoes `cbid`, and avoids custom acknowledgement envelopes. Native already follows the same `ping`/`pong` and `cbid` shape.
- The plugin treats `requestStats` and `requestStatsContinuous` as `remoteStats` responses. Native already uses a VDO-shaped aggregate `remoteStats` payload.
- The plugin classifies official source/UI-state messages separately from media control. Native should keep those fields separate as well: a state report such as `obsState.visibility:false`, `screenStopped:true`, `virtualHangup:true`, or `directVideoMuted:true` is not by itself a peer cleanup, publisher hangup, route mute, or encoder bitrate request.

New or clarified information from the plugin notes:
- Official VDO data-channel messages are field-based, not mutually exclusive command objects. The adjacent plugin had to add explicit field fanout because its parser returns one primary `DataMessageType`; combined messages such as `{keyframe:true, requestStats:true}` must both request a keyframe and return `remoteStats`.
- Room admission responses are not only `request:"listing"`. Official server paths can send `request:"transferred"` with a `list`, and compatibility paths can expose a bare `listing` array. Native treats all of these as room-listing updates.
- Publisher offer requests are not only `request:"offerSDP"`. The adjacent plugin accepts `offerSDP`, `sendoffer`, `play`, and stream-id-bearing `joinroom` as offer-request triggers. Native mirrors that parser contract while keeping plain `joinroom` as room admission, not peer creation.
- The adjacent plugin also tracks incremental room membership notifications (`someonejoined` with a stream id, `videoAddedToRoom`, and `videoRemovedFromRoom`). Those are useful for OBS/native viewing sources that maintain a room-member snapshot. Game Capture's publisher path does not currently expose stream-added/removed callbacks, so these messages are documented as known upstream room-state shapes rather than peer-session creation or cleanup triggers.
- Server alert/error shapes include `request:"alert"`, `request:"error"`, and bare `alert`. Native routes all three to the same alert callback so stream-id conflicts and room-capacity errors surface through the existing runtime-event path.
- `optimizedBitrate` is extracted by the plugin as official media-control vocabulary, but the plugin's publisher path only applies the safe send-active subset (`bitrate` and `audioBitrate`) to already-encoded media. Native Game Capture has a per-peer route owner, so it applies `optimizedBitrate` there while keeping global encoder bitrate under `targetBitrate`.
- `hangup: true` is an endpoint/output stop command. It is not a peer cleanup message and must not be grouped with unsupported browser-only controls.
- `bye` remains peer cleanup only, and bound data-channel `request:"cleanup"` is also peer cleanup. In the OBS plugin this removes the peer/output relationship; in native it removes the bound PeerSession or the signaling-resolved PeerSession.
- OBS/tally source state is official when carried as `obsState` with `visibility`, `sourceActive`, `streaming`, `recording`, `virtualcam`, and `details`. `sceneDisplay` and `sceneMute` are related scene-state shims. These are OBS/browser-source state reports, not native Game Capture transport controls.
- `getOBSState` and `obsCommand` are OBS/plugin remote-control paths, not Game Capture controls. Native rejects them with VDO-shaped `rejected` responses instead of returning OBS state or silently ignoring them.
- Screen-share and director UI state fields such as `screenShareState`, `screenStopped`, `directorVideoMuted`, `directVideoMuted`, `virtualHangup`, `directorSpeakerMuted`, `speakerMute`, `directorDisplayMuted`, `displayMute`, `directorMirror`, `directorFlip`, `mirrorGuestState`, `mirrorGuestTarget`, `rotate`, and `rotate_video` are official VDO vocabulary. Most are browser/UI state signals rather than actions a native window publisher can honestly perform.
- `virtualHangup` is director video-suppression state. It must not be mapped to endpoint `hangup: true`, peer `bye`, or native publisher stop.
- `getConnectionMap`, `connectionMap`, and `reconnectPeer` are official mesh-diagnostic/recovery shapes. Native currently rejects the request forms because it does not expose the same browser peer-map model; if implemented later, it should use these names rather than inventing native-only diagnostics.
- The OBS plugin gates rich `remoteStats`, `connectionMap`, recovery controls, and OBS state behind its `enableRemote` setting because those payloads expose OBS runtime information. Game Capture has a different control model: director identity and the configured VDO `remote` token govern control requests, while native `remoteStats` remains an aggregate compatibility response keyed by the stream id.

Native alignment after this pass:
- WebSocket/control parser normalization now accepts `transferred` and bare `listing` arrays as listings, and accepts `sendoffer`, `play`, and stream-id-bearing `joinroom` as offer-request aliases.
- Plain room `joinroom` without a stream id remains non-offer signaling and is ignored by the publisher peer-creation path.
- `optimizedBitrate` is now recognized VDO vocabulary with a native owner. Native applies it as a per-peer video route cap/disable value, continues to use `bitrate`/`audioBitrate` for explicit peer route enable/rate state, and continues to reserve `targetBitrate`/`targetAudioBitrate` for sender-target requests.
- Authorized `hangup` now stops the native publisher endpoint through the normal stop workflow. Unauthorized `hangup` returns `rejected: "hangup"`.
- Native data-channel handling is already field-driven for actionable publisher controls. In one parsed message it can echo `cbid`, update peer metadata, answer `ping`, apply authorized controls, set pending keyframe state from `keyframe` or compatibility `requestKeyframe`, process rate/resolution controls, and answer `requestStats` / `requestStatsContinuous`; it should not be refactored into a first-match-only command switch.
- Metadata-only `info` refresh is a passive peer-state update. It may send a fresh `info` response for room peers, but it must not exit the data-channel handler before other top-level fields in the same message are evaluated.
- Browser-only control requests continue to return VDO-shaped `rejected` messages instead of silent no-ops or native-only response objects.
- Browser-only control rejections are capability rejections. They do not imply that official browser VDO rejects those same messages for directors; they mean Game Capture currently has no browser page, WebAudio graph, camera PTZ control surface, WHIP session, or peer-map model to mutate.
- Official UI/source-state payloads that are not actionable for a native window publisher remain state-only messages. They should be accepted as known vocabulary when reviewed, but they should not mutate capture, encoder, track, peer cleanup, or endpoint stop state unless a separate official control field requires that transition.
- Current native data-channel dispatch remains intentionally terminal for scoped signaling payloads (`description`, `candidate`, or `candidates`). This matches the adjacent OBS plugin classifier, where data-channel signaling is the primary message type. A future change should not make scoped answer/candidate processing fall through into publisher controls unless official VDO starts combining signaling with ordinary control fields.
- Data-channel `bye` is presence-based cleanup, matching official VDO's `"bye" in msg` receive path. It is allowed to return immediately and suppress later fields because peer teardown is the whole transition. WebSocket `bye` remains truthy/normalized signaling cleanup because it is parsed through `VdoSignaling` rather than the bound peer data channel.
- `requestStatsContinuous` native state is not only an immediate response flag. `true` stores the per-peer continuous-stats subscription, sends immediate `info` and `remoteStats`, and the video maintenance loop later repeats `remoteStats` while the flag is set. `false` clears that per-peer subscription.
- Inbound `remoteStats` is official receiver-side telemetry. The native publisher currently has no UI or routing consumer for peer-provided remote stats, so it does not cache inbound `remoteStats`; if Game Capture later gains a native viewer/control telemetry panel, that cache should use official `remoteStats` with legacy `stats` only as compatibility input.
- Initial offer failures are terminal for that new peer. If `sendPeerOffer` cannot create an SDP offer or cannot send it through signaling, the peer is removed immediately instead of waiting for close/failure callbacks.

## How To Update

Use this as a map, not as documentation for end users.

When source changes:
- Add or rename the affected state owner.
- Add the new event or transition edge.
- Add or update guards that must hold before a transition is allowed.
- Add side effects only when they cross component boundaries.
- Promote a review risk to an invariant only after the code makes it true.
- Remove a review risk only after code inspection and shipped-workflow testing verify it.

Flow map terms:
- Owner: component that is allowed to mutate the state.
- State: durable condition that affects future behavior.
- Event: external or internal trigger.
- Guard: condition that must be true before the transition is valid.
- Side effect: visible effect on another component, network peer, track, encoder, or UI.
- Risk: workflow-level concern found during review.

## Component Ownership

| Component | Owns | Reads | Emits |
| --- | --- | --- | --- |
| MainWindow | UI settings, firewall warning dismissal, user-selected capture/options | app status, capture window list | start capture, go live, stop, runtime settings |
| VersusApp | global live/capture state, peer-session map, video/audio encoder lifecycle, media routing, recovery policy | UI options, signaling events, WebRTC events, capture/audio frames | offers, media packets, data messages, status callbacks |
| VdoSignaling | WebSocket connection, room join/seed messages, encrypted signaling payload transport | room, stream id, password, salt | listing, offer requests, answers, ICE candidates, reconnect events |
| WebRtcClient | one peer connection, data channel, video/audio/alpha track objects, RTP packetization | media plan requests from VersusApp | state changes, local candidates, datachannel events, RTP sends |
| WindowCapture | selected-window graphics capture, latest captured frame stream | target HWND and capture config | BGRA frames |
| VideoEncoder | HQ/LQ/alpha encoding instances and codec/hardware fallback | encoder config, captured frames | encoded video packets |
| WindowAudioCaptureCore | primary audio source and optional additional microphone source | audio source config, process id | PCM audio chunks |
| OpusEncoder | Opus encoder state | mixed PCM | encoded audio packets |
| DualStreamPolicy | room/direct viewer route decisions | peer role/init/media flags | HQ, LQ, or no media route |
| Installer and MainWindow firewall check | installed firewall rule and portable warning | current executable path | inbound UDP allow rule or warning |
| Diagnostics export | read-only snapshot of app, signaling, peer, media, and candidate state | VersusApp state owners | JSON diagnostics file on exit or headless timeout |

## State Inventory

### App State

Owner: VersusApp.

Core states:
- Idle: no live stream, no active signaling connection.
- CaptureStarting: capture/audio/encoder setup is in progress.
- CaptureReady: capture callbacks can deliver frames; encode thread can run.
- LiveStarting: signaling options are committed and WebSocket join/publish is in progress.
- LivePublished: stream id is seeded, peers may request offers.
- LiveRecovering: signaling or ICE recovery is being attempted while capture may remain active.
- Stopping: teardown is in progress.

Durable fields that shape future transitions:
- live flag.
- capturing flag.
- reconnecting flag.
- current room, stream id, password, salt, remote-control token.
- ICE mode and server list.
- active encoder config: codec, width, height, fps, bitrate, alpha.
- active Opus encoder bitrate target.
- peer-session map.
- latest captured frame cache.
- pending global keyframe flag.

### Peer Session State

Owner: VersusApp owns map membership and policy fields. WebRtcClient owns transport internals.

Peer identity:
- UUID from signaling.
- session id, usually stable `default` for room/direct reconnects when the remote request does not provide one.
- optional stream id from signaling.

Signaling state:
- offer dispatch status.
- answer received status.
- pending ICE candidates.
- renegotiation queued.
- candidate type last observed.
- offer count and recovery-offer count.
- accepted answer count and last answer source.
- local candidates sent and remote candidates applied.
- last connection state and last state-change timestamp.
- last removal reason and bounded peer timeline.

Room/control state:
- room mode flag.
- init received flag.
- role validity and role.
- assigned tier.
- video enabled.
- audio enabled.
- init deadline.
- peer metadata and system fields.
- director/control authorization status.

Transport/media state:
- data channel open flag.
- disconnected since timestamp.
- waiting for keyframe.
- requested video/audio bitrate limits.
- stats request mode.
- alpha receive capability.
- media plan mutex.
- WebRtcClient pointer.

### Video State

Owner: VersusApp owns encoder lifecycle and routing. VideoEncoder owns codec internals. WebRtcClient owns tracks.

Core states:
- CaptureFrameAvailable: a BGRA frame is cached and ready for encode.
- NoActiveVideoTrack: encode thread should skip video work.
- HQOnly: all eligible video peers receive HQ.
- MixedHqLq: scene/direct peers receive HQ; non-scene room peers receive LQ when enabled.
- AlphaEligible: VP9 dual-track alpha is enabled globally and a peer has advertised compatible alpha receive support.
- EncoderRecovering: current encoder failed and fallback/reinitialization is being attempted.

Snapshot state:
- VideoStateSnapshot is the read-side contract for control/info/UI-facing video state.
- Snapshot includes current encoder config, active HQ dimensions, encoder name, codec name, hardware flag, and LQ encoder state.
- Snapshot reads must be short and must not send network messages while holding the video lock.

Metrics state:
- Captured frames count every WindowCapture callback.
- Sent frames count successful encoded video packet fanout events.
- Dropped frames count capture callbacks that overwrite a frame already waiting for the encode thread.
- Operator health and diagnostics expose recent/smoothed video bitrate, audio bitrate, FPS, dropped-frame rate, and total drop/encode/send counters.
- Operator health also exposes total OS CPU and RAM load so user-facing overload warnings are not confused with app-only encode failure counters.
- Candidate path health is candidate-observation evidence, not a browser `selectedCandidatePair` equivalent.

### Audio State

Owner: VersusApp owns source selection and routing. Audio capture cores own device/process capture. OpusEncoder owns encode state.

Core states:
- PrimaryAudioInactive: no selected primary audio source is running.
- PrimaryAudioActive: selected-window, output, communications, or microphone source is running.
- AdditionalMicInactive: no additional microphone route.
- AdditionalMicActive: secondary mic is captured and buffered.
- MixPrimaryAndMic: primary chunks are mixed with available mic samples.
- MicStandaloneFallback: additional mic can produce audio if primary audio is inactive.

Mix controls:
- Primary gain applies to the selected game/app/output/microphone source after normalization and before source metering/mixing.
- Additional microphone gain applies after normalization and before buffering or standalone fallback encode.
- The mixed-output limiter runs after primary+mic summing and before mixed-output metering/Opus encode.
- Gain is bounded to 0% through 200%; limiter defaults on for public-user safety.

### Diagnostics State

Owner: VersusApp exposes a read-only JSON snapshot; individual component owners remain authoritative for their state.

Triggers:
- `--diagnostics-out=<path>` writes diagnostics during headless timeout and again on process exit.
- GUI mode also writes on process exit when the same argument is provided.

Snapshot boundaries:
- Diagnostics must not mutate signaling, peer, capture, encoder, or audio state.
- Password and remote token values are not written; only password enabled/disabled and token length are exported.
- Pending remote ICE queues are summarized by key and count rather than dumping every queued candidate.
- Peer timelines are bounded and capture state transitions, offer/recovery reasons, candidate flow, answer application, rejected controls, data-channel open/close, and removal reasons.
- Diagnostics include recent health metrics plus total captured/sent/dropped frame counts, encode/send failure counts, audio send failures, total system CPU/RAM usage, and audio mix gain/limiter settings.

Review use:
- Use diagnostics JSON with logs to explain slot churn, repeated reconnects, missing answers, stale peers, unexpected room roles, per-peer bitrate disables, codec fallback, and Control Center rejection behavior.
- If a live VDO.Ninja issue is hard to reproduce, run a headless stress/E2E workflow with `--diagnostics-out` so final app state and peer-route state are preserved.
- Diagnostics are app-side evidence, not an official VDO protocol message. Do not send diagnostics over the VDO data channel unless a future official field owner is identified.

### Signaling State

Owner: VdoSignaling owns socket transport. VersusApp owns policy and callback effects.

Core states:
- Disconnected.
- Connecting.
- ConnectedUnjoined.
- RoomJoined.
- Published.
- Reconnecting.
- ClosedByStop.

Security state:
- encryption enabled or disabled.
- password-derived key material is used for offers, answers, and candidates when enabled.
- share/log URLs must redact password values.

## Thread And Lock Map

These are the important concurrency boundaries. Keep this section current when adding callbacks or long-running work.

| Boundary | Owner Lock Or Guard | Allowed Work While Held | Do Not Do While Held |
| --- | --- | --- | --- |
| Peer session map | peerSessionsMutex | insert, find, erase, copy shared pointers | WebRTC shutdown, signaling sends, datachannel sends, encoder work |
| Video state and encoders | videoSendMutex | read/write video config, active dimensions, encoder init/shutdown/reconfigure, encode/send pass | peer map traversal after taking another lock, blocking signaling operations |
| Latest captured frame | latestVideoFrameMutex | replace/read latest frame cache | encode, signaling, peer mutation |
| Additional audio buffer | additionalAudioMutex | append/read/mix mic samples | Opus encode, peer sends |
| Audio encode | audioEncodeMutex | Opus encode and audio PTS update | capture-device calls |
| Recent metrics window | metricsWindowMutex | update/read smoothed bitrate/FPS/drop rates | network sends, encode, peer mutation |
| System resource sample | systemResourceMutex | update/read prior OS CPU time baseline | network sends, encode, peer mutation |
| Signaling transport operations | signalingOpsMutex | connect, disconnect, join, publish, send offer/candidate | peer map mutation after taking other locks |
| Per-peer media plan | PeerSession.mediaPlanMutex | ensure one media-plan renegotiation path per peer | global peer cleanup |
| Runtime event callback | runtimeEventMutex | copy callback | invoke callback while holding lock |

Thread/callback sources:
- UI thread calls start/stop/config setters.
- WindowCapture frame callback writes latest frame and wakes encode thread.
- Encode thread owns normal video encode/send cadence.
- Audio capture callbacks feed audio encode/send path.
- Signaling WebSocket callback receives listing, offer requests, answers, candidates, alerts, and disconnects.
- WebRtcClient callbacks report peer state, ICE candidates, keyframe requests, datachannel messages, and datachannel open/close.
- Maintenance thread prunes stale peers, sends periodic info/stats, and retries cached video frames.

Lock ordering rule:
- Prefer short snapshots over nested locks.
- If both video state and peer state are needed, snapshot video state first, release videoSendMutex, then inspect peers.
- Peer shutdown is intentionally async and outside peerSessionsMutex.

## Signaling Message Cases

VdoSignaling incoming cases:
- `listing`, `transferred`, or a bare `listing` array: updates room listing callback with UUID, stream id, label/name, publisher/director hints.
- `offerSDP`, `sendoffer`, `play`, or stream-id-bearing `joinroom`: asks publisher to create or reuse a PeerSession for UUID/session/stream id. Plain `joinroom` without a stream id is room admission and must not create a PeerSession.
- `iceRestartRequest`: asks publisher to recover ICE for an existing UUID/session; it must not be routed through PeerSession creation/replacement.
- `bye` and `request:"cleanup"`: ask VersusApp to remove the matching peer session by UUID/session.
- encrypted or plain `description`: parsed into offer or answer payload.
- encrypted or plain `candidate`: parsed into one ICE candidate.
- encrypted or plain `candidates`: parsed into bundled ICE candidates.
- `request:"alert"`, `request:"error"`, or bare `alert`: treated as a signaling alert and can surface stream-id conflicts or room-capacity errors.
- `someonejoined` with a stream id, `videoAddedToRoom`, and `videoRemovedFromRoom`: official room membership deltas used by clients that maintain a room-member snapshot. Native publisher does not currently expose stream-added/removed callbacks, so these are known upstream room-state messages rather than publisher peer creation, peer cleanup, or slot assignment triggers.

Candidate routing rule:
- If UUID/session resolve to the current PeerSession, the candidate enters that peer's WebRtcClient.
- If UUID is present but no matching PeerSession exists yet, VersusApp queues the candidate for up to 15s, capped at 100 candidates per UUID/session key.
- Queued pre-peer candidates drain only after that peer's answer has been accepted. Empty-session queued candidates drain only when UUID lookup is unambiguous.
- Singular candidate payloads without a non-empty ICE candidate line are rejected. Bundled candidate arrays skip non-object or empty candidate entries and only parse as a candidate message when at least one valid candidate remains.
- Candidates with no UUID cannot be safely associated with a future WebSocket PeerSession and are ignored.

VdoSignaling outgoing cases:
- `joinroom`: joins hashed room id with room config.
- `seed`: publishes hashed stream id.
- `unpublish`: stops published stream.
- `description`: sends encrypted or plain offer/answer JSON.
- `candidate`: sends encrypted or plain candidate JSON.

Encryption cases:
- Normal password mode: offers, answers, and candidates are AES encrypted using password plus salt.
- Disabled mode: password values `false`, `0`, or `off` disable encryption.
- Logging rule: password presence may be logged, but password values and share URL password query values are redacted.

## Data Channel Message Cases

Messages first pass through `tryHandlePeerSignalMessage`. If the payload is a signaling payload, the datachannel can apply answers/candidates scoped to the peer session.

Current native dispatch order:
- Scoped signaling first: `description`, `candidate`, or `candidates` is handled as an answer/candidate payload for the already-bound peer and then returns.
- Terminal peer lifecycle next: data-channel `bye` or `request:"cleanup"` removes the bound PeerSession and returns.
- Callback/presence responses: `cbid` echoes `{cbid}`; `ping` echoes `pong`.
- Terminal peer recovery: data-channel `iceRestartRequest` rebuilds the bound PeerConnection, sends a recovery offer, and returns.
- Peer metadata and init: `info`, `init`, inline role/media flags, and direct-viewer fallback update peer role, media flags, alpha capability, and system metadata.
- Privileged endpoint/control branches: `hangup`, settings readback, device refresh/change, `requestVideoHack`, `refreshConnection`, and `refreshAll` check director/remote-token guards according to the compatibility contract.
- Routed target-control guard: `requestAs` plus `targetBitrate`, `optimizedBitrate`, `targetAudioBitrate`, or `requestResolution` is handled before those fields reach normal runtime control parsing. Native requires a requester `UUID`, director or `remote` authorization, and a `requestAs` target matching its stream-id `remoteStats` key; mismatches return without applying global encoder/audio changes.
- Recognized unsupported browser/OBS controls emit VDO-shaped `rejected` responses without inventing native behavior.
- Field-fanout publisher controls: keyframe, director media mute/volume, bitrate/audio bitrate, target bitrate/audio target, generic resolution, continuous stats, and immediate stats are evaluated independently unless an earlier terminal branch returned.

JSON message families:
- Peer info and metadata: label/app/version/platform/browser and alpha receive capability.
- Init and media request: room role, scene/director/guest/viewer classification, video/audio enabled flags.
- Keyframe request: sets global keyframe state.
- Peer lifecycle and transport recovery: `bye` removes the bound peer session immediately; `iceRestartRequest` rebuilds the underlying PeerConnection inside the existing bound PeerSession, restores desired media tracks, sends a recovery offer with fresh ICE credentials, and requests a keyframe.
- Director media controls: `remoteVideoMuted` and audio `volume`; require director role.
- Peer rate limits: `bitrate`, `optimizedBitrate`, and `audioBitrate` requested video/audio bitrate updates; zero disables a media send route but does not set VDO mute state. `optimizedBitrate` follows official VDO's per-peer optimized-cap owner rather than changing native global encoder state.
- Sender target controls: `targetBitrate` and `targetAudioBitrate`; false/unlock clears the target route cap and positive values request a sender target. Zero values are ignored for target controls to match VDO.Ninja's `parseInt(value) || -1` path.
- Routed sender target controls: `requestAs` wraps `targetBitrate`, `optimizedBitrate`, `targetAudioBitrate`, and `requestResolution` when the official director/stats UI asks one peer to control another target. Native can only route that wrapper to its own aggregate publisher target, not to arbitrary browser peer UUIDs.
- Runtime geometry controls: object-form `requestResolution` uses VDO scale-bound semantics; string-form resolution and width/height action aliases are native literal-dimension controls. Generic VDO controls require init in room mode but are not director/token-only.
- Control Center settings readback: director-only `getAudioSettings` returns `audioOptions`; director-only `getVideoSettings` returns `videoOptions`; either authorized request also returns `mediaDevices`.
- Control Center video settings mutation: `requestVideoHack` requires director role or a valid remote token, supports only native encoder geometry fields `width`, `height`, and `frameRate`, follows VDO's `ctrl` aspect-lock semantics for width/height, and rejects unsupported camera/PTZ/image keys with VDO's `rejected` family after authorization.
- Control Center device switching: director-only `refreshMicrophone` resends audio/device readback; `refreshVideo` is a director or remote-token exception that resends video/device readback. Director-only `changeCamera`, `changeMicrophone`, and `changeSpeaker` return `mediaDeviceChange`; unsupported authorized changes also return `rejected` so the director side does not wait silently. Unauthorized device controls return `rejected` and do not leak device payloads.
- Control Center endpoint stop: `hangup` requires director role or a valid remote token, stops live publishing and capture through the normal native stop path, and returns `rejected: "hangup"` when unauthorized.
- Control Center recovery: `refreshConnection` and `refreshAll` require director role or a valid remote token. Native maps the upstream publisher-wide ICE-restart intent to rebuilt PeerConnections for every current PeerSession, then sends recovery offers with fresh ICE credentials; `refreshAll` also resends settings/device payloads to the requesting control peer before recovery offers.
- Unauthorized Control Center recovery requests return VDO-shaped `rejected` messages for `refreshConnection` or `refreshAll`, matching official VDO's non-director/no-remote-token branch.
- Unsupported browser-only Control Center commands return VDO-shaped `rejected` messages. Native does not try to fake browser features such as advanced WebAudio effects, low-cut filters, solo/private chat volume routing, recording, order/URL/label changes, browser reload, sender scale, PTZ, per-peer `keyframeRate`, WHIP restart, clock/group controls, rotate/mirror controls, connection map requests, or reconnect-peer commands.
- Stats requests: one-shot or continuous stats/info responses.
- Unknown or malformed JSON: ignored or logged without escaping the transport callback.
- Presence-based VDO controls: data-channel `iceRestartRequest`, `hangup`, `refreshMicrophone`, `refreshVideo`, `requestVideoHack`, `refreshConnection`, and `refreshAll` are classified by field presence, matching official VDO's `"field" in msg` branches. WebSocket `iceRestartRequest` is also presence-based. WebSocket `bye` remains truthy-or-`request:"cleanup"` based, while data-channel `bye` remains presence-based, matching the official split documented in the adjacent plugin notes.
- Extreme numeric JSON: bitrate, volume, resolution, FPS, candidate `sdpMLineIndex`, and boolean-like numeric fields are parsed with bounded integer conversion. Oversized unsigned/signed numbers clamp to native `int` range and non-finite floats fall back to defaults instead of escaping parser callbacks.

Runtime-control contract:
- Positive `targetBitrate` is approximated as native global encoder state because the native publisher pre-encodes once and routes packets to peers; the peer route state still records the requested VDO target.
- `bitrate` remains a per-peer video route/rate-limit request. `targetBitrate` preserves VDO false/unlock and positive target semantics; `targetBitrate:0` is not treated as route disable.
- Native keeps the configured publisher bitrate as a sender-target baseline. Runtime `targetBitrate` changes may move the global encoder, but they do not overwrite that baseline; boolean `targetBitrate:false` restores it.
- Audio target bitrate is Opus encoder state; false/unlock restores the default target. Audio route disable remains the `audioBitrate:0` path.
- Resolution is global encoder geometry state.
- Object-form `requestResolution: {w,h,s,c}` is VDO sender-scale vocabulary. Native resolves it against the latest captured frame dimensions when available, otherwise the configured HQ encoder dimensions, then converts the scale result into global encoder geometry. Fit requests use the smaller scale; cover requests use the larger scale; both cap at 100% to avoid upscaling.
- String-form `requestResolution` and width/height action aliases are literal native geometry controls. Width-only or height-only literal requests are completed into a width-and-height pair before encoder reconfiguration.
- VDO's normal peer bitrate/resolution/audio target messages are applied from the data-channel message flow, not treated as director-only remote controls.
- `requestAs` is not a normal peer-control field. It is an official routing wrapper. For native, accepted `requestAs` target controls are equivalent to direct target controls only after the target matches the native stream-id stats key and authorization passes; otherwise they are ignored like official VDO's missing-target path.
- Successful control changes are reflected through updated `info`, `miniInfo`, and, where stats are requested, `remoteStats` messages. `rejected` is reserved for VDO-recognized denied or unsupported actions such as director-only media controls and browser-only Control Center commands.
- When one data-channel message contains multiple supported mutations, state is applied first and `info` is emitted from the final coherent state, not from an intermediate partial state.
- VDO mute metadata (`video_muted_init`, `muted`, `videoMuted`, `muteState`) reflects explicit mute state, not bitrate-zero send suppression.
- `info.video_muted_init` and `info.muted` are initial/info-state fields. When an already-initialized peer changes its requested media state, native also sends top-level `videoMuted` and/or `muteState` so VDO browser viewers update live placeholder/audio state instead of staying on stale init state.
- Settings readback is not a success ack. It is data for the director UI: `audioOptions`, `videoOptions`, and `mediaDevices` are separate payloads, and `cbid` callback echo only completes the request callback.
- Native `videoOptions` intentionally exposes only width, height, and frame-rate constraints because those are backed by the runtime encoder reconfigure path.
- `videoOptions.currentCameraConstraints` is the VDO-shaped readback for the native controllable HQ output. Use it to validate settings-panel geometry changes when the requesting room peer is routed to LQ.

## Track And Renegotiation Cases

Initial PeerConnection:
- Data channel is always negotiated as `sendChannel`.
- Initial video and audio m-lines are included so room/slot mode can attach media without waiting for a second offer.
- Initial alpha is false; alpha is added later only when both sides support VP9 dual-track alpha.

Track addition:
- Video, audio, and alpha tracks are added by WebRtcClient.ensureMediaTracks.
- Tracks are added only; disabling media is enforced by route policy and send suppression.
- If answer has not arrived, VersusApp marks `renegotiationQueued`.
- After answer arrives, queued media plan is applied and may send a new offer.
- Any new video-capable route forces a keyframe.

Track send gates:
- Video packet send requires active video track, route policy allowing video, and keyframe readiness.
- Any transition that re-enables a peer video route must reset that peer's keyframe gate before sending non-keyframes again.
- Alpha packet send requires active alpha track, VP9 dual-track mode, peer alpha capability, and matching keyframe gate.
- Audio packet send requires active audio track and route policy allowing audio.

## Recovery And Removal Cases

Peer removal reasons currently logged centrally:
- `connection-closed`: WebRtcClient reports closed state.
- `connection-failed`: WebRtcClient reports failed state.
- `stale-disconnected-prune`: maintenance prunes peer after disconnected grace window.
- `offer-create-failed`: initial or renegotiation offer creation failed.
- `offer-send-failed`: initial or renegotiation offer could not be written to the signaling transport.

Peer retention cases:
- Disconnected state is retained temporarily for ICE recovery.
- Room peers with datachannel open but no init can fallback to viewer after the init grace window.
- Direct peers without metadata can fallback to viewer/HQ after the direct grace window.
- Direct peers with in-flight info metadata are allowed to finish capability negotiation instead of racing fallback.

Signaling recovery cases:
- WebSocket disconnect starts signaling recovery if live and not stopping.
- Recovery attempts set pending global keyframe and try reconnect/rejoin/republish.
- Stop/live teardown disables recovery and clears peers.

Encoder recovery cases:
- Runtime reconfigure failure tries to restore previous config.
- Hardware encode instability first tries hardware self-recovery.
- If self-recovery fails, alternate hardware preferences are tried.
- If all hardware paths fail, software H.264 fallback is attempted.
- Unstable non-H.264 external software encode can fallback to H.264.

## Flow Maps

### 1. App Initialization

Owner: MainWindow and VersusApp.

Transitions:
- App starts -> MainWindow is constructed -> firewall rule check is scheduled.
- VersusApp initializes -> capture, signaling, and status callbacks are registered.
- UI applies saved options -> app remains Idle until user starts capture/go-live.

Guards:
- Firewall warning should be advisory only. It must not block local capture or publishing.

Side effects:
- Portable/ZIP builds can warn when the Windows Firewall rule is missing or points to another executable path.
- Installed builds should have the installer-created inbound UDP program rule.

### 2. Start Capture

Owner: VersusApp.

Transition chain:
- User chooses window and encoder options.
- Idle or previous capture state -> CaptureStarting.
- Reset per-session media counters and live flags that should not leak across sessions.
- Start selected-window graphics capture.
- Resolve capture process id for selected-window audio.
- Start primary audio source.
- Start optional additional microphone source.
- Initialize HQ video encoder.
- Initialize VP9 alpha encoder only when alpha mode requires it.
- Initialize Opus encoder.
- Install capture frame callback.
- Start encode thread.
- CaptureStarting -> CaptureReady.

Guards:
- A valid window handle is required before capture starts.
- Audio source `selected-window` needs a usable process id.
- Encoder initialization failure should leave the app unable to publish video, not half-live.

Side effects:
- Capture frames enter the latest-frame cache.
- Audio chunks can be encoded and routed once peers exist.

### 3. Go Live And Publish

Owner: VersusApp with VdoSignaling transport.

Transition chain:
- User starts live session.
- CaptureReady -> LiveStarting.
- Commit room, stream id, password, salt, token, encoder config, ICE mode.
- Resolve ICE servers.
- Clear prior peer sessions.
- Register signaling callbacks.
- Connect WebSocket.
- Join room when room mode is configured.
- Seed/publish stream id.
- Generate share URL for UI/logging.
- LiveStarting -> LivePublished.

Guards:
- Signaling operations are serialized so join, publish, and reconnect do not interleave incorrectly.
- Logged URLs must not include raw password query values.
- Room codec constraints may reject unsupported codec choices before publishing.

Side effects:
- VDO signaling room receives a published stream id.
- Viewers/directors can request offers.
- Remote control token exists when remote control is enabled.

### 4. Signaling Offer Request To Peer Session

Owner: VersusApp owns peer session creation. WebRtcClient owns the per-peer connection.

Transition chain:
- Signaling receives `offerSDP` request.
- Resolve session id:
  - provided session id wins.
  - otherwise reuse existing default session for same UUID where possible.
  - otherwise use stable `default`.
- Enforce viewer/session limits.
- Replace stale existing peer session for the same peer key.
- Create PeerSession with UUID, session, stream id, room mode, default media flags.
- Create WebRtcClient with initial media-track preferences.
- Wire WebRTC callbacks into the PeerSession.
- Store PeerSession in the map.
- Send initial offer.

Guards:
- Same UUID/session key can only map to one active PeerSession.
- Empty session handling must be stable or room slot assignment can churn.
- Peer removal must not race with callbacks from an old WebRtcClient.

Side effects:
- Peer receives encrypted offer via signaling.
- Local candidates are sent immediately or buffered until offer dispatch.

### 5. WebRTC Transport State

Owner: WebRtcClient detects transport state. VersusApp applies app policy.

Transition chain:
- New -> Connecting: offer/answer exchange is active.
- Connecting -> Connected: mark peer as connected, clear disconnected timestamp, force a keyframe.
- Connected -> Disconnected: retain session for recovery and set disconnected timestamp.
- Any -> Failed: mark degraded, possibly switch from STUN-only to TURN-capable ICE if configured, then remove session.
- Any -> Closed: remove session.

Guards:
- Disconnected is not immediate removal; Closed and Failed are removal paths.
- Session removal must be idempotent.

Side effects:
- Recovery can request new offers.
- Waiting-for-keyframe is set so the next usable frame starts the viewer cleanly.

### 6. Data Channel And Room Init

Owner: VersusApp.

Transition chain:
- Data channel opens.
- Mark peer data channel open.
- Set room init deadline for room-mode peers that have not sent init.
- Send publisher info.
- Apply current media plan.
- Incoming data message is first checked for peer signaling messages.
- Peer metadata/info updates capability fields.
- Room init classifies peer role and media desires.
- Init accepted -> init received, role valid when appropriate, media enabled flags updated.
- Send updated publisher info.
- Apply peer media plan.

Guards:
- In room mode, media should not route until init is received or fallback init is explicitly applied.
- Director media-control messages require room-director status; separate remote-token exceptions are listed in the Control Center settings and recovery sections.
- Peer alpha capability must be explicit before adding/sending alpha track.

Side effects:
- Peer may get additional renegotiation offer if media tracks need to be added.
- Room viewers without valid role are routed to no media unless fallback handles them.

### 7. Media Plan And Track Negotiation

Owner: VersusApp chooses plan. WebRtcClient adds tracks.

Transition chain:
- Media plan request arrives from datachannel open, init, director media control, rate limit, alpha capability, or queued renegotiation.
- Route policy computes desired video/audio/alpha.
- If data channel is not open, defer.
- If answer is not received, queue renegotiation.
- Once answer exists, ask WebRtcClient to ensure required tracks.
- If tracks were added, send a fresh offer.
- If video was added, force keyframe.

Guards:
- Track addition is one-way for the current PeerConnection; disabling media should stop routing, not assume track removal.
- Renegotiation must wait for answer.
- Alpha track requires both global alpha mode and peer alpha capability.

Side effects:
- Additional SDP offer is sent for newly added tracks.
- Existing RTP packetizers start sending only when tracks are open.

### 8. Video Encode And Send

Owner: VersusApp.

Transition chain:
- Capture callback stores latest BGRA frame and wakes encode thread.
- Encode thread checks live/capturing/stop state.
- If no active video track exists, skip encode work.
- Build peer route sets:
  - HQ peers.
  - LQ peers.
  - alpha-eligible HQ peers.
- Encode HQ frame using current encoder config.
- If LQ peers exist, lazily initialize LQ encoder and encode LQ frame.
- Send packets only to peers whose route and track state allow video.
- If alpha-eligible peers exist, extract alpha plane, encode VP9 alpha packet, and send on alpha track.
- Update counters, last sent dimensions, and keyframe wait state.

Guards:
- Room peers require init before media route.
- Non-scene room peers should not receive HQ unless LQ is disabled or policy says so.
- Keyframe-waiting peers should only start receiving once a keyframe is available.
- Color and alpha tracks must use the same spatial transform when source and target aspect ratios differ.

Side effects:
- Encoder failure can trigger hardware reset/fallback.
- Periodic maintenance may send a cached frame when sends become stale.

### 9. Audio Capture, Mix, Encode, Send

Owner: VersusApp.

Transition chain:
- Primary audio chunk arrives.
- Normalize channel layout/sample rate.
- Pull buffered additional-mic samples if present.
- Mix primary and mic when both are available.
- Encode Opus.
- Route encoded packet to peers whose audio plan allows it.
- Additional-mic chunk arrives.
- Buffer mic samples.
- If primary is inactive, encode standalone mic fallback and route to peers.

Guards:
- Selected-window audio should use the captured process where possible.
- Additional microphone is additive to selected-window/game audio, not a replacement.
- Audio route must obey room init and media enabled flags.

Side effects:
- Only the on-screen/allowed peer should be audible in room routing modes.

### 10. Runtime Control

Owner: VersusApp.

Transition chain:
- Peer sends target bitrate, resolution, fps, or action request.
- Parse request.
- Require room init when room mode is active.
- Peer sends director media-state control such as `remoteVideoMuted` or `volume`.
- Require director role before changing peer media enabled state.
- Apply runtime encoder config mutation.
- Reinitialize encoders where required.
- Send updated info on success after all mutations from the incoming message have been applied.
- Force keyframe if video encoding contract changed.

Guards:
- Room-mode controls require valid init.
- Director media-state controls require director role; remote tokens do not authorize `remoteVideoMuted` or `volume`.
- Resolution should be treated as a paired width-and-height contract, unless one owner explicitly derives the missing dimension from aspect ratio.
- Encoder config reads and writes should be consistently locked or made atomic snapshots.

Side effects:
- All peers receive output from the new global encoder config, not just the requester.

### 11. Control Center Settings Readback

Owner: VersusApp.

Transition chain:
- Control Center opens audio/video settings for a peer.
- Director sends `getAudioSettings` and/or `getVideoSettings`.
- Native echoes `{ cbid }` only when VDO included a callback id.
- Native verifies director status before sending settings payloads.
- Native sends `audioOptions` when authorized audio settings were requested.
- Native sends `videoOptions` when authorized video settings were requested.
- Native sends `mediaDevices` when either authorized settings family was requested.
- Director sends `refreshMicrophone` or `refreshVideo`.
- Native resends microphone options/device list only for a director-authorized `refreshMicrophone`.
- Native resends video options/device list for director-authorized or remote-token-authorized `refreshVideo`.
- Authorized director or remote-token controller sends `requestVideoHack` for width, height, or frame rate.
- Native maps supported fields into runtime video control.
- Width/height with `ctrl` leaves the other dimension unspecified so the native aspect completion path can preserve source aspect.
- Width/height without `ctrl` fills the other dimension from current native output so the requested slider changes only one dimension.
- Frame rate changes only frame rate.
- Native sends updated `info` and `videoOptions` after a successful supported mutation.
- Director sends `changeCamera`, `changeMicrophone`, or `changeSpeaker`.
- Native accepts only the current synthetic capture device and rejects unsupported live device switches with `mediaDeviceChange` and `rejected`.

Guards:
- `cbid` completion is not settings data; the director UI needs the separate VDO payload families.
- `audioOptions`, `videoOptions`, and `mediaDevices` must be top-level VDO-shaped messages addressed with `UUID`.
- Settings/device payloads are privileged Control Center data. `getAudioSettings`, `getVideoSettings`, `refreshMicrophone`, and device-change messages require director status; `refreshVideo` is a remote-token exception.
- `requestVideoHack` must require director status or a valid remote token, unlike generic peer bitrate/resolution messages.
- `requestVideoHack` width/height must preserve VDO's `ctrl` semantics; generic `requestResolution` partial-dimension behavior does not apply to this settings-panel path.
- Generic object-form `requestResolution` must preserve VDO's scale-bound semantics; settings-panel `requestVideoHack` must not be reused to interpret the stats picker shape.
- `videoOptions` must expose only controls that native can actually apply without inventing browser-only behavior.
- Unsupported device changes must be explicit negative responses so the director side does not wait silently.
- Settings readback should snapshot video/audio state before building payloads.

Side effects:
- Control Center audio/video settings panels have concrete option payloads to render.
- Successful supported `requestVideoHack` changes affect the global native encoder, not just the requesting director.
- Unsupported live device changes remain visible to the director as failures rather than silent no-ops.

### 12. Recovery And Cleanup

Owner: VersusApp.

Transition chain:
- Maintenance loop periodically scans peer sessions.
- Init timeout can apply fallback or prune a peer.
- Disconnected peer can remain briefly for ICE recovery.
- Failed/closed peer is removed.
- Signaling reconnect can rejoin and republish.
- Authorized `refreshConnection` rebuilds the underlying PeerConnection for every current PeerSession, sends recovery offers with fresh ICE credentials, and requests a keyframe.
- Authorized `refreshAll` resends audio/video/device payloads to the requester, rebuilds the underlying PeerConnection for every current PeerSession, sends recovery offers with fresh ICE credentials, and requests a keyframe.
- Authorized `hangup` stops the publisher endpoint and is separate from peer cleanup.
- Data-channel `iceRestartRequest` rebuilds the underlying PeerConnection under the existing peer session, sends a recovery offer with fresh ICE credentials, and requests a keyframe.
- Data-channel `bye` or `request:"cleanup"` removes the peer session and asynchronously shuts down the peer client.
- WebSocket `bye` or `request:"cleanup"` resolves UUID/session to one peer session, removes it, and asynchronously shuts down the peer client.
- A recovery refresh is not complete until the rebuilt transport's offer is answered; continued decode alone can still be the pre-refresh connection.
- Stop live sends unpublish, closes signaling, clears peers, stops maintenance.
- Stop capture stops capture/audio/encode threads and releases encoders.

Guards:
- Peer session removal must be safe when callbacks arrive late.
- Stop live and reconnect must not both mutate signaling transport at the same time.
- Clearing peers should close WebRtcClient instances outside locks where possible.

Side effects:
- Slot-mode viewers may see reconnects as new peer/session identities if identity stability is broken.

## State Transition Tables

These tables are the compact review model. When the code changes, each affected row should still have one owner, one guard, and one observable outcome.

### Peer Session Lifecycle

| State | Owner | Entry Event | Valid Next States | Required Guard Or Exit Condition |
| --- | --- | --- | --- | --- |
| Requested | VdoSignaling callback | `offerSDP` request arrives | Creating, Rejected | UUID is present; max-viewer policy allows a new or replacing session |
| Creating | VersusApp | Peer key is resolved | OfferPending, Removed | WebRtcClient initializes with current ICE/video snapshot |
| OfferPending | VersusApp and WebRtcClient | Peer is stored and offer creation starts | OfferSent, Removed | Offer SDP is non-empty and signaling transport accepts the outbound message |
| OfferSent | VersusApp | `sendOffer` succeeds | Answered, Removed | Local ICE candidates can be sent or buffered until dispatch completes |
| Answered | VersusApp and WebRtcClient | Signaling or datachannel answer is applied | DataOpen, Connected, RenegotiationPending, Removed | Answer matches UUID/session or accepted scoped session |
| DataOpen | WebRtcClient callback | Data channel opens | InitPending, Initialized, Removed | Info message can be sent; room peers get an init deadline |
| InitPending | VersusApp | Room peer has data channel but no init | Initialized, FallbackInitialized, Removed | Deadline expires or remote init arrives |
| Initialized | VersusApp | Init/metadata accepted or direct fallback applied | MediaActive, RenegotiationPending, Removed | Role and media flags are valid for room policy |
| RenegotiationPending | VersusApp | Media plan needs tracks after answer | OfferSent, Removed | Data channel is open and previous offer is answered |
| MediaActive | VersusApp and WebRtcClient | Tracks and route allow packets | Disconnected, RenegotiationPending, Removed | Route policy, keyframe gate, active track, and bitrate limits allow sends |
| Disconnected | WebRtcClient callback | ICE disconnected | Connected, Removed | Grace window allows recovery before stale prune |
| Removed | VersusApp | Failure, close, prune, replacement, or teardown | none | Client shutdown occurs outside peer map lock |

### Signaling Lifecycle

| State | Owner | Entry Event | Valid Next States | Required Guard Or Exit Condition |
| --- | --- | --- | --- | --- |
| Disconnected | VdoSignaling | App idle or socket closed | Connecting, ClosedByStop | Live state decides whether reconnect is allowed |
| Connecting | VdoSignaling | `connect` starts WebSocket | ConnectedUnjoined, Disconnected | Active socket identity must match callback socket |
| ConnectedUnjoined | VdoSignaling | WebSocket open | RoomJoined, Published, Disconnected | Join is required only when room is configured |
| RoomJoined | VdoSignaling | `joinroom` send succeeds | Published, Disconnected | Room id and password hashing match view URL expectations |
| Published | VdoSignaling | `seed` send succeeds | Reconnecting, ClosedByStop | Outbound offers/candidates must report false if socket send is unavailable |
| Reconnecting | VersusApp | live socket disconnect | ConnectedUnjoined, ClosedByStop | Stop was not requested and reconnect backoff allows another attempt |
| ClosedByStop | VersusApp | stop live/capture teardown | Disconnected | Recovery must be disabled before socket close side effects run |

### Video And Track Lifecycle

| State | Owner | Entry Event | Valid Next States | Required Guard Or Exit Condition |
| --- | --- | --- | --- | --- |
| Configured | MainWindow and VersusApp | User settings or runtime control commit config | EncoderReady, ReconfigureFailed | Codec/alpha/room constraints are accepted |
| EncoderReady | VersusApp and VideoEncoder | Encoder initialization succeeds | Active, Recovering, Stopped | Snapshot exposes coherent dimensions, codec, encoder name, and LQ state |
| Active | Encode thread | Capture frames and active tracks exist | Recovering, Reconfiguring, Stopped | Route policy and keyframe gates choose who receives packets |
| VideoRouteTargeted | VersusApp | Data channel receives `bitrate`, `optimizedBitrate`, or `targetBitrate` | Active, Reconfiguring, Stopped | `bitrate:0` and `optimizedBitrate:0` suppress that peer's video route without setting VDO mute state; `optimizedBitrate:false` and `targetBitrate:false` clear caps; positive `optimizedBitrate` stays per-peer, while positive `targetBitrate` may also update native global encoder bitrate |
| Reconfiguring | VersusApp | Runtime bitrate/resolution/fps control | EncoderReady, ReconfigureFailed | Width and height are resolved as a pair before applying |
| Recovering | VersusApp and VideoEncoder | Encoder send/init failure | EncoderReady, Stopped | Recovery tries current hardware, alternate hardware, then software fallback |
| Stopped | VersusApp | Stop capture/live | Configured | Encoders and packetizers are released before next capture session |

### Audio Lifecycle

| State | Owner | Entry Event | Valid Next States | Required Guard Or Exit Condition |
| --- | --- | --- | --- | --- |
| PrimaryInactive | VersusApp | No primary source running | PrimaryActive, AdditionalMicOnly, Stopped | Selected-window process id may be unavailable |
| PrimaryActive | Audio capture core | Primary source starts | MixPrimaryAndMic, PrimaryOnly, Stopped | PCM format is normalized before Opus encode |
| AdditionalMicOnly | Audio capture core | Additional mic starts without primary | MixPrimaryAndMic, Stopped | Fallback audio route is allowed when primary has no samples |
| MixPrimaryAndMic | VersusApp | Primary chunk plus buffered mic samples | PrimaryOnly, AdditionalMicOnly, Stopped | Mixing does not run under additional-audio buffer lock |
| BitrateTargeted | VersusApp and OpusEncoder | Data channel receives `targetAudioBitrate` | MixPrimaryAndMic, PrimaryOnly, AdditionalMicOnly, Stopped | Runtime target is clamped to a legal Opus bitrate or reset to the default target; `audioBitrate:0` suppresses that peer's audio route without setting VDO mute state |
| Stopped | VersusApp | Stop capture/live | PrimaryInactive | Capture devices and Opus state are released |

## Failure And Retry Matrix

| Failure | Detection Point | Expected Workflow Response | Review Risk If Violated |
| --- | --- | --- | --- |
| WebSocket not connected during `joinroom` or `seed` | `VdoSignaling::sendMessage` returns false | `joinRoom` or `publish` returns false and live start/recovery can fail visibly | App can claim a room is ready while the server never saw it |
| WebSocket not connected during offer send | `VdoSignaling::sendOffer` returns false | Peer offer send fails, peer is removed with `offer-send-failed`, and no `offerDispatched` state is set | Slot/control-center viewer can appear connected locally while no offer ever reached it |
| WebSocket not connected during answer or candidate send | `VdoSignaling::sendAnswer` or `sendCandidate` returns false | Caller can log/drop/retry according to owner policy | ICE or renegotiation can silently stall |
| Offer creation returns empty SDP | `WebRtcClient::createOffer` returns empty | Peer is removed with `offer-create-failed` | Peer remains in map with no path to answer |
| WebSocket ICE restart arrives for existing peer | `VdoSignaling` receives `iceRestartRequest` with UUID/session | Resolve the current PeerSession, rebuild its underlying PeerConnection, restore desired tracks, and send a recovery offer without replacing the peer | Slot/control-center state churns because recovery looks like a disconnect/reconnect |
| Answer arrives for unknown peer | answer callback cannot find UUID/session | Drop and log | Stale browser responses mutate a new session |
| Candidate arrives before matching peer session | candidate callback cannot find UUID/session but UUID is present | Queue in VersusApp with TTL/cap, then drain after answer acceptance; drop only unidentifiable or expired candidates | Valid candidates are dropped during normal VDO signaling order |
| Remote ICE candidate arrives before remote description | WebRtcClient candidate add path sees no remote description | Queue candidate on the peer connection and drain after remote description succeeds | Valid candidates are dropped during normal VDO signaling order |
| Datachannel signaling payload has mismatched UUID/session | datachannel signal parser checks peer scope | Drop mismatched payload | Cross-peer answer/candidate can be applied to the wrong PeerConnection |
| Datachannel opens but room init never arrives | maintenance deadline | Apply explicit fallback init or prune | Room peers can receive media before role/policy is known |
| ICE disconnected | WebRtcClient state callback | Retain for grace window, then stale prune | Temporary network hiccups become needless slot churn |
| ICE failed or closed | WebRtcClient state callback | Remove peer, optionally promote future ICE mode to TURN-capable | Failed transport keeps consuming route/track state |
| Runtime reconfigure fails | encoder reinit path | Restore previous config and log/report failure | Global encoder contract diverges from status/info messages |
| Alpha mode active with aspect mismatch | video encode path | Color and alpha use shared aspect-fit rectangle | Transparent areas are offset from color pixels |
| Password-bearing view URL is logged | share URL logging path | Redact password query value | Logs leak stream secret |
| Missing firewall allowance | MainWindow check or installer | Installed build creates program rule; portable build warns | WebRTC falls back to relay or fails direct UDP unexpectedly |

## Cross-Component Contracts

### Signaling Send Contract

Outbound signaling methods return transport acceptance, not just JSON construction success.

Required contract:
- `sendOffer` returns false when the websocket is missing, closed, or not connected.
- `sendAnswer` returns false under the same transport failures.
- `sendCandidate` returns false under the same transport failures.
- Peer state may move to `OfferSent` only after `sendOffer` returns true.
- If initial or renegotiation offer send fails, the PeerSession must not remain as a healthy waiting-for-answer session.

### ICE Candidate Ordering Contract

Remote ICE candidate delivery is not ordered after remote SDP application.

Required contract:
- WebSocket remote candidates can arrive before VersusApp has created the matching PeerSession.
- Pre-peer candidates are queued by UUID/session for a short bounded window and are never applied to an ambiguous UUID.
- A WebRtcClient starts each offer exchange with no applied remote description for that exchange.
- Incoming remote candidates before remote description are queued on that peer connection.
- A successful remote description application drains queued remote candidates.
- A failed remote description application does not flush candidates or advance the peer as answered.
- Resetting or shutting down a peer connection clears queued remote candidates.

### Peer Identity Contract

UUID and session are the only durable local peer key.

Required contract:
- Empty session requests resolve before peer creation.
- Same UUID/session replaces the old PeerSession exactly once.
- Stale callbacks from replaced clients must not mutate the replacement.
- Datachannel-scoped signaling can omit UUID/session only when it is already bound to the current peer.
- Datachannel-scoped signaling may also carry the browser sender UUID while retaining the native peer session; on the bound data channel, matching session alone is accepted to align with official VDO refresh/recovery answers.

### Media Routing Contract

Tracks, route policy, and packet sends are separate decisions.

Required contract:
- Track existence does not imply media is allowed.
- Room media route requires init or explicit fallback init.
- `bitrate:0` and `audioBitrate:0` disable sends without removing tracks and without setting VDO mute state.
- `targetBitrate:false` restores route eligibility and, in native's global encoder approximation, returns the encoder to the configured publisher bitrate. `targetBitrate:0` is ignored like stock VDO.Ninja.
- Video and audio enabled flags are per-peer route inputs, not global encoder state.
- Global runtime encoder changes affect every peer after they apply.

### Snapshot Contract

Video state shared with UI/control/info must be read as a coherent snapshot.

Required contract:
- Info, stats, initial peer config, alpha decisions, and public getter paths use VideoStateSnapshot or hold the same lock.
- Network sends do not happen while holding the video-state lock.
- Width and height in any one status payload are a coherent pair from one state source. `info` and `miniInfo` describe the requesting peer's effective route; `remoteStats` describes native publisher aggregate output keyed by stream id.
- A data-channel message that changes route bitrate/audio state and runtime video state emits a coherent post-mutation `info` snapshot, rather than an earlier route-only snapshot.

### Control Center Settings Contract

Settings-panel messages are data-readback requests, not generic acknowledgements.

Required contract:
- `getAudioSettings` produces a top-level `audioOptions` message.
- `getVideoSettings` produces a top-level `videoOptions` message.
- Either settings request also produces a top-level `mediaDevices` message.
- `refreshMicrophone` and `refreshVideo` resend the relevant options and device list.
- `refreshMicrophone` is director-only; `refreshVideo` is director or remote-token authorized.
- `requestVideoHack` requires director status or a valid remote token, then maps only supported native video fields into runtime control while preserving VDO's `ctrl` width/height semantics.
- Unsupported camera, microphone, or speaker changes complete with explicit `mediaDeviceChange` failure and a VDO-recognized rejection family.
- Unsupported browser-only VDO controls complete with explicit `rejected` responses, not silent no-ops.
- `refreshConnection` and `refreshAll` require director status or a valid remote token and must rebuild the underlying PeerConnection inside every current peer session, then complete new offer/answer exchanges.
- Unauthorized `refreshConnection` and `refreshAll` requests must produce `rejected` responses instead of only logging locally.
- Release workflow validation for recovery must observe the rebuild path, fresh ICE credentials, and a later peer answer.
- Callback completion through `{ cbid }` is separate from all settings payloads.

## Review Questions For Future Passes

Use these as the code-review prompts before line-level inspection.

- Can any transition set a later state before the lower-level owner reports success?
- Can any callback mutate a peer after that UUID/session has been replaced?
- Does any send method ignore a false transport result where the caller believes state advanced?
- Does any recovery path keep a peer alive without a future event that can make progress?
- Can any media plan add tracks before the first answer, or clear a queued renegotiation before sending the offer?
- Can room-mode media route before init, fallback init, or explicit no-media policy?
- Is each datachannel control classified as a normal VDO peer-control message or a director/token-only remote-control message?
- Does every VDO settings-panel request produce the official payload family the director UI consumes?
- Can a runtime config change report one dimension from old state and another from new state?
- Do HQ, LQ, and alpha paths all share the same source-to-output geometry decision?
- Does cleanup release clients outside locks and tolerate callbacks that arrive after removal?

## Core Invariants

These are the review rules that should remain true.

1. VersusApp is the only owner of peer-session map membership.
2. WebRtcClient owns transport objects; VersusApp owns policy decisions.
3. Room-mode peers must be initialized or explicitly fallback-initialized before receiving media.
4. Media-track addition must wait for answer or be queued for renegotiation.
5. Track presence and media routing are separate concepts: a track may exist while route policy sends no packets.
6. Global encoder config changes affect every peer.
7. Width and height are paired per status payload; `info`/`miniInfo` are peer-route-specific, while `remoteStats` is native publisher aggregate status.
8. HQ color, LQ color, and alpha transforms must stay geometrically aligned.
9. Passwords can be used for encryption and share URLs, but logs should only show redacted or presence-only values.
10. WebRTC UDP reachability needs an inbound program firewall allowance when Windows Firewall blocks unsolicited UDP.
11. Read-side reporting of video config, dimensions, codec, encoder, and alpha mode must use VideoStateSnapshot or hold videoSendMutex.
12. A successful signaling send return value means the transport accepted the message for sending.
13. Peer offer state must not advance to `OfferSent` until outbound offer signaling succeeds.
14. Remote ICE candidates are allowed to arrive before PeerSession creation or before remote description and must be queued rather than dropped.
15. VDO-facing `info` messages should include both URL-style config fields and official initial media fields.
16. `audioBitrate` and `targetAudioBitrate` are distinct VDO controls; the first is the peer route/rate-limit request, the second changes the sender audio target.
17. `bitrate` and `targetBitrate` are distinct VDO controls: `bitrate:0` disables a peer route, while `targetBitrate:false` unlocks a sender cap. Neither should be conflated with VDO UI mute fields.
18. Re-enabling a muted or bitrate-disabled video route must force the peer to wait for a fresh keyframe before packets resume.
19. Director-authorized Control Center settings requests must be answered with VDO-shaped settings/device payloads; callback echoes alone are not enough, and non-director peers must not receive option/device payloads through settings readback.
20. `requestVideoHack` is a privileged settings mutation path and must require director status or a valid remote token before native encoder mutation.
21. `requestVideoHack` width/height handling must honor VDO's `ctrl` semantics: aspect-coupled when `ctrl` is true, single-dimension with the other dimension held when false.
22. One incoming data-channel control message should produce VDO-facing status from the final state after all supported mutations in that message have applied.
23. Control Center recovery messages (`refreshConnection`, `refreshAll`) are privileged, publisher-wide VDO messages and should not be silently ignored or scoped only to the requesting peer.
24. A recovery refresh succeeds only after the rebuilt transport sends an offer with fresh ICE credentials and receives an answer; decode continuity alone is not proof that recovery happened.
25. Director media-state controls (`remoteVideoMuted`, `volume`) are director-only; remote tokens must not authorize them.
26. Settings/device controls must preserve VDO's split: settings readback, microphone refresh, and device changes are director-only; `requestVideoHack`, `refreshVideo`, `refreshConnection`, and `refreshAll` are director or remote-token authorized.
27. Remote-token authorization must read VDO's `remote` field only; accepting a `token` alias invents a native-only control shape.
28. Unauthorized recovery controls must return VDO-shaped `rejected` messages so Control Center/API callers observe the failure.
29. Unsupported official VDO Control Center commands must return VDO-shaped `rejected` messages instead of silent no-ops.
30. A peer answer only advances peer-session state after the WebRTC client accepts the remote description.

## Recent Workflow Review Findings

These are not style nits. They are larger workflow risks identified while tracing recent changes.

### Finding A: Runtime Resolution Control Can Mutate Only One Dimension

Status: fixed in current working tree on 2026-06-28.

Impact: Control Center can request only height or only width. The current workflow accepts partial resolution requests and applies each dimension independently. That can create unintended global encoder sizes such as preserving a previous width while changing only height.

Why it matters: The video pipeline treats output size as a global contract shared by encoder, info messages, and all peers. Partial mutation makes the contract ambiguous.

Expected invariant: runtime resolution changes are either width-and-height together, or one component explicitly derives the missing dimension from the current capture/output aspect ratio.

Resolution: partial width-only or height-only requests are completed before encoder reconfiguration by preserving the latest capture aspect ratio when available, falling back to the current encoder aspect ratio. Updated `info`, `miniInfo`, and `remoteStats` report the resulting paired output dimensions.

### Finding B: Aspect-Fit Color Transform And VP9 Alpha Transform Can Diverge

Status: fixed in current working tree on 2026-06-28.

Impact: The current local fix changes BGRA color conversion to aspect-fit with black bars. The VP9 alpha path still extracts alpha from the captured source and lets the gray encoder prepare its input independently. If source aspect and target aspect differ, color and alpha can describe different pixel geometry.

Why it matters: Dual-track alpha needs color and alpha frames to have the same transform. A mismatch can make transparency appear offset, stretched, or cropped relative to color.

Expected invariant: color and alpha use one shared geometry transform.

Resolution: the VP9 alpha path now builds a fitted alpha plane at the HQ encoder output dimensions before encoding. Color and alpha use the shared `versus::video::computeAspectFitRect` helper, and the synthetic border area is transparent in the alpha plane.

### Finding C: Video Config Is A Shared State Object With Mixed Read Discipline

Status: fixed in current working tree on 2026-06-28.

Impact: runtime control mutates encoder config under the video send lock, while some info/report paths read parts of the same config outside that lock.

Why it matters: This is low probability but high confusion when debugging. Peers can receive info snapshots that do not represent one coherent encoder state.

Expected invariant: video config should be read as an atomic snapshot or under one consistent lock.

Resolution: VideoStateSnapshot is now the read-side boundary for peer info, remote stats, initial peer config, media-plan alpha decisions, public encoder getters, and stream metrics. Room codec lock and lifecycle reset paths now mutate video state under videoSendMutex.

### Finding D: Peer Removal Has Several Valid Sources

Status: instrumentation added in current working tree on 2026-06-28.

Impact: failed state, closed state, datachannel close, init timeout, explicit cleanup, stale disconnected pruning, and live stop can all remove or mutate peer sessions.

Why it matters: This is the area most likely to explain slot-mode churn when a room peer reconnects and is assigned a new slot. The source may be normal remote UUID/session churn, but the local workflow has enough removal paths that a stale callback or empty-session mismatch can make that harder to reason about.

Expected invariant: UUID/session identity resolution happens once per offer request, and every removal path is idempotent and traceable.

Resolution: central peer-session removal now logs UUID, session, removal reason, and whether peers remain. Further slot-mode diagnosis should add remote slot metadata if the director exposes it on the data channel.

### Finding E: Firewall Rule Is Correctly Program-Scoped But Intentionally Broad

Impact: the installer adds an inbound UDP allow rule for the executable with no fixed port range. This is broad at the UDP level but scoped to the app executable.

Why it matters: WebRTC chooses dynamic UDP ports, so a narrow fixed range would require changing the ICE/RTC stack configuration and deployment expectations. Program-scoped UDP is the practical Windows Firewall shape for the current architecture.

Expected invariant: installed builds create the rule; portable builds warn when it is missing or stale; neither path hardcodes a fixed WebRTC port range.

Review action: keep the warning, but make sure release notes distinguish installed builds from portable ZIP builds.

### Finding F: Signaling Offer Send Can Report Success Without Sending

Status: fixed in current working tree on 2026-06-28.

Impact: outbound offer, answer, and candidate methods built valid JSON but returned true even if the websocket transport rejected the send because it was disconnected or closed. The peer offer workflow could then mark an offer as dispatched even though the signaling server never received it.

Why it matters: the peer lifecycle table requires `OfferPending -> OfferSent` to happen only after transport acceptance. Violating that can strand a room/control-center viewer in a local waiting-for-answer state with no remote offer to answer.

Expected invariant: a successful signaling send return value means the transport accepted the message for sending, and offer state advances only after that success.

Resolution: outbound signaling methods now return the result of the underlying transport send. Failed offer sends remove the peer with `offer-send-failed` instead of leaving it as a healthy waiting-for-answer session. A regression check verifies offer, answer, and candidate sends fail while disconnected.

### Finding G: Remote ICE Candidate Ordering Did Not Match VDO.Ninja

Status: fixed in current working tree on 2026-06-28.

Impact: VDO.Ninja may deliver ICE candidates before the corresponding remote answer or before the native WebRtcClient has accepted that answer. The native wrapper previously tried to add the candidate immediately.

Why it matters: Official VDO queues pending ICE and drains it after `setRemoteDescription`. Dropping or failing early candidates can create connection loops, especially in room/control-center flows where signaling and data-channel messages can interleave.

Expected invariant: remote ICE is accepted, queued, and drained according to remote-description state.

Resolution: WebRtcClient now clears candidate state at the start of each offer exchange, queues remote candidates until remote description succeeds, drains queued candidates after remote SDP application, and clears the queue on reset/shutdown.

### Finding H: Custom Data-Channel Response Envelopes Did Not Match VDO.Ninja

Status: fixed in current working tree on 2026-06-28.

Impact: the native publisher sent custom `ack` envelopes for init, rate-limit, and control messages, and custom `callbackID`/`requestID` stats responses. The reviewed VDO.Ninja data-channel path does not consume those objects.

Why it matters: unrecognized response envelopes add noise to the control channel and make the native publisher look like a different protocol than stock VDO.Ninja. That complicates room/control-center debugging because success, rejection, and callback completion no longer line up with upstream message handling.

Expected invariant: data-channel responses use VDO-recognized message families unless an extension is explicitly documented inside the extensible `info` payload.

Resolution: the native publisher now echoes VDO `cbid` callbacks, reports successful state through `info`, `miniInfo`, and `remoteStats`, and uses VDO's `rejected` object only for denied actions that VDO already models as rejections. The custom `ack` envelopes, custom stats callback payloads, and top-level peer `stats` field were removed.

### Finding I: Generic Bitrate/Resolution Controls Were Over-Gated

Status: fixed in current working tree on 2026-06-28.

Impact: the native publisher treated generic `targetBitrate` and `requestResolution` messages as director/token-only controls. Stock VDO.Ninja processes those messages in the normal peer data-channel path, while reserving stricter checks for explicitly privileged actions.

Why it matters: when a normal VDO viewer sent a resolution/control request, the native publisher could respond with a visible `rejected` message. That made a successful solo viewer decode show VDO's "not recognized as director" rejection text even though the stream itself was working.

Expected invariant: match VDO's control split. Generic bitrate/resolution requests may update the publisher's encoder state through the normal peer path; director identity remains required for director-only actions such as remote media mute and volume controls.

Resolution: generic bitrate/resolution requests now apply after room-init gating only. They report success through updated `info`, `miniInfo`, and `remoteStats`; failed apply attempts are logged rather than surfaced as VDO rejection messages.

### Finding J: `targetAudioBitrate` Was Collapsed Into `audioBitrate`

Status: fixed in current working tree on 2026-06-28.

Impact: the native publisher handled `audioBitrate` and `targetAudioBitrate` in the same branch. Positive `targetAudioBitrate` values only updated per-peer route metadata and did not change the Opus encoder target. The sender-cap side of the official VDO behavior was missing.

Why it matters: stock VDO.Ninja distinguishes per-peer audio rate limiting from sender audio target changes. Treating them as the same operation makes Control Center audio bitrate commands look accepted while the actual encoded audio target remains unchanged.

Expected invariant: `audioBitrate` changes peer audio route/rate-limit state, including zero route-disable. `targetAudioBitrate` changes the sender audio target for positive values and restores the default target on boolean false/unlock.

Resolution: OpusEncoder now exposes a runtime bitrate setter. `targetAudioBitrate` updates the Opus target for positive values, resets to the default target for false/unlock values, and ignores zero values like stock VDO.Ninja. `audioBitrate` remains the per-peer audio route/rate-limit path. The release control workflow validates positive target and boolean false/unlock transitions.

### Finding K: Rate-Limit Zero And Target Unlock Were Conflated

Status: fixed in current working tree on 2026-06-28.

Impact: the native publisher originally only used positive `targetBitrate` values as a runtime video-control request. The first attempted fix conflated target zero with rate-limit zero. Official VDO.Ninja uses `bitrate:0` and `audioBitrate:0` for route suppression; `targetBitrate:false` and `targetAudioBitrate:false` unlock sender caps.

Why it matters: using route-enabled flags for bitrate-zero suppression incorrectly advertises VDO mute metadata and can cause the viewer UI to remove or hide video. Treating target zero as route disable also diverges from VDO.Ninja's data-channel handlers.

Expected invariant: `bitrate` and `audioBitrate` zero suppress sends without changing mute metadata. `targetBitrate` and `targetAudioBitrate` only act on positive targets and boolean false/unlock. Positive `targetBitrate` remains native's global encoder approximation because the native app pre-encodes once for all peers.

Resolution: `bitrate` and `audioBitrate` now use requested bitrate zero as send-suppression gates rather than mute flags. `targetBitrate` and `targetAudioBitrate` ignore zero values, preserve boolean false/unlock, and apply positive target values through the existing runtime sender-control paths. Audio bitrate-zero routing follows the same separation from VDO mute metadata.

### Finding L: `targetBitrate:false` Did Not Restore Native Sender Target

Status: fixed in current working tree on 2026-06-28.

Impact: after a positive `targetBitrate`, the native publisher changed its single global encoder bitrate. A later boolean `targetBitrate:false` cleared the per-peer requested route state but left the encoder at the previous target cap.

Why it matters: stock VDO.Ninja handles boolean false by setting the peer `setBitrate` field to false and then applying `limitBitrate(UUID, -1)`, which falls back to `outboundVideoBitrate` or the default sender bitrate. Without the native restore, Control Center could appear to unlock the target while the publisher remained capped.

Expected invariant: configured publisher bitrate is separate from runtime target bitrate. Positive native `targetBitrate` may temporarily move the global encoder, but only explicit user configuration updates the configured baseline.

Resolution: `VersusApp` now tracks `configuredVideoBitrateKbps_` from `setVideoConfig`. The data-channel boolean false path sets peer requested video bitrate back to `-1` and applies the preserved configured bitrate through runtime video control. The release control workflow now validates the fresh info message and publisher log for this unlock transition.

### Finding M: Control Center Settings Requests Had No Native Payload Response

Status: fixed in current working tree on 2026-06-28.

Impact: clicking audio or video settings in the VDO.Ninja Control Center could produce no options for a native Game Capture peer. The native publisher echoed request callbacks but did not send the `audioOptions`, `videoOptions`, or `mediaDevices` payloads consumed by the official director UI.

Why it matters: stock VDO.Ninja treats settings readback as separate data messages. The `cbid` echo only completes the request callback; it is not the settings data. Without the option payloads, Control Center has no VDO-compatible data to render.

Expected invariant: `getAudioSettings` sends `audioOptions`, `getVideoSettings` sends `videoOptions`, either request sends `mediaDevices`, and unsupported device mutations complete with explicit VDO-shaped failure messages.

Resolution: the native publisher now sends synthetic but VDO-shaped audio/video option payloads, enumerates available microphone input devices, exposes only width/height/frame-rate controls that native can apply, maps supported `requestVideoHack` fields into runtime control, and returns explicit `mediaDeviceChange`/`rejected` responses for unsupported live device switching. The release control workflow validates settings readback, a `requestVideoHack` frame-rate update, and continued decode after subsequent runtime controls.

### Finding N: `requestVideoHack` Was Not Director Or Remote-Token Gated

Status: fixed in current working tree on 2026-06-28.

Impact: while adding native support for VDO's video settings mutation path, `requestVideoHack` was initially parsed like a generic peer runtime-control message. That would allow any initialized peer to request width, height, or frame-rate changes.

Why it matters: official VDO.Ninja gates `requestVideoHack` behind director status or a valid remote token. Generic bitrate/resolution requests remain normal peer-path messages, but settings-panel mutation is a privileged control.

Expected invariant: `requestVideoHack` follows VDO's director/remote-token authorization before any native encoder mutation is considered.

Resolution: the native handler now checks director role or remote token before parsing supported `requestVideoHack` fields. Unauthorized requests are ignored after logging, matching VDO's no-op path, while authorized requests can still update supported width, height, or frame rate and return fresh `videoOptions`. The release Control Center workflow validates both the unauthorized guard and the authorized remote-token branch.

### Finding O: `requestVideoHack` Ignored VDO's No-Ctrl Dimension Semantics

Status: fixed in current working tree on 2026-06-28.

Impact: normal Control Center width/height slider changes could alter both dimensions in the native publisher. For example, a height-only settings change could also recalculate width from aspect ratio.

Why it matters: official VDO.Ninja treats width/height settings changes differently depending on `ctrl`. Without `ctrl`, it preserves the other current dimension. With `ctrl`, it lets the browser preserve aspect ratio by applying only the requested dimension. Native had one partial-dimension path and used aspect completion for both cases.

Expected invariant: `requestVideoHack` width/height uses VDO's `ctrl` semantics. Generic `requestResolution` can keep native's paired/aspect-completed resolution contract, but settings-panel sliders must not unexpectedly change the other dimension when `ctrl` is false.

Resolution: the native `requestVideoHack` handler now fills the other dimension from the current output when `ctrl` is false and leaves it partial when `ctrl` is true. The release Control Center workflow validates that an authorized height change without `ctrl` keeps the previous width.

### Finding P: Combined Controls Emitted Intermediate Info

Status: fixed in current working tree on 2026-06-28.

Impact: a single data-channel message containing both route/audio target changes and a runtime resolution change could emit an `info` message after the route/audio mutation but before the resolution mutation. Control Center could observe a valid requested audio bitrate paired with stale width/height from the previous video state.

Why it matters: VDO-facing status is the director UI's state contract. A stale intermediate snapshot makes one logical control operation look partially applied and complicates diagnostics around slot/control-center state.

Expected invariant: all supported mutations from one incoming data-channel control message are applied before native emits the success `info` for that message.

Resolution: the native handler now applies peer media-plan changes immediately but defers the route/audio `info` response until after any runtime video control in the same message. The release Control Center workflow validates that the target-audio status after a combined control message carries the requested audio target and the final requested resolution.

### Finding Q: Control Center Recovery Messages Were Ignored

Status: fixed in current working tree on 2026-06-28.

Impact: VDO.Ninja's Control Center can send `refreshConnection` and `refreshAll` to restart/recover a publisher's peer connections. Official VDO handles these messages by restarting ICE, and `refreshAll` also refreshes audio/video devices. Native did not handle either message, so the director recovery action completed at the send layer but had no publisher-side effect.

Why it matters: this is a workflow bug rather than a missing convenience feature. A director trying to recover a stuck slot would issue an upstream VDO message that native silently ignored, leaving the stream in the same state.

Expected invariant: privileged Control Center recovery messages require director role or a valid remote token and must trigger concrete publisher peer recovery transitions.

Resolution: native now maps authorized `refreshConnection` to rebuilt underlying PeerConnections for every current PeerSession, requests keyframes, and maps authorized `refreshAll` to requester-scoped settings/device readback plus the same publisher-wide rebuild-based recovery. The release Control Center workflow sends `refreshConnection`, confirms the publisher emitted the fan-out log and a rebuild recovery offer with fresh ICE credentials, observes a later answer, and verifies post-refresh decode.

### Finding R: Recovery Workflow Validation Did Not Prove The Fresh Offer Completed

Status: fixed in current working tree on 2026-06-28.

Impact: after adding native `refreshConnection` handling, the release workflow confirmed that a recovery offer was logged and that video still decoded afterward. That could pass even if the existing pre-refresh peer connection kept decoding and the recovery offer never received an answer.

Why it matters: recovery is an offer/answer state transition. A validation pass that only observes offer send plus decode can miss a broken answer path.

Expected invariant: recovery workflow validation observes the rebuilt transport path, fresh ICE credentials, and a later peer answer before treating the refresh as successful.

Resolution: the release Control Center workflow now requires a `refresh-connection` rebuild log, changed ICE credentials, and an `Applying peer answer` log entry after the offer log, in addition to post-refresh decode.

### Finding S: Remote Media-State Controls Used The Wrong Authorization Family

Status: fixed in current working tree on 2026-06-28.

Impact: while aligning remote-control handling, native briefly treated `remoteVideoMuted` and `volume` like the remote-token recovery/video-settings exceptions. Official VDO.Ninja rejects `remoteVideoMuted` from non-director peers and handles media-state changes in the director control branch.

Why it matters: a remote token is intentionally narrower than director identity. Letting it mute video or change volume would expand the native remote-control surface beyond official VDO behavior.

Expected invariant: `remoteVideoMuted` and `volume` require director identity. Remote-token exceptions remain limited to `requestVideoHack`, `refreshVideo`, `refreshConnection`, and `refreshAll`.

Resolution: native now checks director status before applying `remoteVideoMuted` or `volume`. The direct Control Center workflow validates that a remote-token-only `remoteVideoMuted` request is rejected, while the director-room workflow validates that a real director can still mute and unmute video through VDO's normal UI control.

### Finding T: Settings And Device Readback Bypassed Control Authorization

Status: fixed in current working tree on 2026-06-28.

Impact: native handled `getAudioSettings`, `getVideoSettings`, `refreshMicrophone`, `refreshVideo`, `changeCamera`, `changeMicrophone`, and `changeSpeaker` before checking whether the sender was a director or held the configured remote token. Any connected peer could request audio/video option payloads and device lists, and could trigger device-change response paths.

Why it matters: official VDO.Ninja processes settings readback and device mutation inside director-authorized control branches, with only selected recovery/video-refresh paths accepting remote-token authorization. Native's early handling turned privileged Control Center state into a generic peer request.

Expected invariant: settings/device option payloads and device-change control responses require director status before native sends details or attempts a control response, except for the official remote-token `refreshVideo` exception.

Resolution: native now gates settings readback, `refreshMicrophone`, and device-change handling with director identity, while keeping `refreshVideo` available to a valid remote token. Unauthorized readback requests produce no option/device payloads; unauthorized device controls return VDO-shaped `rejected` responses. The direct Control Center workflow validates that unauthenticated and remote-token-only settings readback yield no settings payload, that remote-token `refreshVideo` still returns video/device payloads, and that remote-token `refreshMicrophone` is rejected. The director-room workflow validates that a real director receives settings payloads.

### Finding U: Remote Control Accepted A Non-VDO Token Alias

Status: fixed in current working tree on 2026-06-28.

Impact: native accepted either `remote` or `token` as the remote-control credential field. Official VDO.Ninja's reviewed remote-control paths compare `msg.remote` against `session.remote`; `token` is not part of that message contract.

Why it matters: compatibility work should narrow to official message shapes. Accepting a native-only alias makes it easier for tests or integrations to pass while diverging from VDO.Ninja.

Expected invariant: remote-token authorization reads the top-level `remote` field only.

Resolution: native now extracts remote-control credentials only from `remote`. The direct Control Center workflow validates that a correct token supplied through `token` is rejected for `refreshVideo`, while the same credential supplied through `remote` succeeds.

### Finding V: Unauthorized Recovery Controls Were Silent

Status: fixed in current working tree on 2026-06-28.

Impact: native rejected unauthorized `refreshConnection` and `refreshAll` requests only in logs. Official VDO.Ninja sends `rejected: "refreshConnection"` or `rejected: "refreshAll"` back over the data channel when the sender is neither a director nor remote-token authorized.

Why it matters: Control Center and API callers use VDO-shaped `rejected` responses to surface failed permission checks. Silent local logging makes the control path look like it was sent but ignored.

Expected invariant: unauthorized recovery controls return VDO-shaped rejection messages.

Resolution: native now sends `rejected` responses for unauthorized `refreshConnection` and `refreshAll`. The direct Control Center workflow validates both rejection branches before validating the authorized remote-token recovery path.

### Finding W: Unsupported Browser-Only Controls Were Silent

Status: fixed in current working tree on 2026-06-29.

Impact: native ignored several official VDO Control Center commands that are browser-specific and not implemented by Game Capture, including advanced audio mutations, low-cut/audio-isolation controls, remote browser reload, sender scaling, PTZ controls, WHIP restart, and connection-map/reconnect helpers. Official VDO has an established `rejected` response family for these commands when they cannot be honored by the recipient.

Why it matters: silent no-ops make Control Center and API callers look broken because the request is sent but no VDO-shaped result ever arrives.

Expected invariant: unsupported official VDO Control Center commands return a `rejected` message naming the command.

Resolution: native now rejects unsupported browser-only VDO controls through the existing data-channel `rejected` family. The direct Control Center workflow validates `requestAudioHack`, `requestChangeLowcut`, `restartWhip`, `reload`, `scale`, `zoom`, `autofocus`, and `exposure` as representative unsupported commands.

### Finding X: Failed Answers Could Advance Peer State

Status: fixed in current working tree on 2026-06-29.

Impact: `applyPeerAnswer` marked `answerReceived`, cleared buffered local ICE candidates, and consumed queued renegotiation before `WebRtcClient::setRemoteDescription` reported success.

Why it matters: official VDO can receive malformed, stale, or racing signaling payloads without treating them as successful negotiation. Native must preserve pre-answer state when the lower-level peer connection rejects the answer, otherwise recovery can lose candidates or skip a needed renegotiation.

Expected invariant: failed remote-description application does not mark the peer answered, clear pending local candidates, or consume queued renegotiation.

Resolution: native now verifies the peer is still current, applies the WebRTC answer, and only then marks the peer answered, drains pending local candidates, and consumes queued renegotiation.

### Finding Y: Data-Channel Signaling Can Use Sender UUID With Matching Session

Status: reviewed and preserved in current working tree on 2026-06-29.

Impact: a review pass flagged `tryHandlePeerSignalMessage` because it accepts data-channel answers and candidates when the payload `session` matches the bound peer, even if the payload carries a different `UUID`.

Why it matters: release workflow validation showed this is required for official VDO compatibility. During recovery renegotiation, VDO can send the answer over the already-bound data channel with the browser sender UUID while keeping the native peer's `default` session. Rejecting that payload breaks recovery even though the transport itself is scoped to the correct peer.

Expected invariant: WebSocket signaling must resolve by UUID/session and reject ambiguous empty-session messages. Data-channel signaling is already bound to one peer and may accept channel-scoped payloads or same-session payloads even when the payload UUID is the browser sender UUID.

Resolution: native preserves session-match acceptance on the bound data channel. Recovery validation separately proves that refresh offers receive later answers; focused signaling checks continue to cover the same-session data-channel acceptance rule without requiring WebSocket-style UUID matching on a bound channel.

### Finding Z: Data-Channel Peer Cleanup Did Not Remove The Peer

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO sends `{ bye: true }` when closing a peer, and the adjacent OBS plugin also classifies bound data-channel `request:"cleanup"` as peer cleanup. Native parsed those messages as ordinary JSON but had no complete peer-cleanup branch, so cleanup depended on a later data-channel close, PeerConnection close, or stale disconnected prune.

Why it matters: slot/director workflows are sensitive to stale peer sessions. Ignoring an explicit VDO peer-exit message leaves native state behind longer than the upstream lifecycle contract expects.

Expected invariant: data-channel `bye` or `request:"cleanup"` removes the bound peer session once, logs one removal reason, and shuts down the peer client asynchronously.

Resolution: native now handles `bye` and `request:"cleanup"` before other peer-control parsing. `bye` removes the session with reason `peer-bye`; `request:"cleanup"` removes the session with reason `peer-cleanup`. The release Control Center workflow sends both data-channel cleanup forms and requires the publisher cleanup logs.

### Finding AA: Data-Channel ICE Restart Was Missing

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO accepts data-channel `iceRestartRequest` from a bound viewer as transport recovery. Native handled WebSocket-side `iceRestartRequest` and privileged Control Center `refreshConnection`, but ignored the data-channel peer recovery message.

Why it matters: this is a peer recovery path, not a director UI mutation. Missing it can make an official VDO viewer ask for ICE recovery with no native response.

Expected invariant: data-channel `iceRestartRequest` on an existing peer session requests a keyframe, rebuilds the underlying PeerConnection inside that same session, and sends a recovery offer with fresh ICE credentials.

Resolution: native now maps data-channel `iceRestartRequest` to rebuild-based recovery with reason `datachannel-ice-restart`. The release Control Center workflow sends the message, requires a rebuild offer log, and requires a later answer log.

### Finding AB: WebSocket Cleanup Was Ignored

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO handles WebSocket `bye` and `request:"cleanup"` as peer cleanup messages. Native signaling parsed the message but had no branch or callback for cleanup, so a signaling-routed peer exit could leave the native PeerSession alive until a later data-channel/PeerConnection callback or stale prune removed it.

Why it matters: cleanup is part of the official signaling lifecycle, and room/slot workflows depend on stale peer state leaving promptly.

Expected invariant: WebSocket `bye` and `request:"cleanup"` resolve the target peer by UUID/session, remove exactly that current peer session, and log one removal reason.

Resolution: VdoSignaling now emits a peer-cleanup callback for WebSocket `bye` and `request:"cleanup"`. VersusApp resolves the matching peer under the existing peer-session lookup rules and removes it with reason `signaling-cleanup`. The release Control Center workflow sends WebSocket `bye` through VDO's `sendMsg` path and requires the publisher cleanup log.

### Finding AC: Pre-Peer WebSocket ICE Candidates Were Dropped

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO queues ICE candidates when they arrive before the matching peer connection object exists. Native WebSocket candidate handling resolved UUID/session against `peerSessions_` and dropped the candidate immediately if the PeerSession was not present yet.

Why it matters: room and Control Center flows can interleave signaling messages. Dropping a valid early remote candidate can force ICE failure/retry loops even though the browser sent the expected VDO message.

Expected invariant: WebSocket remote candidates with a UUID are retained briefly when the matching PeerSession does not exist yet, then applied only after the matching answer is accepted. Unidentifiable, expired, over-capacity, or ambiguous candidates must not be applied to a wrong peer.

Resolution: VersusApp now keeps a bounded pre-peer remote ICE queue keyed by UUID/session with a 15s TTL and 100-candidate cap, mirroring the official VDO limits. `applyPeerAnswer` drains queued candidates after `setRemoteDescription` succeeds, and peer/session cleanup clears matching pending state.

### Finding AD: WebSocket ICE Restart Replaced Peer Sessions

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO handles WebSocket `iceRestartRequest` as transport recovery on the existing peer connection. Native signaling routed the message through the same callback as `offerSDP`, which entered the PeerSession creation path and could erase/replace the existing peer for a recovery request.

Why it matters: a recovery request should not look like a viewer disconnecting and reconnecting. In room/slot workflows, replacing the peer can disturb stable slot assignment and make Control Center recovery look like slot churn.

Expected invariant: WebSocket `iceRestartRequest` resolves the current UUID/session, keeps that PeerSession, requests a keyframe, and sends a recovery offer with fresh native ICE state. If no current peer resolves, the message is logged and ignored.

Resolution: VdoSignaling now emits a distinct ICE-restart callback. VersusApp handles it by resolving the current peer under normal UUID/session rules and calling `sendPeerOffer` with reason `signaling-ice-restart`. The release Control Center workflow sends WebSocket `iceRestartRequest` through VDO's `sendMsg` path and requires the publisher recovery-offer and answer logs.

### Finding AE: Native Recovery Offers Were Not True ICE Recovery

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO handles peer recovery with browser `restartIce()` when available, or `createOffer({ iceRestart: true })` as the fallback. Native recovery paths had been sending another ordinary offer on the existing PeerConnection.

Why it matters: libdatachannel exposes custom local ICE credentials through `LocalDescriptionInit`, but its libjuice backend rejects `juice_set_local_ice_attributes` after candidate gathering has started. A simple credential-change offer would fail at runtime; a normal fresh offer can log and receive an answer without actually forcing fresh native ICE state.

Expected invariant: recovery requests keep the app-level peer identity stable but force fresh native ICE state. They must not remove/recreate the `PeerSession`, and they must not drop desired media tracks while rebuilding the transport.

Resolution: recovery-only offer paths now call `sendPeerOffer(..., rebuildPeerConnection=true)`. That path detaches callbacks from the old PeerConnection/DataChannel, rebuilds the underlying WebRTC transport inside the same `PeerSession`, restores desired video/audio/alpha tracks, and then sends the offer. Bootstrap and normal media-plan renegotiation continue to offer on the existing PeerConnection.

### Finding AF: Control Center Recovery Was Scoped To One Peer

Status: fixed in current working tree on 2026-06-29.

Impact: native handled authorized `refreshConnection` and `refreshAll` by rebuilding only the PeerSession that sent the control message. Official VDO.Ninja handles these controls as publisher-wide recovery by iterating every current `pcs` and `rpcs` peer connection.

Why it matters: in room, slot, or multi-viewer workflows, a director or remote-token API recovery request is intended to recover the publisher's active peer connections, not only the control sender's data-channel connection. Scoping the recovery to one peer leaves other stale or degraded peer sessions untouched and diverges from upstream VDO behavior.

Expected invariant: Control Center `refreshConnection` and `refreshAll` are authorized from the requesting control peer, but the recovery action snapshots all current native PeerSessions and rebuilds each underlying PeerConnection. Peer lifecycle recovery messages such as WebSocket/data-channel `iceRestartRequest` remain scoped to one resolved peer.

Resolution: native now logs the Control Center recovery fan-out, snapshots all current PeerSessions, requests keyframes, and calls rebuild-based `sendPeerOffer` for each peer. `refreshAll` still sends settings/device payloads only to the requesting control peer before the publisher-wide recovery begins. The release Control Center workflow validates the fan-out path in the one-peer case through the publisher log.

### Finding AG: `hangup` Was Misclassified As Unsupported

Status: fixed in current working tree on 2026-06-29.

Impact: native grouped official VDO `hangup: true` with unsupported browser-only controls and returned `rejected` even when the sender was a director or held the configured remote token.

Why it matters: official VDO and the adjacent OBS plugin both treat `hangup` as an endpoint/output stop command. Rejecting it makes Control Center stop/hangup actions appear to connect, send a valid VDO command, and then do nothing useful.

Expected invariant: authorized `hangup` stops the publisher endpoint; unauthorized `hangup` returns `rejected: "hangup"`; peer `bye` remains a separate peer-session cleanup command.

Resolution: native now handles `hangup` before the unsupported-control bucket, authorizes it with the existing director/remote-token guard, emits the normal stop event, and runs `stopLive`/`stopCapture`. The Control Center workflow includes an unauthorized guard for the VDO-shaped rejection branch.

### Finding AH: Signaling Parser Missed Official Room And Offer Aliases

Status: fixed in current working tree on 2026-06-29.

Impact: native signaling only recognized `request:"listing"` for room listings and `request:"offerSDP"` for publisher offer requests. The adjacent `ninja-plugin` reference map and signaling code document additional official/compatibility shapes: `request:"transferred"` and bare `listing` arrays for room state, plus `sendoffer`, `play`, and stream-id-bearing `joinroom` as offer-request aliases.

Why it matters: ignoring these aliases can leave native room state stale after transfer/admission flows or make a viewer/control surface ask for an offer with a valid VDO-compatible request name and receive no native response.

Expected invariant: `transferred`, `listing`, and bare `listing` array messages update room listing state; `offerSDP`, `sendoffer`, `play`, and `joinroom` with a stream id enter the offer-request callback; plain `joinroom` without a stream id remains room admission and does not create a PeerSession.

Resolution: VdoSignaling now normalizes inbound control-plane signaling into parsed message flags before dispatch. Focused VdoSignaling checks cover `transferred`, bare `listing`, all offer-request aliases, plain `joinroom` rejection, `cleanup`/`bye`, and string-form `iceRestartRequest`. The Release Control Center shipped-app workflow was also rerun after this parser change and passed on stream `codex_alias_942`.

### Finding AI: `requestAs` Routed Controls Were Applied As Direct Controls

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO.Ninja wraps some Control Center stats controls as `{ UUID, requestAs, targetBitrate }`, `{ UUID, requestAs, targetAudioBitrate }`, or `{ UUID, requestAs, requestResolution }`. Native did not handle the wrapper, so the same payload was parsed as an ordinary direct target-control message and could reconfigure the native global encoder even when `requestAs` named a different VDO stats/peer target.

Why it matters: `requestAs` is a routing instruction, not a harmless metadata field. Official `webrtc.js` validates the requester `UUID`, confirms `session.pcs[requestAs]` exists, checks director/remote authorization, applies only the routed target controls, and returns. Native has one publisher aggregate rather than a full browser peer graph, so accepting arbitrary `requestAs` targets violates that missing-target behavior.

Expected invariant: direct `targetBitrate`, `targetAudioBitrate`, and `requestResolution` remain normal peer controls. When those fields are wrapped with `requestAs`, native must first prove the target is its own aggregate publisher target and prove director/remote authorization. Unknown `requestAs` targets are ignored without mutating encoder/audio/resolution state.

Resolution: `VersusApp::handlePeerDataMessage` now treats `requestAs` plus target bitrate/audio/resolution as a routed-control guard. It requires a requester `UUID`, a `requestAs` target matching the native stream-id `remoteStats` key, and director or configured `remote` token authorization before the existing target-control parsing can run. The Release Control Center workflow sends a mismatched `requestAs` target and checks that no matching bitrate info or publisher reconfigure log appears, then sends a matching `requestAs` target and validates the normal target-bitrate state update. The shipped-app workflow passed on stream `codex_requestas_951483`.

### Finding AJ: VDO Stats Resolution Requests Were Treated As Literal Dimensions

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO.Ninja's stats/details resolution picker sends `session.requestResolution(currentUUID, 4096, selectedHeight, false, requestAsUuid)`, which becomes `{ requestResolution: { w: 4096, h: selectedHeight, s: false, c: false }, requestAs }`. Native parsed `w` and `h` as literal encoder dimensions, so choosing height `720` could request an ultra-wide `4096x720` output before clamp instead of an aspect-preserving 720p fit.

Why it matters: this directly matches the reported Control Center behavior where changing target resolution to 720 produced a max-width-by-height shape such as `3840x720`. In official VDO, the large width is a fit bound used to avoid width limiting; it is not intended as the actual output width.

Expected invariant: object-form `requestResolution` follows VDO sender-scale semantics. The native publisher resolves the requested bounds against the capture-source aspect, caps scale at 100%, and converts the resulting fit/cover scale into encoder geometry. Literal native geometry remains available only through string-form resolution and width/height action aliases.

Resolution: `VersusApp::applyRuntimeVideoControl` now accepts a VDO scale-resolution mode for object-form `requestResolution`. The resolver uses the latest captured frame dimensions when available, falls back to the HQ config, supports fit versus cover, and shares the existing even-dimension/clamp rules. The Control Center shipped-app workflow sends a stats-style `{w:4096,h:...,c:false}` request and validates the returned `info.width_url`/`height_url` against the aspect-preserving result.

### Finding AK: Unsupported `keyframeRate` Was Silently Ignored

Status: fixed in current working tree on 2026-06-29.

Impact: official VDO.Ninja accepts data-channel `keyframeRate` as a per-peer periodic keyframe/PLI cadence setting. Native does not implement a matching per-peer cadence owner; it only supports explicit keyframe requests, PLI/FIR callbacks, route keyframe gates, and global periodic keyframe forcing.

Why it matters: unsupported official VDO Control Center commands should not disappear silently. Control surfaces and API callers rely on VDO-shaped `rejected` responses to distinguish unsupported commands from dropped messages or transport failures.

Expected invariant: native must either implement official `keyframeRate` semantics with a real state owner, or reject the field explicitly through the same VDO `rejected` family used for other unsupported browser-only controls.

Resolution: `keyframeRate` is now in native's recognized unsupported-control bucket and returns `rejected: "keyframeRate"`. The Control Center shipped-app workflow includes a `keyframeRate` rejection check alongside other unsupported VDO browser controls.

Validation: local official VDO review confirmed `webrtc.js` stores `keyframeRate` on `session.pcs[UUID]` and schedules `session.forcePLI(UUID)`, so the behavior is per-peer browser transport state. Local `ninja-plugin` notes also classify `keyframeRate` as unsupported unless the native publisher implements that cadence. The shipped-app Control Center workflow passed on stream `codex_keyrate_704631`, including the new `keyframeRate` rejection, object-form VDO resolution scaling, bitrate/audio controls, requestAs routing, recovery offer/answer checks, fresh ICE credentials, data-channel and signaling ICE restart, and peer cleanup paths.

### Finding AL: Presence Controls And Extreme Numeric Payloads Needed VDO-Aligned Handling

Status: fixed in current working tree on 2026-07-01.

Impact: official VDO handles several recovery/control fields through field presence checks, not truthy checks. Native already had several of those flows, but false-valued payloads such as `{iceRestartRequest:false}`, `{refreshVideo:false}`, or `{refreshConnection:false}` could be ignored even though official VDO would enter the same branch. Separately, the signaling parser used direct `int` extraction for candidate `sdpMLineIndex` and boolean-like numeric fields, which meant an extreme JSON number could throw out of parser code instead of being treated as malformed or bounded input.

Why it matters: VDO.Ninja control and recovery messages may be generated by different browser paths, automation, or compatibility layers. A false-valued presence field is still an official branch selector in several cases, and SDP/candidate messages can contain hostile or merely oversized numeric fields. The native publisher should recover, reject, clamp, or ignore without destabilizing the transport callback.

Expected invariant: official presence-based controls remain presence-based; WebSocket `bye` remains truthy-or-cleanup based; per-peer optimized bitrate is not confused with global target bitrate; extreme numeric JSON cannot escape parser callbacks.

Resolution: native now treats data-channel `iceRestartRequest`, `hangup`, `refreshMicrophone`, `refreshVideo`, `requestVideoHack`, `refreshConnection`, and `refreshAll` as field-presence controls, and treats WebSocket `iceRestartRequest` the same way. `optimizedBitrate` is now a per-peer route/rate cap that supports zero route-disable and false/unlock behavior without reconfiguring the global encoder. App and signaling JSON numeric parsing now clamps oversized integer values and ignores non-finite floats through defaults; SDP/candidate string fields are read only when actually strings.

Validation: the Control Center shipped-app workflow passed on stream `codex_extreme_sdp_20260701b`, exercising false-valued `refreshVideo`, false-valued unauthorized `refreshConnection`, false-valued data-channel and signaling `iceRestartRequest`, `optimizedBitrate` apply/unlock, and an oversized VDO `requestResolution` clamp.

### Finding AM: Empty ICE Candidate Payloads Parsed As Valid Candidates

Status: fixed in current working tree on 2026-07-01.

Impact: a signaling payload with a `candidate` object but no actual candidate string, or a bundled `candidates` array containing empty/non-object entries, could still produce parsed candidate entries.

Why it matters: WebRTC expects an ICE candidate line. Treating an empty candidate object as valid can push bad input into the WebRtcClient path and make fuzz/stress failures harder to interpret.

Expected invariant: a candidate message is only valid when at least one non-empty ICE candidate line is present. Malformed entries in bundled candidate arrays are skipped, and the whole message is rejected if nothing valid remains.

Resolution: VdoSignaling now rejects singular empty candidate payloads and filters bundled candidate entries before dispatch. Focused parser torture checks cover empty candidate objects, mixed malformed/valid candidate bundles, malformed descriptions, invalid JSON, non-object payloads, and extreme `sdpMLineIndex` clamping.

## High-Level Review Checklist For Future Passes

Use this checklist before digging into line-level code.

- Does each new callback identify the state owner it mutates?
- Does every peer-session removal log one reason and one peer key?
- Does every media route decision require room init when room mode is active?
- Does a config change affect global state or per-peer state?
- Does a new control message match VDO's normal peer-control path, or is it a director/token-only action?
- If a target control includes `requestAs`, is it handled as VDO routed control instead of falling through as an ordinary direct control?
- If a data-channel message includes object-form `requestResolution`, is it resolved as VDO scale bounds instead of literal dimensions?
- If a native-only literal geometry path is needed, is it using string-form resolution or width/height aliases rather than overloading VDO's stats-picker shape?
- Does a new data-channel response reuse an upstream VDO message family, or is it explicitly documented as an `info` extension?
- Does a settings-panel request return `audioOptions`, `videoOptions`, and/or `mediaDevices`, rather than only callback completion?
- Is settings/device readback gated specifically by director identity before native sends option or device payloads?
- Does `requestVideoHack` require director status or a valid remote token before native encoder mutation?
- Does `requestVideoHack` preserve VDO's `ctrl` width/height semantics instead of reusing generic partial-resolution behavior?
- Does a combined data-channel control message emit status only after all supported mutations in that message are applied?
- Do Control Center recovery messages trigger a real recovery transition rather than only a callback echo?
- Does recovery validation prove the rebuilt transport produced fresh ICE credentials and received an answer, not just that old media kept flowing?
- Do Control Center `refreshConnection` and `refreshAll` fan out across all current publisher peers, while WebSocket/data-channel `iceRestartRequest` stays scoped to the resolved/bound peer?
- Do peer lifecycle/recovery messages (`bye`, `request:"cleanup"`, `iceRestartRequest`) mutate the peer session exactly once, keep ICE restart on the existing peer, and stay separate from privileged Control Center recovery?
- Does `hangup` stop the publisher endpoint only after director/remote-token authorization, while remaining separate from peer `bye` cleanup?
- Does the code preserve VDO's director-only vs remote-token-exception split instead of using one broad privileged-control guard?
- Do remote-token control paths use VDO's `remote` field instead of accepting native-only aliases?
- Do denied privileged controls return VDO-shaped `rejected` messages when official VDO does?
- Do unsupported browser-only controls return VDO-shaped `rejected` messages instead of being silently ignored?
- Does renegotiation wait for an answer?
- Does applying an answer mutate peer-session state only after WebRTC accepts it?
- Do WebSocket ICE candidates have a safe bounded path when they arrive before PeerSession creation?
- Does data-channel signaling preserve VDO's scoped same-session answer path, while keeping WebSocket peer lookup unambiguous?
- Does any new track imply a keyframe?
- Does a transform apply equally to HQ, LQ, and alpha output?
- Can reconnect reuse stable UUID/session identity?
- Can logs leak password, room secret, or share URL password query values?
- Does a Release-binary E2E viewer open only after the publisher has emitted its VDO view URL/readiness signal, especially when an experimental codec first falls back to H.264?

## Source Anchors

Use these anchors when refreshing the map:
- App orchestration: `native-qt/src/app/versus_app.cpp`
- App state model: `native-qt/include/versus/app/versus_app.h`
- Signaling transport: `native-qt/src/signaling/vdo_signaling.cpp`
- WebRTC peer/track wrapper: `native-qt/src/webrtc/webrtc_client.cpp`
- Route policy: `native-qt/src/app/dual_stream_policy.cpp`
- Video encoding and transforms: `native-qt/src/video/video_encoder.cpp`
- Shared aspect-fit geometry: `native-qt/include/versus/video/aspect_fit.h`
- Audio capture/encoding: `native-qt/src/audio/*`
- Firewall warning: `native-qt/src/ui/main_window.cpp`
- Installer firewall rule: `native-qt/installer.nsi`
- Release Control Center workflow: `native-qt/e2e/control-e2e.js`
- Release direct-view workflow: `native-qt/e2e/stream-e2e.js`
- Diagnostics export: `VersusApp::buildDiagnosticsJson`, `VersusApp::writeDiagnosticsJson`, and `--diagnostics-out` in `native-qt/src/main.cpp`
- Official VDO reference, read only: `C:\Users\steve\Code\vdoninja\main.js`, `C:\Users\steve\Code\vdoninja\webrtc.js`, `C:\Users\steve\Code\vdoninja\lib.js`
- Adjacent OBS plugin VDO reference, read only: `C:\Users\steve\Code\ninja-plugin\docs\vdoninja-workflow-map.md`, `C:\Users\steve\Code\ninja-plugin\src\vdoninja-output.cpp`
