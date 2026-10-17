# Mac 0.2.64 Beta 2 qualification — October 17, 2026

The current [macOS 0.2.64 Beta 2](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.64-beta.2) remains **experimental**. Windows v0.2.64 remains the stable production release. This record identifies the new artifact separately from the [earlier qualification history](macos-beta-validation-2026-10-16.md).

## Candidate and behavior change

Runtime revision `1eefab24dbb03fa6bbe8caac30e2133865e71484`; Developer ID signed executable SHA-256 `2c1bfb2bc873c4c2c998034ec7ed5a311c2d0c3b99dd0d203305fef5ded1fad3`. The full application was rebuilt from that Git revision. Apple notarization, stapling, bundle/signature verification and Gatekeeper assessment passed as distribution gates.

A room guest whose libdatachannel transport reaches terminal `Closed` is removed promptly when no transport replacement is pending. Previously, this terminal state could occupy a logical guest slot for the entire 90-second recovery timeout if the final BYE was not processed. Transient `Disconnected` handling retains its recovery policy. Existing transport-generation guards protect replacement connections.

This changes internal native lifecycle handling. It adds no VDO.Ninja wire call, BYE acknowledgement, relay or browser-close delay. The candidate also includes the preceding removal of unsupported `leave` and `unpublish` sends. The [protocol review](vdoninja-protocol-compatibility.md) identifies the existing VDO.Ninja source paths.

