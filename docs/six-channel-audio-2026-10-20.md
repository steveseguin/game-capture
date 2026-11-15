# Six-channel audio candidate, 2026-10-20

This is an unreleased Windows Game Capture change. It adds a six-channel mode to the existing audio encoding controls and `--audio-channels=6` to headless publishing. Stereo remains the default. Physical six-channel input validation is still required before calling the feature ready for release.

## Behavior

- Endpoint and microphone capture preserve the first six device channel slots, resampled to 48 kHz. Missing slots are silent; mono fills the first two slots. Inputs with more than six channels use their first six. This mode does not create six independent recording tracks.
- Selected-window capture requests six-channel PCM from Windows process loopback. Windows can mix audio down before capture if the playback endpoint is stereo; requesting six channels cannot recover information already mixed away.
- Six-channel Opus uses four streams, two coupled streams, and mapping `0,4,1,2,3,5`. The encoder and receiver use the same mapping to retain device slot order. The encoder does not impose an LFE low-pass filter.
- A receiver that negotiates six-channel `multiopus` gets six channels. A receiver that negotiates ordinary Opus gets a separately encoded stereo mix, concurrently. Stereo fallback retains front L/R at unity, adds center/back channels at -3 dB and the fourth slot at -6 dB, and applies the selected limiter.
- Native receivers can select the explicitly offered payload 112. VDO.Ninja's existing `stereo=4` answer rewrites payload 111; the sender accepts that only in six-channel mode with the matching multistream configuration. Unsupported configurations are not sent multichannel packets.
- The generated VDO.Ninja viewer link uses `stereo=4`. Use `stereo=1` for a stereo receiver. `stereo=8` requests eight-channel playback and is not this feature. See the [VDO.Ninja stereo documentation](https://docs.vdo.ninja/advanced-settings/audio-parameters/stereo).
- Try 384 kbps for six-channel music; the bitrate setting is the total across channels. Experimental RTP PCM is unavailable in six-channel mode, and RED is disabled for it; the GUI greys out PCM and RED, and an explicit `--audio-red` is rejected. Existing mono/stereo PCM and RED behavior is retained.
- WHIP carries each packet's actual channel count so its negotiated stereo fallback remains possible. Packaged publishing to local MediaMTX and Chrome WHEP now preserves all six speech-range tones, both as six isolated channels and in stereo when an endpoint fixture restricts negotiation to ordinary Opus. Other WHIP services require their own acceptance results.
- FFmpeg output receives six-channel PCM for AAC encoding. The measured SRT/AAC path produces a 5.1 layout and loses slot 4's speech-range tone, even though the destination accepts six AAC channels and the recording decodes. Do not treat this as six independently preserved full-band inputs; correcting that behavior requires a separate compatibility review.

Example (alongside the usual source and stream arguments):

```text
--audio-channels=6 --audio-bitrate-kbps=384 --no-audio-red
```

## Recording tracks in Desktop Studio

Desktop Studio already supports the program mix plus up to 16 separate source audio tracks in one MKV. Its Record dialog selects those sources. No new implementation was needed to exceed six recording tracks.

The existing packaged application was run for 30 seconds with 16 distinct tone sources, recording all 16 plus the program mix. Every stream decoded successfully. Frequency analysis of all 16 separate tracks verified each source in its own track; the largest other-source amplitude was 0.046% of the intended source. This verifies independent recorded streams, separately from multichannel input. Importing, editing and exporting them in the intended editor remains a separate acceptance requirement.

On November 14, three recording/export cycles in one packaged app instance also passed: 7 sources, 16 sources, then 7 in reversed order, each plus Program. MP4 export preserved all audio streams, source names and ordering, with identical encoded AAC content per track. Existing-file recording/export requests were rejected without changing the files. A separate GUI journey added seven files, selected and saved the seven source tracks, recorded and exported using the menus. Both files retained all eight names and isolated source content. See the [acceptance record](multichannel-acceptance.md) for the retained outputs and measurements.

Package SHA-256: `4873f5feeb76451ce233c0950a96a3924efbb5418a733dead2bf80b98eac6a77`.

Local evidence in the sibling video-mixer checkout:

- `native-qt/qa/reports/six-channel-request-recording-capacity/recording-capacity.json`
- `native-qt/qa/reports/six-channel-request-recording-capacity/track-isolation.json`
- `native-qt/qa/reports/six-channel-request-recording-capacity/sixteen-tracks.mkv`

## Game Capture validation

Build and unit gates are not application testing. The converter gate passed 26 cases with one opt-in physical-device case skipped; the Opus gate passed 18 cases, including independent decoding of each of the six slots. The converter check covers channel identity and chunk-boundary continuity at 44.1, 48, and 96 kHz.

Packaged application workflows use `native-qt/e2e/six-channel-packaged-e2e.js`. They retain executable hashes, SDP, decoded frequency matrices and receiver statistics in their report directories. Measurements use Chrome's raw `MediaStreamTrackProcessor` audio, because the tested Web Audio playback path downmixed the six-channel track to stereo.

Candidate executable SHA-256: `11927f93c68d6f83b049cef306dcf4cc3ddc574f82243d244e3b13744f33370c`.

- Real Windows process playback/capture with this machine's stereo endpoint: Chrome received six-channel Opus, with real endpoint audio in the first two slots and silence in the remaining four; a simultaneous stereo receiver received an audible mix. This validates actual capture and playback, not independent six-channel physical input.
- Instrumented packaged application: a fixture replaces only its Windows six-channel capture buffer with six distinct tones. Real application resampling, mixing, Opus encoding, WebRTC transport and Chrome decoding preserve all six channel identities while serving a stereo receiver. Both VDO.Ninja's payload-111 answer style and explicit native payload 112 passed. This is a synthetic input-boundary check, not physical-device testing.
- Hosted VDO.Ninja viewer workflow: the instrumented publisher's generated `stereo=4` link delivered all six isolated tones in Chrome through the actual unmodified VDO.Ninja page. A simultaneous `stereo=1` viewer received the stereo mix. A final run also verified clean publisher exit with the instrumentation attached. No VDO.Ninja source change was necessary.
- Existing packaged mono/stereo regression: all eight receiver cases passed, covering PCM and RED in mono and stereo, each alongside its simultaneous ordinary Opus fallback. These workflows used real Windows playback/capture and the hosted VDO.Ninja viewer.

- Packaged GUI workflow, 2026-10-22 (review package SHA-256 `cbd6d1dc334ca7bfbb44263fa0eced5937e6a9f0872926c2375e6b42ea320dff`): `native-qt/e2e/six-channel-desktop-e2e.py` starts from saved stereo PCM and selects **6 channels (experimental)**. The codec switched to Opus, PCM could not be reselected, RED was disabled, the selection and 384 kbps survived a restart, returning to stereo re-enabled PCM and RED, and a hosted VDO.Ninja stream locked the controls, reported six output channels, generated a `stereo=4` share link, and stopped cleanly. The same package rejected `--audio-channels=6` combined with `--audio-red` or `--audio-codec=pcm` (exit code 2) and passed the synthetic six-channel receiver workflow with local signaling again.

Local Game Capture evidence: `native-qt/qa/reports/six-channel-final-{vdo,native,endpoint,hosted-closeout}/results.json`, `native-qt/qa/reports/six-channel-stereo-regression/results.json`, `native-qt/qa/reports/six-channel-gui-20261022/results.json`, and `native-qt/qa/reports/six-channel-review-20261022-synthetic/results.json`. The `vdo` report uses local signaling with VDO-compatible negotiation; `hosted-closeout` uses the actual hosted viewer.

Commands, from this checkout:

```powershell
node native-qt/e2e/six-channel-packaged-e2e.js --publisher=<package>/game-capture.exe --output=<fresh-report-directory> --stereo-endpoint=true
node native-qt/e2e/six-channel-packaged-e2e.js --publisher=<package>/game-capture.exe --output=<fresh-report-directory> --synthetic-capture=true
node native-qt/e2e/six-channel-packaged-e2e.js --publisher=<package>/game-capture.exe --output=<fresh-report-directory> --synthetic-capture=true --native-multiopus=true
node native-qt/e2e/six-channel-packaged-e2e.js --publisher=<package>/game-capture.exe --output=<fresh-report-directory> --synthetic-capture=true --hosted=true
& native-qt/.cache/desktop-ui-python/Scripts/python.exe native-qt/e2e/six-channel-desktop-e2e.py --publisher=<package>/game-capture.exe --output=<fresh-report-directory>
```

The GUI workflow drives the real desktop and goes live on hosted VDO.Ninja; `--no-live` keeps it to settings and persistence.

The synthetic workflow requires Frida in the existing `native-qt/.cache/desktop-ui-python` environment. Omit both source overrides to require six independent tones from the real Windows playback/capture path. The harness intentionally fails if a stereo endpoint has already mixed the sources together.

## Other integration work

The initial October 20 sender pass did not change VDO.Ninja, ninja-plugin, or Desktop Studio. The later OBS receiver work below was verified when this record was reconciled on 2026-11-14.

- **ninja-plugin:** native six-channel reception shipped in [v1.1.80 on October 31](https://github.com/steveseguin/ninja-obs-plugin/releases/tag/v1.1.80). It validates multistream SDP, configures the decoder mapping, preserves the six slots and outputs an OBS 5.1 speaker layout. The [saved validation record](../../ninja-plugin/docs/six-channel-validation.json) contains 12 actual OBS recordings: local and released-plugin 5.1/stereo downmix workflows, plus ordinary mono/stereo regressions, each before and after receiver source recreation. Six-channel tones were injected at the sender's capture boundary; physical input remains untested. Six-channel publishing from OBS is still separate unfinished work.
- **Desktop Studio:** shared Game Capture transport changes are reusable, but the source mixer, processing, monitoring and browser capture currently normalize to stereo. A six-channel source should remain available for routing and separate recording while supplying a stereo program/monitor mix where appropriate. Simply porting the output selector would lose channel identity earlier in that pipeline.
- **Eight channels:** deliberately outside this candidate. The checked VDO.Ninja helper uses five streams/four coupled streams for its eight-channel branch, while the [WebRTC implementation](https://webrtc.googlesource.com/src/+/e62c2f2c77bca9af93b1f8cc5a37bb9978a18844/api/audio_codecs/opus/audio_decoder_multi_channel_opus.cc) uses five/three. That needs review before claiming eight-channel interoperability.

Still unverified or unfinished: physical six-channel microphone/interface input, independent six-channel process capture on a configured multichannel endpoint, microphone-plus-process mixing in six-channel mode, third-party WHIP destinations, full-band preservation through AAC (slot 4 fails the measured speech-range check), six-channel publishing from OBS, and Desktop Studio multichannel source routing. Testing of the complete six-channel feature is not complete.

On 2026-11-14, the October 22 Game Capture candidate and released plugin v1.1.80 passed four more actual portable OBS recordings (5.1 and stereo, before and after receiver source recreation). Both applications exited cleanly. See the [acceptance record](multichannel-acceptance.md) for hashes and evidence. The OBS path assigns slot 4 to LFE and omits it from stereo downmix; the 90 Hz fixture in that slot does not qualify six arbitrary full-band microphone channels through the recording encoder.

The subsequent speech-range check puts 1300, 1700, 2300, 2900, 3100 and 3700 Hz in the six slots. Hosted VDO.Ninja preserves all six, including all six source tones in the simultaneous stereo fallback. OBS AAC recording loses the 2900 Hz channel-4 tone; selecting FLAC for MKV recording preserves it and the other five tones, before and after source recreation. This qualifies the measured speech-range tones, not physical interface capture, complete frequency response or editor import. OBS stereo downmix still omits channel 4 even when the recording encoder is FLAC.

Repeat the hosted browser check from this checkout:

```powershell
node native-qt/e2e/six-channel-packaged-e2e.js --publisher=<package>/game-capture.exe --output=<fresh-report-directory> --synthetic-capture=true --hosted=true --tone-profile=voice
```

Add `--reconnect-cycles=3` to also close/rejoin each viewer and refresh the six-channel viewer while measuring the other viewer's continuous audio. The November 14 run passed all eight receiver measurements and clean publisher shutdown.

For local external-output qualification, run `native-qt/e2e/six-channel-external-e2e.py` with `--publisher=<package>/game-capture.exe --mediamtx=<path>/mediamtx.exe --report=<new-directory> --protocol=whip`. Add `--whip-stereo` to check ordinary-Opus fallback with a locally restricted endpoint. `--protocol=srt` exercises six-channel AAC and currently fails the speech-range content requirement for slot 4. See the [acceptance record](multichannel-acceptance.md) for measured results and limitations.

In the ninja-plugin checkout, add `--tone-profile=voice --record-audio-encoder=ffmpeg_flac` to `scripts/six-channel-native-e2e.py` with the usual publisher/plugin/portable-OBS paths. Using `ffmpeg_aac` with that voice profile deliberately fails the content check on channel 4 and saves its measured amplitudes; it must not be reported as a passed six-voice recording workflow. Omit the new options to retain the original surround fixture and AAC workflow.
