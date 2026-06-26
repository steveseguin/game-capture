# VP9 Alpha Transparency — Implementation Plan

**Goal:** Publish transparent video from game-capture to the VDO.Ninja OBS native receiver plugin using dual VP9 WebRTC tracks — one for color, one for alpha-as-grayscale — matching the protocol that the OBS plugin already decodes.

**Date drafted:** 2026-03-22
**Status:** Pre-implementation

---

## Table of Contents

1. [The Protocol (What the OBS Plugin Expects)](#1-the-protocol)
2. [Current State in game-capture](#2-current-state)
3. [What Must Be Built](#3-what-must-be-built)
4. [File-by-File Changes](#4-file-by-file-changes)
5. [VP9 RTP Packetizer Reference Implementation](#5-vp9-rtp-packetizer-reference-implementation)
6. [FFmpeg Command Reference](#6-ffmpeg-command-reference)
7. [Risk Mitigations](#7-risk-mitigations)
8. [Test Plan](#8-test-plan)
9. [Completion Checklist](#9-completion-checklist)

---

## 1. The Protocol

The OBS plugin expects the publisher to produce an SDP with **two VP9 video m-lines**, in this order:

```
m=video 9 UDP/TLS/RTP/SAVPF 96
a=rtpmap:96 VP9/90000
a=sendonly
...

m=video 9 UDP/TLS/RTP/SAVPF 97
a=rtpmap:97 VP9/90000
a=sendonly
...
```

| m-line | Content | Pixel encoding |
|--------|---------|----------------|
| 1st (primary) | Normal color video | YUV420P |
| 2nd (alpha) | Alpha channel only | Y=opacity (0–255), U=128, V=128 |

The plugin keys off **position** (first m-line = primary, second = alpha), not mid name.
Both tracks must have identical resolution. The plugin asserts this at decode time.

### RTP Packetization (RFC 9628 minimal)

```
 7 6 5 4 3 2 1 0      ← bit numbering (7=MSB)
+-+-+-+-+-+-+-+-+
|I|P|L|F|B|E|V|Z|
+-+-+-+-+-+-+-+-+

B = 0x08  (beginning of frame)
E = 0x04  (end of frame)
```

| Packet position | Descriptor byte | RTP M-bit |
|-----------------|-----------------|-----------|
| Single-packet frame | `0x0C` (B\|E) | 1 |
| First of multi-packet | `0x08` (B) | 0 |
| Middle | `0x00` | 0 |
| Last of multi-packet | `0x04` (E) | **1** |

VP9 bitstream can be split at **arbitrary byte boundaries** — no NAL or partition alignment is required (unlike H.264). The M-bit is set on the final packet of each frame.

---

## 2. Current State in game-capture

### What already exists

| Component | Status |
|-----------|--------|
| `VideoCodec::VP9` enum in `video_encoder.h` | ✅ defined |
| `EncoderConfig::enableAlpha` flag | ✅ exists |
| "VP9 + Alpha (Preview)" UI entry | ✅ in `main_window.cpp:586` |
| `codecSupportsAlphaWorkflow()` returns true for VP9 | ✅ `main_window.cpp:77` |
| Alpha workflow checkbox enabled when VP9 selected | ✅ |
| IVF container parser (`popExternalIvfPacket`) | ✅ works for VP9 (same `DKIF` format) |
| `addVP9Codec()` in libdatachannel v0.24.0 | ✅ `description.hpp:271` |
| SDP m-line order guaranteed FIFO by libdatachannel | ✅ `mTrackLines` vector in `peerconnection.cpp` |
| M-bit auto-set on last fragment by `RtpPacketizer` base | ✅ `rtppacketizer.cpp` base `outgoing()` |
| `CapturedFrame` has BGRA format with real alpha from DX11/WGC | ✅ |

### What is currently blocked

| Blocker | Location |
|---------|----------|
| VP9 encoder returns false immediately | `video_encoder.cpp:1140–1143` |
| VP9 → H.264 fallback in `toPeerVideoCodec()` | `versus_app.cpp:142–145` |
| "VP9 transport is preview-only" error in UI | `main_window.cpp:1133–1136` |
| No VP9 RTP packetizer in libdatachannel v0.24.0 | Confirmed: no `vp9rtppacketizer.cpp` in source |
| No alpha track in `WebRtcClient` | `webrtc_client.h/cpp` |
| `PeerConfig::VideoCodec` has no VP9 entry | `webrtc_client.h:30–34` |
| `CapturedFrame::Format` has no `Gray` for alpha input | `window_capture.h:30` |

---

## 3. What Must Be Built

### New files

| File | Purpose |
|------|---------|
| `native-qt/src/webrtc/vp9_rtp_packetizer.h` | Custom VP9 RTP packetizer (RFC 9628) — extend `rtc::RtpPacketizer`, implement `fragment()` |

### Modified files (in implementation order)

1. `native-qt/include/versus/video/window_capture.h` — add `Format::Gray`
2. `native-qt/include/versus/webrtc/webrtc_client.h` — add `VideoCodec::VP9`; add `sendAlphaVideo()`
3. `native-qt/src/webrtc/vp9_rtp_packetizer.h` — **new file** (VP9 RTP packetizer)
4. `native-qt/src/webrtc/webrtc_client.cpp` — VP9 track setup; alpha track; VP9 packetizer
5. `native-qt/src/video/video_encoder.cpp` — unblock VP9; add VP9 FFmpeg args; gray input support
6. `native-qt/src/app/versus_app.cpp` — fix VP9 fallback; alpha encoder instance; per-frame alpha extraction
7. `native-qt/src/ui/main_window.cpp` — remove "preview-only" VP9 block

---

## 4. File-by-File Changes

### 4.1 `window_capture.h` — Add Gray format

```cpp
struct CapturedFrame {
    // ...
    enum class Format { BGRA, NV12, I420, Gray } format = Format::BGRA;
    //                                   ^^^^^ new
};
```

This is the format the alpha encoder will receive — raw alpha bytes, one byte per pixel, row-major.

---

### 4.2 `webrtc_client.h` — VP9 codec + alpha API

**Add VP9 to the enum:**
```cpp
struct PeerConfig {
    enum class VideoCodec {
        H264,
        H265,
        AV1,
        VP9    // add
    };
    // ...
    bool enableAlphaTrack = false;  // add: when true, negotiate second VP9 alpha m-line
};
```

**Add `sendAlphaVideo()` to the public API:**
```cpp
bool sendAlphaVideo(const EncodedVideoPacket &packet);
bool hasActiveAlphaVideoTrack() const;
```

---

### 4.3 `vp9_rtp_packetizer.h` — **New file**

Header-only is fine since `RtpPacketizer` is header-included from libdatachannel.

```cpp
#pragma once

#include <rtc/rtppacketizer.hpp>
#include <cstdint>
#include <vector>

namespace versus::webrtc {

// RFC 9628 minimal VP9 RTP packetizer.
// Only overrides fragment(); the base class outgoing() auto-sets the RTP
// M-bit on the last fragment and handles sequence numbers.
//
// Descriptor byte layout (one byte prepended to each RTP payload):
//   7 6 5 4 3 2 1 0
//  |I|P|L|F|B|E|V|Z|
//  B = 0x08 (beginning of frame)
//  E = 0x04 (end of frame)
class Vp9RtpPacketizer final : public rtc::RtpPacketizer {
public:
    static constexpr uint8_t kDescB = 0x08;
    static constexpr uint8_t kDescE = 0x04;

    explicit Vp9RtpPacketizer(
        std::shared_ptr<rtc::RtpPacketizationConfig> rtpConfig,
        size_t maxFragmentSize = DefaultMaxFragmentSize)
        : rtc::RtpPacketizer(std::move(rtpConfig))
        , mMaxFragmentSize(maxFragmentSize) {}

protected:
    std::vector<rtc::binary> fragment(rtc::binary frame) override {
        std::vector<rtc::binary> result;
        // 1 byte consumed by the VP9 descriptor
        const size_t payloadMtu = (mMaxFragmentSize > 1) ? (mMaxFragmentSize - 1) : 1;

        size_t offset = 0;
        bool isFirst = true;

        while (offset < frame.size()) {
            const size_t chunkSize = std::min(payloadMtu, frame.size() - offset);
            const bool isLast = (offset + chunkSize >= frame.size());

            rtc::binary packet;
            packet.reserve(1 + chunkSize);

            uint8_t desc = 0x00;
            if (isFirst) desc |= kDescB;
            if (isLast)  desc |= kDescE;
            packet.push_back(static_cast<std::byte>(desc));

            packet.insert(packet.end(),
                          frame.begin() + static_cast<ptrdiff_t>(offset),
                          frame.begin() + static_cast<ptrdiff_t>(offset + chunkSize));

            result.push_back(std::move(packet));
            offset += chunkSize;
            isFirst = false;
        }

        return result;
    }

private:
    const size_t mMaxFragmentSize;
};

}  // namespace versus::webrtc
```

> **Note on M-bit:** The base class `rtc::RtpPacketizer::outgoing()` iterates the vector returned by `fragment()` and calls `packetize(chunk, mark=true)` on the **last element only**. This sets the RTP marker bit correctly. The packetizer does not need to touch the M-bit itself. (Confirmed from libdatachannel `src/rtppacketizer.cpp`.)

> **Note on descriptor correctness:** These are the same bit values used by the OBS plugin's `vp9-alpha-publisher.exe` reference tool. The OBS plugin parser handles `B|E = 0x0C` for single-packet frames and `B=0x08` / `E=0x04` for fragments correctly.

---

### 4.4 `webrtc_client.cpp` — VP9 tracks and packetizer

**Add include at top:**
```cpp
#include "vp9_rtp_packetizer.h"
```

**Add alpha track fields to `Impl`:**
```cpp
struct Impl {
    // ... existing fields ...
    std::shared_ptr<rtc::Track> alphaVideoTrack;
    std::shared_ptr<Vp9RtpPacketizer> alphaVideoPacketizer;
    std::shared_ptr<rtc::RtpPacketizationConfig> alphaVideoRtpConfig;
    std::atomic<bool> alphaVideoTrackOpen{false};
    uint32_t alphaVideoSsrc = 4444444;
    bool alphaTrackEnabled = false;
};
```

**Constants:**
```cpp
constexpr uint8_t kAlphaVideoPayloadType = 97;  // distinct PT from primary (96)
```

**Update `initialize()` to store alpha flag:**
```cpp
impl_->alphaTrackEnabled = config.enableAlphaTrack;
```

**Update `ensureVideoTrack()` for VP9:**

```cpp
case PeerConfig::VideoCodec::VP9: {
    // Primary VP9 track (m-line 0)
    video.addVP9Codec(kVideoPayloadType);
    video.addSSRC(videoSsrc, "gamecapture-video");
    videoTrack = pc->addTrack(video);
    // ... onOpen/onClosed handlers (same pattern as H264) ...

    videoRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
        videoSsrc, "gamecapture-video", kVideoPayloadType, kVideoClockRate);
    videoPacketizer = std::make_shared<Vp9RtpPacketizer>(videoRtpConfig);
    // ... add RTCP chain (reporter, nack, pli) same as H264 ...
    videoTrack->setMediaHandler(videoPacketizer);

    // Alpha VP9 track (m-line 1) — MUST be added before setLocalDescription
    if (alphaTrackEnabled) {
        rtc::Description::Video alphaDesc("video-alpha",
                                           rtc::Description::Direction::SendOnly);
        alphaDesc.addVP9Codec(kAlphaVideoPayloadType);
        alphaDesc.addSSRC(alphaVideoSsrc, "gamecapture-alpha");
        alphaVideoTrack = pc->addTrack(alphaDesc);

        alphaVideoTrack->onOpen([this]() {
            spdlog::info("[WebRTC] Alpha video track opened");
            alphaVideoTrackOpen.store(true);
        });
        alphaVideoTrack->onClosed([this]() {
            spdlog::info("[WebRTC] Alpha video track closed");
            alphaVideoTrackOpen.store(false);
        });

        alphaVideoRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            alphaVideoSsrc, "gamecapture-alpha", kAlphaVideoPayloadType, kVideoClockRate);
        alphaVideoPacketizer = std::make_shared<Vp9RtpPacketizer>(alphaVideoRtpConfig);
        // Add RTCP reporter for the alpha track too
        auto alphaReporter = std::make_shared<rtc::RtcpSrReporter>(alphaVideoRtpConfig);
        alphaVideoPacketizer->addToChain(alphaReporter);
        alphaVideoTrack->setMediaHandler(alphaVideoPacketizer);
    }
    break;
}
```

> **Track ordering guarantee:** libdatachannel stores tracks in `mTrackLines` (a `std::vector<weak_ptr<Track>>`) in insertion order and iterates it in the same order when building the SDP offer. Adding primary before alpha guarantees primary = m-line 0. (Confirmed from `src/impl/peerconnection.cpp`.)

**Add `sendAlphaVideo()` implementation:**
```cpp
bool WebRtcClient::sendAlphaVideo(const EncodedVideoPacket &packet) {
    if (!impl_->alphaVideoTrack || !impl_->alphaVideoTrack->isOpen() ||
        !impl_->alphaVideoRtpConfig) {
        return false;
    }
    if (packet.data.empty()) return false;

    // Same 90 kHz clock as primary
    uint32_t rtpTimestamp = static_cast<uint32_t>((packet.pts * 9) / 1000);
    impl_->alphaVideoRtpConfig->timestamp = rtpTimestamp;

    rtc::binary binaryPayload = toBinary(packet.data);
    impl_->alphaVideoTrack->send(binaryPayload);
    return true;
}
```

**Also add `hasActiveAlphaVideoTrack()`** (used by the app to gate alpha sends):
```cpp
bool WebRtcClient::hasActiveAlphaVideoTrack() const {
    return impl_->alphaVideoTrackOpen.load();
}
```

**Update `resetMediaState()`** to also reset the alpha track fields.

---

### 4.5 `video_encoder.cpp` — Unblock VP9 + gray input

**Step 1: Remove the VP8/VP9 block** (lines 1140–1143):
```cpp
// DELETE THIS:
if (config_.codec == VideoCodec::VP8 || config_.codec == VideoCodec::VP9) {
    spdlog::warn("[FFmpegEncoder] Codec {} is not supported in current RTP transport path", ...);
    return false;
}
```

**Step 2: Add VP9 case to the codec switch** (after line 1185):
```cpp
case VideoCodec::VP9:
    encoderName = "libvpx-vp9";      // software only; no HW VP9 in libvpx
    externalOutputFormat_ = ExternalOutputFormat::Ivf;
    externalUsingHardware_ = false;
    break;
```

> **Why no hardware VP9?** NVENC, QSV, and AMF do not have a standard libvpx-compatible VP9 encoder that outputs raw IVF the way we need. `libvpx-vp9` is the only viable software encoder here. Hardware selection is intentionally ignored for VP9.

**Step 3: Handle gray input for alpha encoder instances**

After the `inputPixelFormat` selection (line ~1203):
```cpp
// VP9 alpha encoder uses gray input (alpha channel bytes only)
if (config_.codec == VideoCodec::VP9 && config_.enableAlpha) {
    // Alpha track: gray input, preserve Y = alpha value
    externalInputIsNv12_ = false;
    inputPixelFormat = "gray";
} else if (config_.codec == VideoCodec::VP9) {
    // Primary track: standard NV12 input
    externalInputIsNv12_ = true;
    inputPixelFormat = "nv12";
}
```

> For `CapturedFrame::Format::Gray`, the encoder writes the gray byte buffer directly to the FFmpeg stdin pipe. The existing write path (NV12 is `width*height + width/2*height/2*2` bytes; gray is `width*height` bytes) needs to handle this size difference. The simplest fix: add a `Format::Gray` branch in `prepareExternalInputFrame()` that just copies `width * height` bytes from `frame.data`.

**Step 4: Add the libvpx-vp9 realtime arg block**:

In the `else if (encoderName == "libaom-av1")` block area, add:
```cpp
} else if (encoderName == "libvpx-vp9") {
    args.push_back("-deadline");
    args.push_back("realtime");
    args.push_back("-cpu-used");
    args.push_back("8");
    args.push_back("-lag-in-frames");
    args.push_back("0");
    args.push_back("-row-mt");
    args.push_back("1");
    args.push_back("-tile-columns");
    args.push_back("2");
    // CBR: set -b:v, -minrate, and -maxrate all equal
    // (already set -b:v and -maxrate above; add -minrate)
    args.push_back("-minrate");
    args.push_back(std::to_string(bitrate) + "k");
}
```

**Step 5: Add VP9 output format + color flags**:

After the existing AV1 output format block:
```cpp
} else if (config_.codec == VideoCodec::VP9) {
    // Primary track colorspace
    if (!config_.enableAlpha) {
        args.push_back("-pix_fmt");
        args.push_back("yuv420p");
        args.push_back("-colorspace");
        args.push_back("bt709");
        args.push_back("-color_primaries");
        args.push_back("bt709");
        args.push_back("-color_trc");
        args.push_back("bt709");
        args.push_back("-color_range");
        args.push_back("tv");
    } else {
        // Alpha encoder: preserve Y values 0–255 exactly
        args.push_back("-pix_fmt");
        args.push_back("yuv420p");
        args.push_back("-color_range");
        args.push_back("full");
    }
    args.push_back("-f");
    args.push_back("ivf");
}
```

**Step 6: Force all-keyframes for VP9**

Replace the existing `-g` calculation for VP9 with `-g 1`:
```cpp
if (config_.codec == VideoCodec::VP9) {
    // All-keyframe: simplifies alpha/primary sync and join-anywhere behavior.
    // The existing popExternalIvfPacket() hardcodes isKeyframe=true,
    // which is correct when -g 1 is used.
    args.push_back("-g");
    args.push_back("1");
} else {
    // Existing GOP logic for other codecs
    args.push_back("-g");
    args.push_back(std::to_string(gop));
    args.push_back("-force_key_frames");
    args.push_back("expr:gte(t,n_forced*2.5)");
}
```

> **Why all-keyframes?** The OBS plugin decoder needs both primary and alpha keyframes to be aligned to start decoding. With `-g 1`, every VP9 frame is independently decodable. This avoids a race condition where a viewer joins mid-GOP and gets a stale alpha frame with a fresh primary frame. The bitrate cost is real (~20–30% overhead) but acceptable for this use case.

---

### 4.6 `versus_app.cpp` — Two encoders + alpha extraction

**Step 1: Fix `toPeerVideoCodec()` for VP9** (line 142–145):
```cpp
case video::VideoCodec::VP9:
    return webrtc::PeerConfig::VideoCodec::VP9;   // was falling through to H264
```

**Step 2: Add the alpha encoder + alpha buffer to `VersusApp`**:

In the `VersusApp` class (or its `Impl`), add:
```cpp
// Alpha encoder — only active when VP9+alpha mode is enabled
std::unique_ptr<video::VideoEncoder> alphaEncoder_;
std::vector<uint8_t> alphaGrayBuffer_;    // pre-allocated, width*height bytes
bool alphaWorkflowActive_ = false;
```

**Step 3: Initialize the alpha encoder when VP9+alpha is configured**:

In the video config setup path (wherever `videoEncoder_` is initialized):
```cpp
if (videoConfig_.codec == video::VideoCodec::VP9 && videoConfig_.enableAlpha) {
    alphaWorkflowActive_ = true;
    video::EncoderConfig alphaCfg = videoConfig_;
    alphaCfg.enableAlpha = true;  // signals gray input + -color_range full
    // Use same dimensions, fps; lower bitrate for alpha (alpha is low-detail)
    alphaCfg.bitrate    = std::max(500,  videoConfig_.bitrate    / 4);
    alphaCfg.maxBitrate = std::max(1000, videoConfig_.maxBitrate / 4);
    alphaCfg.minBitrate = alphaCfg.bitrate;
    alphaEncoder_ = std::make_unique<video::VideoEncoder>();
    if (!alphaEncoder_->initialize(alphaCfg)) {
        spdlog::warn("[App] Failed to initialize alpha encoder; alpha track disabled");
        alphaEncoder_.reset();
        alphaWorkflowActive_ = false;
    }
    alphaGrayBuffer_.resize(videoConfig_.width * videoConfig_.height);
} else {
    alphaWorkflowActive_ = false;
    alphaEncoder_.reset();
}
```

**Step 4: Enable alpha track in PeerConfig**:
```cpp
peerConfig.enableAlphaTrack = alphaWorkflowActive_;
```

**Step 5: Per-frame alpha extraction and send**:

In the existing frame encode + send loop, after `sendVideo()`:
```cpp
if (alphaWorkflowActive_ && alphaEncoder_ && peer->client->hasActiveAlphaVideoTrack()) {
    // Extract alpha channel from BGRA frame
    const uint8_t* bgra = frame.data.data();
    const int stride = frame.stride;      // bytes per row (usually width * 4)
    const int w = videoConfig_.width;
    const int h = videoConfig_.height;

    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            // BGRA layout: [B=0, G=1, R=2, A=3]
            alphaGrayBuffer_[y * w + x] = bgra[y * stride + x * 4 + 3];
        }
    }

    // Construct a Gray CapturedFrame wrapping the alpha buffer
    video::CapturedFrame alphaFrame;
    alphaFrame.format = video::CapturedFrame::Format::Gray;
    alphaFrame.data   = alphaGrayBuffer_;   // or use a pointer variant if available
    alphaFrame.stride = w;                  // gray: 1 byte per pixel, no padding
    alphaFrame.width  = w;
    alphaFrame.height = h;
    alphaFrame.pts    = frame.pts;          // same timestamp as primary

    video::EncodedPacket alphaPacket;
    if (alphaEncoder_->encode(alphaFrame, alphaPacket)) {
        webrtc::EncodedVideoPacket alphaVp;
        alphaVp.data       = alphaPacket.data;
        alphaVp.pts        = alphaPacket.pts;
        alphaVp.isKeyframe = alphaPacket.isKeyframe;
        peer->client->sendAlphaVideo(alphaVp);
    }
}
```

> **Alpha bitrate rule of thumb:** alpha content is low-detail (soft edges, broad gradients) and compresses very well. One-quarter of the primary bitrate is usually adequate. Minimum 500 kbps to avoid blocking artifacts that would show as hard alpha edges.

**Step 6: Shutdown alpha encoder** when stopping live:
```cpp
alphaEncoder_.reset();
alphaWorkflowActive_ = false;
alphaGrayBuffer_.clear();
```

---

### 4.7 `main_window.cpp` — Remove preview-only block

**Remove lines 1133–1136:**
```cpp
// DELETE THIS:
if (config.codec == versus::video::VideoCodec::VP9) {
    updateStatus("VP9 transport is preview-only; use AV1 or H.264 for live publish", "error");
    return;
}
```

**Update the tooltip at line ~1491:**
```cpp
} else if (selectedCodec == versus::video::VideoCodec::VP9) {
    codecSelect_->setToolTip(
        "VP9 with alpha channel. Requires libvpx-vp9 in your FFmpeg build. "
        "Receiver must be the VDO.Ninja native OBS plugin (v1.1.39+).");
}
```

---

## 5. VP9 RTP Packetizer Reference Implementation

The full `Vp9RtpPacketizer` class is in section 4.3. Key design notes:

### Why subclass `rtc::RtpPacketizer`?

libdatachannel v0.24.0 has packetizers for H264, H265, and AV1, but **no VP9 packetizer**. The VP8 packetizer referenced in research was added in a later version not present in v0.24.0. Subclassing `rtc::RtpPacketizer` and overriding only `fragment()` is the minimal correct approach.

### Fragment size calculation

```
max RTP packet size = 1200 bytes (conservative MTU for WebRTC over DTLS-SRTP)
RTP header          = 12 bytes
VP9 descriptor      = 1 byte
Available for VP9 data = 1200 - 12 - 1 = 1187 bytes per packet
```

At 1080p30 with ~5 Mbps VP9 CBR, a typical frame is 20–200 KB. Most frames will fragment into 20–170 RTP packets. This is normal.

### What the base class handles

- Sequence number increment on each call to `packetize()`
- RTP M-bit set on last fragment (last element of the `fragment()` return vector)
- SSRC, payload type, clock rate from `RtpPacketizationConfig`
- RTCP SR reporting (via chained `RtcpSrReporter`)

### What `fragment()` must do

Only: split the raw VP9 bitstream and prepend the 1-byte descriptor byte. Nothing else.

---

## 6. FFmpeg Command Reference

### Primary VP9 track (NV12 input → color)

```
ffmpeg -hide_banner -loglevel error -nostats
  -fflags +nobuffer
  -f rawvideo -pix_fmt nv12
  -video_size 1280x720 -framerate 30
  -i -
  -an
  -c:v libvpx-vp9
  -b:v 4000k -minrate 4000k -maxrate 4000k -bufsize 8000k
  -deadline realtime
  -cpu-used 8
  -lag-in-frames 0
  -row-mt 1
  -tile-columns 2
  -g 1
  -pix_fmt yuv420p
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
  -f ivf -
```

### Alpha VP9 track (gray input → alpha-as-Y)

```
ffmpeg -hide_banner -loglevel error -nostats
  -fflags +nobuffer
  -f rawvideo -pix_fmt gray
  -video_size 1280x720 -framerate 30
  -i -
  -an
  -c:v libvpx-vp9
  -b:v 1000k -minrate 1000k -maxrate 1000k -bufsize 2000k
  -deadline realtime
  -cpu-used 8
  -lag-in-frames 0
  -g 1
  -pix_fmt yuv420p
  -color_range full
  -f ivf -
```

> **`-color_range full` on alpha track is critical.** Without it, FFmpeg may apply limited-range scaling (0→16, 255→235) that distorts the alpha values. With `full`, Y values 0–255 pass through unchanged to the VP9 bitstream. Confirmed: `libswscale` fills U/V planes with exactly 128 when converting `gray → yuv420p`.

### Verifying libvpx-vp9 is available

```
ffmpeg -codecs 2>&1 | grep libvpx-vp9
```

Expected output contains `libvpx-vp9`. If missing, the user needs a full FFmpeg build (not the "essentials" package). A full build is available from:
- https://www.gyan.dev/ffmpeg/builds/ (Windows, `ffmpeg-release-full.7z`)
- https://github.com/BtbN/FFmpeg-Builds/releases (`ffmpeg-master-latest-win64-gpl.zip`)

These include `libvpx`, `libx264`, `libopus`, and other codecs that the "essentials" build omits.

### IVF container format (for documentation)

The existing `popExternalIvfPacket()` correctly handles VP9. Reference:

```
IVF File Header (32 bytes, little-endian):
  [0-3]   Magic: "DKIF" = 0x44 0x4B 0x49 0x46
  [4-5]   Version: 0x0000
  [6-7]   Header length: 0x0020 (= 32)
  [8-11]  Codec FourCC: "VP90" = 0x56 0x50 0x39 0x30  ← VP9 specific
  [12-13] Width (pixels, LE)
  [14-15] Height (pixels, LE)
  [16-19] Timebase denominator
  [20-23] Timebase numerator
  [24-27] Frame count (0 when streaming)
  [28-31] Reserved

IVF Per-Frame Header (12 bytes):
  [0-3]   Frame data size (bytes that follow, LE uint32)
  [4-11]  PTS (LE uint64, two 32-bit halves)
```

The existing code validates `DKIF` and strips the 32-byte file header, then reads per-frame headers. No changes needed for VP9.

---

## 7. Risk Mitigations

### Risk 1: libvpx-vp9 not in user's FFmpeg build

**Probability:** High (the Windows FFmpeg "essentials" build omits libvpx)
**Impact:** Feature completely non-functional
**Mitigation:**
- Add an explicit check in `initializeExternalFfmpegNvenc()` for VP9: run `ffmpeg -codecs` and parse output for `libvpx-vp9` before starting the encoder. If absent, show a clear error: `"VP9 alpha requires a full FFmpeg build with libvpx. See Settings > FFmpeg Path."`
- Document the required FFmpeg URLs in UI help text

### Risk 2: Color range distortion on alpha track

**Probability:** Medium (default FFmpeg behavior for gray→yuv420p is limited range)
**Impact:** Alpha values are compressed to 16–235 range, causing hard black and white edges to become slightly transparent or slightly opaque
**Mitigation:** Explicitly pass `-color_range full` on the alpha encoder FFmpeg args. This is validated: libswscale's gray→yuv420p path sets U/V=128 and copies Y as-is when `full` range is specified.

### Risk 3: Premultiplied alpha sources

**Probability:** High for Spout (VSeeFace, Animaze, VTube Studio all output premultiplied)
**Impact:** Colors appear too dark/saturated when composited; transparent edges have color fringing
**Mitigation:** Add a UI checkbox "Source uses premultiplied alpha (Spout/VR overlay)". When enabled, run un-premultiply before alpha extraction:
```cpp
// Un-premultiply BGRA in-place before alpha extraction
for each pixel: if (A > 0) { B = B*255/A; G = G*255/A; R = R*255/A; }
```
Consider a lookup table (256×256) for performance: `unpremult[color][alpha] = color*255/alpha`.

### Risk 4: Track order in SDP reversed by libdatachannel

**Probability:** Very low
**Impact:** OBS plugin interprets alpha track as primary and primary as alpha — inverted output
**Mitigation:** Verified from libdatachannel source: `mTrackLines` is a `std::vector<weak_ptr<Track>>` populated by `emplace_back` in insertion order. The SDP builder iterates it in order. Add an assertion log: log both m-line MIDs after generating the local offer SDP and confirm order.

### Risk 5: Alpha and primary frame dimension mismatch

**Probability:** Low (both use same `videoConfig_.width/height`)
**Impact:** OBS plugin refuses to compose frames (it asserts equal dimensions)
**Mitigation:** Guard in `versus_app.cpp` before alpha encode:
```cpp
assert(alphaFrame.width == primaryFrame.width && alphaFrame.height == primaryFrame.height);
```
Also log a warning if alpha encoder is initialized with different dimensions than primary.

### Risk 6: Two FFmpeg processes doubling CPU usage

**Probability:** Certain (two processes per stream)
**Impact:** CPU-limited machines may drop frames
**Mitigation:**
- Use `-cpu-used 8` (fastest, lowest quality) for the alpha encoder. Alpha detail is inherently low-frequency so this is visually fine.
- Omit `-row-mt 1` on the alpha encoder (single-threaded is sufficient for 1-channel grayscale).
- Alpha bitrate at 25% of primary (alpha compresses much better than color video).
- Document: "VP9 alpha mode requires approximately 1.5× the CPU of standard VP9 encoding."

### Risk 7: Both streams must be keyframe-aligned for new viewer joins

**Probability:** Certain with GOPs > 1 if not mitigated
**Impact:** New viewers joining mid-GOP see one track from a keyframe, the other not, resulting in corruption or transparency glitches
**Mitigation:** Use `-g 1` (all-keyframes) for both tracks. This is the approach used by the `vp9-alpha-publisher.exe` reference tool. The bitrate overhead is ~20–30% vs. `-g 30`.

### Risk 8: FFmpeg process restart on PLI/FIR keyframe request

**Probability:** Medium (PLI is sent when packet loss occurs)
**Impact:** Primary encoder restarts; alpha encoder does not (or vice versa)
**Mitigation:** Wire the PLI/FIR handler (currently calls `keyframeCallback_` on primary encoder) to also restart/signal the alpha encoder. Since `-g 1` makes all frames keyframes, a PLI response is just a new frame — no restart needed. The existing `restartExternalFfmpegNvenc()` may still be called on pipe failure; ensure alpha encoder is restarted in the same code path.

### Risk 9: Dual HQ streams (dual-stream routing)

**Probability:** Medium (if a viewer gets the HQ stream, it should have alpha)
**Impact:** Alpha track only attached to one quality tier
**Mitigation:** Initially implement alpha only for the primary (HQ) stream. The LQ stream (640×360) does not need alpha for VR avatar use cases. Document this limitation.

---

## 8. Test Plan

### Pre-requisite verification

Before any functional testing:
```
# In a terminal:
ffmpeg -codecs 2>&1 | grep libvpx-vp9
# Must show: DEV.LS libvpx-vp9  libvpx VP9
```

### Test 1 — VP9 baseline (no alpha)

**Setup:** Enable "VP9 + Alpha (Preview)" codec; leave alpha checkbox unchecked
**Steps:**
1. Start game-capture, select any window, connect to VDO.Ninja room
2. Open the stream in a browser viewer (Chrome/Firefox)
3. Open the stream in OBS with the native receiver plugin

**Pass criteria:**
- [ ] Build compiles with no errors
- [ ] Encoder log shows "FFmpeg libvpx-vp9" (not a fallback)
- [ ] SDP offer log shows exactly one `m=video` VP9 section
- [ ] Video plays in browser without corruption (VP9 is browser-native)
- [ ] Video plays in OBS native receiver without corruption
- [ ] No "unsupported codec" or "preview-only" error in UI

### Test 2 — SDP negotiation with alpha track

**Setup:** Enable VP9 codec + alpha checkbox
**Steps:**
1. Start game-capture, connect to VDO.Ninja room
2. Capture the SDP offer string (add debug log in `createOffer()` or `ensureVideoTrack()`)
3. Examine SDP

**Pass criteria:**
- [ ] SDP contains exactly **two** `m=video` sections
- [ ] Both are VP9: `a=rtpmap:96 VP9/90000` and `a=rtpmap:97 VP9/90000`
- [ ] First m-line has PT 96, second has PT 97
- [ ] Each has a distinct SSRC (`a=ssrc:`)
- [ ] OBS plugin log shows: `[PeerManager] Second VP9 video m-line accepted as AlphaVideo track`

### Test 3 — Transparent test pattern (reference comparison)

**Setup:** Run `vp9-alpha-publisher.exe --stream-id testXYZ --width 320 --height 240` (from the OBS plugin build)
**Steps:**
1. Open stream in OBS native receiver
2. Observe: moving circle (fully opaque) on 50% transparent background
3. Stop publisher; start game-capture VP9+alpha on a transparent window with same stream-id
4. Observe same stream in OBS

**Pass criteria:**
- [ ] Reference publisher (`vp9-alpha-publisher.exe`) shows correct alpha in OBS
- [ ] game-capture VP9+alpha shows actual window content with alpha from capture
- [ ] Alpha composites correctly against a background layer in OBS scene (e.g., solid color behind)
- [ ] No green tinge or dark fringing (would indicate premultiplied alpha not handled)

### Test 4 — Transparent window source

**Setup:** Capture a window with real alpha (e.g., a Qt app with `WS_EX_LAYERED` window style set, or a VTubing app)
**Steps:**
1. Launch a transparent-background application (all-white window with WS_EX_LAYERED and 128 alpha)
2. Capture it with game-capture VP9+alpha
3. View in OBS

**Pass criteria:**
- [ ] Window content is visible in OBS
- [ ] Background is semi-transparent (not opaque black or opaque white)
- [ ] Edges of window elements show smooth alpha transitions
- [ ] Alpha value ≈ 128 (50% opacity) matches expected source value

### Test 5 — Premultiplied alpha source (Spout)

If a Spout sender is available:
**Setup:** VSeeFace or Animaze outputting via Spout; game-capture capturing Spout texture
**Steps:**
1. Enable "Source uses premultiplied alpha" checkbox in game-capture
2. Capture Spout source with VP9+alpha
3. View in OBS

**Pass criteria:**
- [ ] Avatar appears with correct colors (not washed out or dark)
- [ ] Background is transparent
- [ ] Semi-transparent elements (shadows, hair, cloth) show correct intermediate alpha

### Test 6 — Resolution correctness

**Setup:** Run at 1920×1080, 1280×720, 854×480
**Pass criteria for each resolution:**
- [ ] No "dimension mismatch" error in OBS plugin log
- [ ] No encoder crash or silent fallback
- [ ] Alpha track dimensions match primary track dimensions in the VP9 bitstream

### Test 7 — Stream reconnect / peer join mid-stream

**Steps:**
1. Start VP9+alpha stream
2. Open OBS native receiver — observe correct alpha
3. Disconnect OBS plugin; reconnect within 5 seconds

**Pass criteria:**
- [ ] Reconnected stream shows correct alpha immediately (no waiting for GOP)
- [ ] No frozen alpha frame from before disconnect
- [ ] Primary and alpha tracks are in sync after reconnect

### Test 8 — CPU headroom check

**Setup:** 1280×720@30fps on a mid-range CPU
**Pass criteria:**
- [ ] Encoder frame rate does not drop below target (monitor logs)
- [ ] Total CPU usage for both FFmpeg processes is under 50% on a quad-core
- [ ] No "Failed to queue frame" warnings in logs

---

## 9. Completion Checklist

A build is considered **complete** when all items are checked.

### Build & compile
- [ ] Project builds with no errors and no new warnings (MSVC on Windows)
- [ ] `Vp9RtpPacketizer` compiles and links without symbol errors
- [ ] No include path issues between `vp9_rtp_packetizer.h` and libdatachannel headers

### Encoder
- [ ] `VideoCodec::VP9` in encoder no longer returns `false` early
- [ ] VP9 primary encoder produces IVF output (`DKIF` magic verified in log)
- [ ] VP9 alpha encoder produces IVF output (log its first packet size)
- [ ] `Format::Gray` added to `CapturedFrame::Format` and handled in encoder input path
- [ ] Alpha FFmpeg command uses `-pix_fmt gray` input and `-color_range full`
- [ ] Primary FFmpeg command uses correct colorspace flags (`bt709`, `tv` range)
- [ ] Both encoders use `-g 1 -deadline realtime -cpu-used 8 -lag-in-frames 0`
- [ ] Alpha bitrate is 25% of primary bitrate (minimum 500 kbps)

### WebRTC
- [ ] `PeerConfig::VideoCodec::VP9` exists
- [ ] `PeerConfig::enableAlphaTrack` field exists and is wired
- [ ] `toPeerVideoCodec()` maps `video::VideoCodec::VP9` → `PeerConfig::VideoCodec::VP9`
- [ ] `ensureVideoTrack()` adds primary VP9 track (PT 96, SSRC 2222222)
- [ ] `ensureVideoTrack()` adds alpha VP9 track when `enableAlphaTrack=true` (PT 97, SSRC 4444444)
- [ ] Alpha track is added **after** primary track (m-line ordering)
- [ ] Both tracks use `Vp9RtpPacketizer`
- [ ] `sendAlphaVideo()` implemented and sends to alpha track
- [ ] `hasActiveAlphaVideoTrack()` implemented
- [ ] `resetMediaState()` clears alpha track state

### Frame pipeline
- [ ] Alpha extraction loop correctly reads A byte (offset +3 in BGRA)
- [ ] Alpha frame `pts` matches primary frame `pts`
- [ ] Alpha encoder and primary encoder are both initialized when VP9+alpha is configured
- [ ] Alpha encoder is shut down on stream stop
- [ ] PLI/FIR keyframe request restarts both encoders (or is harmless with `-g 1`)

### UI
- [ ] "VP9 transport is preview-only" error block removed from `main_window.cpp`
- [ ] Alpha workflow checkbox enabled when VP9 is selected
- [ ] "Source uses premultiplied alpha" checkbox added and wired to un-premultiply logic
- [ ] Tooltip updated (no longer says "preview-only")
- [ ] libvpx-vp9 availability check: shows clear error if FFmpeg lacks the codec

### Tests pass (from Test Plan above)
- [ ] Test 1: VP9 baseline — video plays in browser and OBS without corruption
- [ ] Test 2: SDP shows two VP9 m-lines with correct PTs and SSRCs
- [ ] Test 3: Animated test pattern composites correctly in OBS (reference comparison)
- [ ] Test 4: Transparent window source shows correct alpha in OBS
- [ ] Test 6: Works at 1280×720 and 1920×1080 with no dimension mismatch
- [ ] Test 7: Reconnect shows correct alpha immediately (all-keyframe behavior confirmed)
- [ ] Test 8: CPU usage under 50% at 720p30 on quad-core

### Documentation
- [ ] `CHANGELOG.md` entry added (VP9 alpha transparency, dual VP9 tracks, vp9_rtp_packetizer)
- [ ] FFmpeg requirement documented (full build needed, not essentials)
- [ ] Supported source types documented (transparent window, Spout, VR overlay)
- [ ] Known limitations documented: LQ stream has no alpha; hardware VP9 encoders not supported

---

## Appendix: Transparent Source Types Quick Reference

| Source | Alpha format | Premultiplied? | Capture method |
|--------|-------------|----------------|----------------|
| Window with `WS_EX_LAYERED` | Straight | No | WGC / DXGI |
| Spout sender (VSeeFace, Animaze) | **Premultiplied** | **Yes** | Spout2 plugin or WGC |
| OBS game capture "Allow Transparency" | App-dependent | App-dependent | DX11 hook |
| OpenVR overlay (`SetOverlayTexture`) | Premultiplied (DWM) | **Yes** | DXGI shared handle |
| DirectX swapchain `DXGI_ALPHA_MODE_PREMULTIPLIED` | **Premultiplied** | **Yes** | DXGI |
| DirectX swapchain `DXGI_ALPHA_MODE_STRAIGHT` | Straight | No | DXGI |

**Default assumption:** use straight alpha. Enable "premultiplied" checkbox for Spout and VR overlay sources.

---

*This plan was produced using validated research from RFC 9628, libdatachannel v0.24.0 source, FFmpeg/libvpx documentation, and inspection of the game-capture and ninja-plugin codebases.*