The workflow scripts are on [`macos-production-readiness`](https://github.com/steveseguin/game-capture/tree/macos-production-readiness); each report retains the actual harness copies and hashes. Run them against the signed packaged app, with owned fixture devices and a fresh report directory. The room harness supports `--drop-guest-bye=true --expect-closed-guest-cleanup=true` for the lost-BYE scenario, and separately `--guest-refresh=true --fuzz-seed=20261019 --fuzz-steps=8 --fuzz-local-control=true` for refresh and randomized controls. BYE suppression and randomized fuzz are separate scenarios. The download-launch harness supports `--replace-with-delivery` for different beta binaries with the same app version and `--settings-profile` for the private GUI preferences below.

## Completed packaged application testing

All results below identify this exact signed executable. Publisher and browser receivers ran on one Apple M1 with macOS 26.4.1; virtual devices and controlled fixtures do not establish physical-device or independent-machine coverage.

| Workflow | Result and scope |
| --- | --- |
| Deliberately lost guest BYE | Both encoders passed the complete workflow. Eight publisher-directed BYEs were suppressed; the corresponding native guest owners were removed with `closed-room-guest` in 76–329 ms. |
| Signaling outage and recovery | Both encoders passed. Existing viewers continued receiving, signaling returned, explicit guest departure and abrupt tab closure completed, then subsequent controls and shutdown passed. Abrupt-tab transport detection took about 17 seconds; it is not a subsecond cleanup claim. |
| Public WHIP relay | Both encoders passed against `whip.vdo.ninja`, including validated relay routing, decoded video/stereo and receiver reconnection. |
| Audio-input recovery | Both encoders passed controlled aggregate-device removal, missing-device startup and restored startup. Physical devices were not unplugged. |
| Window-source recovery | Both encoders passed owned-window loss/reselection and window transitions. |
| Fifteen-minute four-viewer room | Both encoders passed all ninety intervals, continuous received PCM monitoring, subsequent controls/rejoin and shutdown. Three 720p30 scene receivers and one 360p30 preview shared the publisher Mac. |
| Existing guest refresh and seeded controls | Both encoders passed the existing `refreshConnection` path, retaining the logical guest owner across transport replacement, then eight randomized controls each and 256 total local HTTP requests (224 expected rejections, 32 health successes). |
| GUI lifecycle | Both encoders passed two Go Live → Stop Live cycles with decoded output and clean shutdown. |
| Saved WHIP credential migration | Beta 1 saved a private Keychain profile; Beta 2 reused its unchanged reference without endpoint/token re-entry. VT and x264 passed authenticated publication, decoded video/stereo, static/silence/resumption, late reception, local server restart/recovery, shutdown and owned-profile deletion. |
| Beta artifact replacement | Beta 1 → Beta 2 passed through Launch Services with both identities verified and seven private GUI preferences retained. Core app version remains 0.2.64. |
| Published download and launch | Installed Chrome downloaded the published ZIP with its original quarantine. Normal macOS Open handling, App Translocation, GUI launch/relaunch, same-artifact replacement, private preferences and capture-off behavior passed. |
| 1080p60 moving detail | Both encoders passed the earlier two-minute workflows. In a new five-minute run per encoder, VT passed all 30 intervals; x264 failed cadence in 2/30 intervals. Both completed the subsequent functional controls and audio checks. See the extended workload below. |

The earlier two-minute 1080p60 passes do not resolve the historical failures. The extended run below reproduces a cadence failure with current Beta 2 x264; VT passes its five-minute workload. Neither establishes independent-receiver performance. The natural missing-BYE delivery cause also remains unproven; the native stale-session symptom now has direct lost-BYE coverage.

## Failed attempts retained

The first refresh attempt selected the wrong scene DOM video after refresh reordered its children. Saved pixels showed the fixture guest ahead of the intended native publisher. The observer now resolves the publisher UUID explicitly. A second attempt failed because a newly added checkpoint helper was scoped only inside the fuzz block; its evidence write is now direct. These attempts remain failed. The corrected replay passed both complete encoder workflows; the original failures are retained.

The initial source-package gate rejected a sparse checkout before archive creation. The frozen source checkout was expanded and the retry passed, followed by matching-source/download packaging and release asset checksum verification. Packaging is a distribution gate, not application testing.

## Still required before production

- A new packaged Windows build from the integrated source, followed by actual Windows capture, encoder, room, recovery and output workflows. The existing stable Windows 0.2.64 artifact does not qualify these shared changes. The repository's Windows workflow needs a prepared self-hosted runner; none was registered when checked.
- Fresh-machine and minimum macOS 14.2 installation/permission flows, plus another Apple Silicon Mac. Existing-machine quarantine and replacement workflows cannot substitute for these.
- Physical camera/microphone hotplug and busy-device recovery, permission denial/revocation, sleep/wake, display changes and audio-route changes in a coordinated session.
- Longer representative gameplay and an independent receiver machine/network, including isolation of the current x264 1080p60 cadence failure under high host load. Replacement now covers the advanced toggle plus stream ID, room, label, viewer limit, audio gain and limiter state in private preferences. A saved WHIP endpoint/token now also passes Beta 1 → Beta 2 reuse with both encoders; other destination profiles/credentials and broader receiver coverage remain open.
- A trusted remote RTMPS endpoint and the intended production services. Public WHIP relay success is separate evidence and does not qualify RTMPS.

The stable Windows release must remain unchanged. Keep the Mac release explicitly experimental until these workflows are completed and any failures are resolved.

## Five-minute 1080p60 workload — October 17 follow-up

The unchanged signed Beta 2 executable was run sequentially with VT and x264, each for 300 seconds at requested H.264 1920×1080/60 and 8 Mbps. The source was the existing moving-tile browser fixture with selected-application stereo audio. The native captured window measured **1920×930**, aspect-fitted into the 1920×1080 output; this is not full-height 1080p source-capture coverage. Source and receiver used Chromium 145.0.7632.6 on the same M1. A thirty-second host baseline and five-second process snapshots were retained; the existing remote-desktop session remained active.

| Encoder | Complete workload | Cadence intervals | Received fps range | Continuous 100 ms audio windows | Sampled publisher RSS |
| --- | --- | --- | --- | --- | --- |
| VideoToolbox | Passed | 30/30 passed | 59.799–60.098 | 3,038, all passed | 144.1–156.0 MiB |
| x264 | **Failed sustained cadence**; functional controls passed | 28/30 passed | 56.590–59.996 | 3,059, all passed | 178.6–194.4 MiB |

x264 failed the 240–250 and 250–260-second intervals against the unchanged 95% delivery target. In the first failed interval, source cadence was 59.990 fps and received cadence 56.590 fps (94.33% delivery). Publisher dropped frames rose from 104 to 135; capture increased by 605 frames and sent frames by 577. Receiver decoding advanced by 574 frames with zero decoder-reported drops. Encoder failures, timeouts and send failures stayed zero; continuous PCM passed. Host CPU was approximately 93% at both interval boundaries. Over the run, host CPU samples ranged from 76.6–97.1%, versus 38.3–73.2% during the preceding VT run. Late x264 process snapshots also show substantial remote-desktop CPU usage. Those measurements establish contention, not its sole cause or a matched CPU-efficiency comparison.

Both workflows subsequently passed live FPS controls, static/silent/resumed content, resizing and late-viewer video/audio. VT quit normally. The x264 workflow deliberately closed its owned source and correctly reported capture failure with app exit 3; the workflow's overall failure is the cadence result, not that expected source-loss exit. This extends current-artifact VT evidence and reproduces the unresolved x264 performance concern; it does not erase older failures, qualify demanding gameplay/thermal endurance, measure A/V synchronization, or establish an independent-machine receiver result. No runtime source or release binary changed.

Raw interval hashes, decoded identity counts, source/received cadence, acceptance decisions and continuous PCM decisions were recomputed separately as evidence gates. The 60 intervals retain their original observations. Reports: `macos-beta2-1080-extended/c7e83e55-c6f7-4052-aabf-ffa1c06ec3ff` (VT) and `macos-beta2-1080-extended/1ad5a9fc-a95b-402e-a31b-8ed295fd7abb` (x264). Queue, exact command arguments, host observations and additive evidence freeze: `macos-beta2-1080-extended-queue/2cea6b86-726e-47f9-ae8e-ff4cd014fd77/final-manifest.json`, SHA-256 `a92a0f2dbac88e8db3f51e5e703896bd4560d9b55b704521bc558276a5f482d4`.

## Saved WHIP profile follow-up

The source artifact for profile creation was signed Beta 1 (`cb01f0ef684975158d592593f9b5116e5a850c83891d7b84f88a525fabd336a9`); publication after relaunch used signed Beta 2 (`2c1bfb2bc873c4c2c998034ec7ed5a311c2d0c3b99dd0d203305fef5ded1fad3`). Both deep signatures verified before execution. The workflow uses two retained bundle locations with one private settings directory: it establishes credential reuse across binaries, not an Applications-folder replacement, fresh-machine Keychain access, or a new quarantine flow.

The saved settings contained an opaque Keychain reference and no plaintext endpoint/token. Beta 2 retained that reference and authenticated successfully without credential arguments or re-entry. Both encoders delivered moving H.264 and stereo Opus, static/silent/resumed content, late-viewer media, and media after a local MediaMTX restart. VT delivered 177 distinct source identities in its initial six-second observation, x264 174. These are short functional observations, not performance benchmarks. Both temporary Keychain items were deleted during owned-resource cleanup. Raw settings, endpoints and control credentials stay local.

The VT workflow used the default encoder choice and verified actual VT hardware; the subsequent x264 workflow explicitly selected software in the GUI and verified software output. Native accessibility actions operated the actual controls. An initial attempt stopped before profile creation because the previous mouse-click action required foreground focus; it remains failed. Switching menu/source selection to native accessibility actions fixed that harness limitation, without changing the app or media acceptance criteria.

The [WHIP harness](https://github.com/steveseguin/game-capture/blob/macos-production-readiness/native-qt/e2e/macos-whip-publish.js) accepts `--gui=true --relaunch-app="/path/to/new/Game Capture.app"` alongside its existing old `--app`, fixture/server/helper and report arguments. Use `--gui-encoder=x264` for the software run; default is `videotoolbox`. Keep the two bundle identities explicit and use fresh private reports. This adds coverage for one WHIP profile; other protocol credentials, Keychain denial/locking and physical devices remain open.

Evidence: `macos-keychain-beta-migration/07c47449-68d4-48a3-8d11-b2920d61b420` (VT), `macos-keychain-beta-migration/4cd3e367-9ad2-4db1-93ee-ac7691eb3aab` (x264), and failed initial attempt `macos-keychain-beta-migration/9c7648cf-93d9-42de-b861-ffccfeacda03`. Their new local freeze is `macos-keychain-migration-evidence/16c287e7-e419-41f6-83e1-2b36d9fff4f7/manifest.json`; prior frozen evidence is unchanged.

## Retained media measurements

| Workload | Encoder | Received fps range | Continuous 100 ms audio windows |
| --- | --- | --- | --- |
| 2-minute 1080p60 | videotoolbox | 59.689–59.996 | 1,218 |
| 2-minute 1080p60 | x264 | 58.388–59.995 | 1,223 |
| 15-minute room | videotoolbox | 29.878–30.100 | 37,920 |
| 15-minute room | x264 | 29.894–30.099 | 37,980 |

Retained compressed interval hashes, decoded-content summaries and PCM decisions were verified separately as evidence gates. PCM coverage does not measure physical playback or calibrated A/V synchronization.

## Evidence identifiers

Raw logs and recordings remain local; report identifiers are provided for traceability.

- `macos-terminal-guest-cleanup/335e1045-27e4-48fc-aa54-feb5c24c2146`
- `macos-followup-signaling-recovery/031ca16b-43f3-4ca4-afae-4cb2acd71018`
- `macos-followup-public-whip/3d25e95d-ed5c-4e24-b03a-a2a5a6ae740a`
- `macos-followup-audio-input/481ead03-3f31-4702-bcf6-04bc44becb16`
- `macos-followup-source-recovery/74d62b31-fddc-4a51-af10-64ed37b05e37`
- `macos-followup-source-recovery/bd9346bd-60cb-4b36-beb2-1a5621f7ee70`
- `macos-followup-1080p60/0b0171c4-fc40-4f3e-ad62-f9acd811b916`
- `macos-followup-1080p60/d30e4245-d5bf-4ccd-869b-23adf6f0ed2e`
- `macos-followup-room-endurance/ddc5d1d3-1de4-4684-bd54-db52d4e3bfdb`
- `macos-followup-gui-lifecycle/5063bda9-6393-4a3a-9176-47e7bdacc3d7`
- `macos-followup-guest-refresh-corrected/bab521df-1ab5-4eb7-af7e-ddae89584543`
- `macos-followup-beta-replacement/212c15d9-5137-479f-9e57-b30ebb010ee4`
- `macos-beta2-quarantine-launch/7fe7bf3e-1576-4092-9d19-ed8189c252c1`
- `macos-beta2-publication/0477d054-519c-427c-805b-9f32b8dce9ad`
