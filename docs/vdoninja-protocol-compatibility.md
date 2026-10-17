# VDO.Ninja protocol compatibility review — October 17, 2026

Game Capture must use existing VDO.Ninja messages, fields, transport routes and authorization behavior. Do not add a new VDO.Ninja API to work around a native lifecycle problem. Before adding a wire message, identify its sender and receiver in VDO.Ninja source. A JavaScript helper name or iframe API name is not automatically a peer-protocol field.

Reference checkout: `/Users/steveseguin/Code/obsninja`, clean revision `8ca1506a29fcfb5b0dbd009731e63fe77abb6302`. Reviewed the root `webrtc.js`, `lib.js`, `main.js` and `hss/gemini.js`; no files in that checkout were changed. These source references do not assert that every remotely cached hosted page has identical bytes.

## What bye actually does

1. `lib.js:22248` defines `session.hangup()`. It broadcasts `{videoMuted:true, bye:true}` to peers receiving its publication through `session.sendMessage()`, closes its signaling socket, then closes its receiving and publishing peer connections (`lib.js:22336` onward).
2. `webrtc.js:11641` defines `session.closeRPC()`. In the ordinary path, `webrtc.js:11768` explicitly requires keeping BYE on the established peer path, without a WebSocket relay. It sends `{bye:true}` using `session.sendRequest()` and then calls the peer's `close()`.
3. `session.sendRequest()` (`webrtc.js:11036`) writes to the receiving peer's `receiveChannel`. `session.sendMessage()` (`webrtc.js:8416`) writes to publishing peers' `sendChannel`. Both are peer data-channel paths; neither helper provides an automatic WebSocket fallback.
4. `session.closePC()` (`webrtc.js:11485`) similarly sends `{bye:true}` using `sendMessage()` before closing the publishing connection.
5. The peer receivers handle `bye` in `processRPCSOnMessage` (`webrtc.js:8605`) and `processPCSOnMessage` (`webrtc.js:12787`), closing the corresponding peer. Their `bye` branches return immediately. The existing generic `cbid` facility is not a BYE acknowledgement protocol.
6. The WebSocket receiver also recognizes `msg.bye` and `request:"cleanup"` (`webrtc.js:8326`) and looks up the UUID. This existing inbound server-cleanup behavior does not authorize inventing an outbound WebSocket BYE relay for an established peer.

`hangup` is a separate existing control request with authorization checks (`webrtc.js:13203`). It must not be substituted for a departing peer's `bye`.

The existing source does **not** wait for an acknowledgement or a drain promise between sending BYE and closing the peer. A browser `send()` return, or `bufferedAmount` reaching zero, does not establish native application receipt. The trace showing a send and a close request in the same millisecond is consistent with this implementation; it does not alone establish where the intermittent loss occurs.

## Message map used by the Mac workflows

| Purpose | Existing VDO.Ninja path / shape | Reference in this checkout |
| --- | --- | --- |
| Room/publisher registration | `request:"joinroom"`, `request:"seed"` over signaling | `webrtc.js:6519`, `webrtc.js:4169` |
| Guest departure | `{bye:true}` through `sendRequest()` | `webrtc.js:11768` |
| Publisher departure | `{bye:true}` through `sendMessage()` | `webrtc.js:11552` |
| Keyframe request | `session.requestKeyframe(UUID)` sends `{keyframe:true, scene:false}` | `webrtc.js:3181`, receiver at `13542` |
| Bitrate target | `{targetBitrate: number}` through the established request path | `lib.js:16895`, `webrtc.js:13196` |
| Remote authorization | Existing `remote` field; valid/invalid token scenarios use that field | `webrtc.js:3110`, `13640` |
| Preview media controls | Hosted director controls; existing `audio`/`video`, `volume`/`remoteVideoMuted` fields | `webrtc.js:14555`, `14628`, `15066`; role/media initialization around `23475` |
| Audio target and live video settings | `targetAudioBitrate`, `requestVideoHack` with existing setting names | `webrtc.js:13199`, `13700`–`14175` |
| Resolution | `session.requestResolution()` / existing `requestResolution` message | `webrtc.js:4589` |
| Recovery | Existing `iceRestartRequest`, `refreshConnection`, `refreshAll`, `reconnectPeer` controls | `webrtc.js:8338`, `12792`, `14176`, `14200`, `14239` |
| Stats and diagnostics | Existing `requestStats`, `requestStatsContinuous`, `info`, `miniInfo`, `remoteStats`, `getConnectionMap` / `connectionMap` envelopes | `webrtc.js:13224`, `13316`, `8765`, `14258` |
| Device/settings requests | `getAudioSettings`, `getVideoSettings`, `changeCamera`, `refreshVideo` | `webrtc.js:14145`, `14152`, `14527`, `14848` |
| Liveness | Existing `ping` / `pong` data-channel messages | `webrtc.js:8611`, `12771`, `15827`, `23259` |
| Device/settings responses | Existing `audioOptions`, `videoOptions`, `mediaDevices`, `mediaDeviceChange`, `rejected` envelopes | `webrtc.js:8656`, `9094`, `9100`, `9193` |

Native-specific observations inside existing `info`/diagnostics data are not new VDO.Ninja control calls. Game Capture's loopback HTTP `/commands` and `/diagnostics` are its own local API. The malformed HTTP fuzz corpus is sent only there, not to the VDO.Ninja signaling service or peer protocol.

