# RTSP output and VRChat

In advanced output settings select **RTSP / VRChat (TCP)** and enter an RTSP
publishing URL, such as `rtsp://server.example:8554/live`. **RTSP (UDP)** is also
available. Both send H.264 video and 48 kHz AAC audio. TCP retransmits lost
packets, although congestion can increase latency. UDP has no retransmission
or FEC in this output path.

An RTSP publishing server is required. These options publish using RTSP
ANNOUNCE/RECORD; they do not make the app an RTSP server. A read-only camera or
viewing URL is not necessarily a publishing endpoint.
[MediaMTX supports this publishing workflow](https://mediamtx.org/docs/features/publish).

## VRChat workflow

1. Obtain a publishing endpoint from your streaming service or RTSP server.
2. Choose the matching output in the app. RTMP/RTMPS can also feed a server that
   offers RTSP viewing. For example, [TopazChat documents RTMP publishing and an
   RTSPT viewing URL](https://github.com/TopazChat/TopazChat).
3. Start output and put the server's **viewing URL** in your world's AVPro player.
   PC players commonly use `rtspt://server.example:8554/live` for RTSP over TCP.
   The app accepts `rtspt://` publishing URLs as a TCP alias and sends normal
   RTSP on the wire.
4. The server must be reachable by each viewer. `localhost` only works on the
   same computer. Keep publishing credentials separate from the shareable
   viewing address; do not share a credential-bearing publishing URL.

VRChat is not RTSPT-only. Its [video player documentation](https://creators.vrchat.com/worlds/udon/video-players/)
describes live-service support. [VRChat 2026.3.1](https://docs.vrchat.com/docs/vrchat-202631)
added Android translation of `rtspt://` URLs to `rtsp://`. Actual support depends
on the client, world player and service. Custom domains may require **Allow
Untrusted URLs**; Public and Group Public worlds also need their world domain
allowlist configured. See the [VRChat allowlist rules](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/).

## Automation and media handling

The capture CLI accepts `--output=rtsp` (TCP), `--output=rtspt` (TCP alias), and
`--output=rtsp-udp`. Supply `--output-url=rtsp://host:8554/stream` and the existing
source, encoder and audio arguments. `--aac-bitrate-kbps` controls AAC at
32–320 kbps, default 192. An `rtspt://` URL is rejected with UDP. Optional RTSP
authentication belongs in the URL (`rtsp://user:password@host:8554/stream`);
percent-encode reserved characters in credentials.

Desktop Studio's `output.configure` API/CLI/MCP accepts the same protocol names.
`rtspt` normalizes to `rtsp` in state. Its `credential` field is for WHIP/RTMP/SRT;
RTSP rejects it when nonempty. Studio can record independently while publishing.
RTSP adds no extra video encode: FFmpeg copies the encoded H.264 frames and
encodes audio as AAC. The transport selection controls the app-to-server link;
the server handles its viewer connections separately.

Output uses bounded queues and automatically reconnects with a fresh keyframe.
FFmpeg is a child process; Studio also isolates the publishing controller in a
worker process. RTSP credentials and paths are omitted from diagnostics. Saved
GUI destination profiles use the existing Windows user encryption. Plain RTSP
is not encrypted; the `t` in `rtspt` means TCP, not TLS. RTSPS and RTSP-over-HTTP
tunneling are not offered by this change.

Local packaged-app verification uses a private receiver. It does not establish
in-world VRChat or Quest compatibility; those clients still need direct testing.