## Corrections and boundaries

- Removed the unused native `VdoSignaling::leaveRoom()` declaration and implementation, which sent `{leave:true}`. No matching sender was found in the reviewed VDO.Ninja source, and no application/test caller existed. Normal shutdown continues through the existing disconnect path. This change is in source; it does not replace the published beta.
- Removed the active `{unpublish:true}` send and its native helper. `stopLive()` now uses its existing `disconnect()` and peer cleanup directly. VDO.Ninja closes the socket on hangup; HSS `cleanupClient()` removes the publication through its internal `unpublishClientStream()` (`hss/gemini.js:557`–`570`; socket-close handler at `1413`–`1414`). That server helper name is not an outbound API. No `unpublish` wire handler was found. This is a runtime source change requiring a rebuilt-app replay.
- Removed the extra `lock:true` field from the Mac unauthorized-bitrate scenario. `requestRateLimit(..., lock)` changes local `lockedVideoBitrate` state (`webrtc.js:3216`); the helper sends `bitrate`/`audioBitrate`, not a `lock` wire property. The scenario still checks rejection of the existing `targetBitrate` request.
- No BYE acknowledgement, retry message, replacement disconnect command, server extension or WebSocket shortcut was introduced. No browser close delay was introduced.
- The native receiver already accepts some extra compatibility aliases such as a `requestKeyframe` field, `getStats` and generic `action` names. These are **not established as VDO.Ninja peer messages by this review**, are not emitted by the reviewed native sender paths, and are not used by the current Mac room workflow. Do not cite helper/iframe names as evidence for such wire aliases. Removing legacy incoming aliases would require a separate compatibility/regression decision.
- The 15-second prompt-cleanup assertion is a Game Capture QA target, not a VDO.Ninja timeout contract. The 90-second native disconnected-session retention is an internal recovery policy, not a VDO.Ninja API. Neither threshold was changed to hide a failed observation.

The natural x264 failure in `macos-beta-seeded-room-fuzz/ed3e1353-baa7-467e-a884-5a829959d9fc` remains open: browser BYE send returned, channel close followed 11 ms later, no processed-BYE native log was recorded, and fallback removed the guest after 90,123 ms. Other viewers continued playing. This review narrows the relevant path; it does not prove a runtime fix or production readiness.

## Validation

The initial unused-helper removal passed compilation gates in both affected C++ translation units (`macos-protocol-compile-gate/1f44039e-24cd-4276-9e9c-8d8a5596f011`). This is not application testing of a rebuilt executable. The removed method had no callers. Windows packaged regression and qualification of any future rebuilt release remain required.

The corrected Mac room harness passed its full x264 room workflow in `macos-beta-protocol-replay/a5ac7a7e-fcdd-40a7-af79-1245172f8427`, including eight randomized actions, 112 malformed/unauthorized local-control rejections and 16 successful health requests, against the unchanged signed 0.2.64 Beta 1 executable, SHA-256 `cb01f0ef684975158d592593f9b5116e5a850c83891d7b84f88a525fabd336a9`. That result covers the harness correction and the existing beta, not the new shutdown source change. A separate, unpublished candidate rebuilt all 39 application translation units from revision `987b07d675742504cebc4a79f6e95598217a4547`. Its Developer ID signed executable is SHA-256 `5d117a4cd25ad28bec4ab7499d578f44fcf5770c47be6250059c58d69bd162b0`. Build, signature and bundle audit passed as gates; this candidate has not been notarized or released.

Actual candidate application testing: `macos-protocol-candidate-room/b4516dc3-08b7-4809-98d4-d84486fd6b4f` passed the full hosted room workflow for both VideoToolbox and x264. Each encoder completed eight randomized controls plus 128 local-control requests (112 expected rejections, 16 health requests), verified decoded preview/scene video and stereo audio, guest departures, resize/bitrate/mute/keyframe controls, late scene reception and clean shutdown. All eight observed guest departures cleaned up in 267–323 ms. This does not resolve the preserved intermittent failure on the published beta.

The same signed candidate also passed two real GUI Go Live → Stop Live cycles per encoder in `macos-protocol-candidate-gui/4dc8d112-0714-4968-9b68-a5e885b8d8ee`. Each restart delivered decoded moving 960×540 video; each stop stopped capture/output and restored Go Live in the same application process. These four cycles specifically exercise the changed shutdown path. Windows packaged regression remains outstanding.

## Evidence and storage

The published-beta fuzz batch is frozen in `macos-fuzz-readiness-artifact/3b6335d5-408a-4e86-8f2f-5a4990712ce1/manifest.json`, SHA-256 `10ffb314ab160b278a4f306ae4f75606962e6cb69b11f8b6bfcdba068eeecc3f`. Its four completed cases span both encoders and seeds 20261017/20261018, with 32 randomized actions and 512 local requests. The original harness failure, natural guest-cleanup failure and ENOSPC-interrupted run are retained separately and are not counted as successful complete workflows.

Disk cleanup removed regenerable cache contents and shared byte-identical dependency/build-bundle files using APFS copy-on-write, preserving paths, contents and metadata. It reclaimed about 2.5 GiB; prior release artifacts and evidence reports were retained. Storage records: `macos-protocol-review-storage/9b23ab7f-3e84-46cc-aeae-71ec5fd4db50` and `macos-build-storage-sharing/b7a6f69d-b07d-4786-9487-df1a69077a0a`.
