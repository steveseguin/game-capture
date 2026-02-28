#include "versus/webrtc/webrtc_client.h"

#include <rtc/common.hpp>
#include <rtc/rtc.hpp>
#include <rtc/av1rtppacketizer.hpp>
#include <rtc/h264rtppacketizer.hpp>
#include <rtc/h265rtppacketizer.hpp>
#include <rtc/nalunit.hpp>
#include <rtc/plihandler.hpp>
#include <rtc/rtppacketizationconfig.hpp>
#include <rtc/rtppacketizer.hpp>

#include <spdlog/spdlog.h>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <mutex>
#include <thread>
#include <variant>

namespace versus::webrtc {
namespace {

constexpr uint8_t kVideoPayloadType = 96;
constexpr uint8_t kAudioPayloadType = 111;
constexpr uint32_t kVideoClockRate = rtc::RtpPacketizer::VideoClockRate;
constexpr uint32_t kAudioClockRate = rtc::OpusRtpPacketizer::DefaultClockRate;

rtc::binary toBinary(const std::vector<uint8_t> &data) {
    rtc::binary out;
    out.reserve(data.size());
    for (uint8_t byte : data) {
        out.push_back(static_cast<rtc::byte>(byte));
    }
    return out;
}

}  // namespace

struct WebRtcClient::Impl {
    rtc::Configuration config;
    std::shared_ptr<rtc::PeerConnection> pc;
    std::shared_ptr<rtc::Track> videoTrack;
    std::shared_ptr<rtc::Track> audioTrack;
    std::shared_ptr<rtc::RtpPacketizer> videoPacketizer;
    std::shared_ptr<rtc::RtpPacketizer> audioPacketizer;
    std::shared_ptr<rtc::RtpPacketizationConfig> videoRtpConfig;
    std::shared_ptr<rtc::RtpPacketizationConfig> audioRtpConfig;
    std::string localDescription;
    IceCandidateCallback iceCallback;
    StateCallback stateCallback;
    KeyframeRequestCallback keyframeCallback;
    DataMessageCallback dataMessageCallback;
    DataChannelStateCallback dataChannelStateCallback;
    std::shared_ptr<rtc::DataChannel> sendChannel;
    std::mutex descMutex;
    std::mutex dataChannelMutex;
    std::atomic<ConnectionState> state{ConnectionState::Disconnected};
    std::atomic<bool> gatheringComplete{false};
    std::atomic<bool> sentFirstKeyframe{false};
    std::atomic<bool> firstVideoPacketLogged{false};
    std::atomic<bool> videoTrackOpen{false};
    std::atomic<bool> audioTrackOpen{false};
    std::atomic<bool> dataChannelOpen{false};
    std::atomic<uint64_t> videoPacketsSent{0};
    std::atomic<uint64_t> videoBytesSent{0};
    std::chrono::steady_clock::time_point trackOpenedTime;
    uint32_t videoSsrc = 2222222;
    uint32_t audioSsrc = 3333333;
    PeerConfig::VideoCodec videoCodec = PeerConfig::VideoCodec::H264;

    void bindDataChannel(const std::shared_ptr<rtc::DataChannel> &channel, const char *origin) {
        if (!channel) {
            return;
        }

        {
            std::lock_guard<std::mutex> lock(dataChannelMutex);
            sendChannel = channel;
        }

        spdlog::info("[WebRTC] DataChannel '{}' attached (origin={})", channel->label(), origin);
        std::weak_ptr<rtc::DataChannel> weakChannel = channel;

        channel->onOpen([this, weakChannel]() {
            auto opened = weakChannel.lock();
            if (!opened) {
                return;
            }
            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                if (sendChannel != opened) {
                    return;
                }
                dataChannelOpen.store(true);
            }
            spdlog::info("[WebRTC] DataChannel open: {}", opened->label());
            if (dataChannelStateCallback) {
                dataChannelStateCallback(true);
            }
        });

        channel->onClosed([this, weakChannel]() {
            auto closed = weakChannel.lock();
            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                if (!closed || sendChannel == closed) {
                    dataChannelOpen.store(false);
                }
            }
            if (closed) {
                spdlog::info("[WebRTC] DataChannel closed: {}", closed->label());
            } else {
                spdlog::info("[WebRTC] DataChannel closed");
            }
            if (dataChannelStateCallback) {
                dataChannelStateCallback(false);
            }
        });

        channel->onError([this](const std::string &error) {
            spdlog::warn("[WebRTC] DataChannel error: {}", error);
        });

        channel->onMessage([this, weakChannel](rtc::message_variant data) {
            auto inbound = weakChannel.lock();
            if (!inbound) {
                return;
            }

            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                if (sendChannel != inbound) {
                    return;
                }
            }

            if (!dataMessageCallback) {
                return;
            }

            if (std::holds_alternative<std::string>(data)) {
                dataMessageCallback(std::get<std::string>(data));
                return;
            }

            const auto &binary = std::get<rtc::binary>(data);
            if (!binary.empty()) {
                std::string payload;
                payload.reserve(binary.size());
                for (rtc::byte byte : binary) {
                    payload.push_back(static_cast<char>(std::to_integer<unsigned char>(byte)));
                }
                dataMessageCallback(payload);
            }
        });
    }

    void clearDataChannel() {
        std::shared_ptr<rtc::DataChannel> oldChannel;
        {
            std::lock_guard<std::mutex> lock(dataChannelMutex);
            oldChannel = std::move(sendChannel);
            dataChannelOpen.store(false);
        }

        if (oldChannel) {
            oldChannel->close();
        }
        if (dataChannelStateCallback) {
            dataChannelStateCallback(false);
        }
    }

    void setupTracks() {
        videoTrackOpen.store(false);
        audioTrackOpen.store(false);
        dataChannelOpen.store(false);
        firstVideoPacketLogged.store(false);
        videoPacketsSent.store(0);
        videoBytesSent.store(0);

        rtc::Description::Video video("video", rtc::Description::Direction::SendOnly);
        switch (videoCodec) {
            case PeerConfig::VideoCodec::H265:
                spdlog::info("[WebRTC] Configuring video codec: H265");
                video.addH265Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::AV1:
                spdlog::info("[WebRTC] Configuring video codec: AV1");
                video.addAV1Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::H264:
            default:
                // Use Constrained Baseline @ Level 3.1 (42e01f) for browser compatibility.
                video.addH264Codec(kVideoPayloadType,
                                   "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1");
                spdlog::info("[WebRTC] Configuring video codec: H264");
                break;
        }
        video.addSSRC(videoSsrc, "versus-video");
        videoTrack = pc->addTrack(video);

        videoTrack->onOpen([this]() {
            spdlog::info("[WebRTC] Video track opened");
            videoTrackOpen.store(true);
            trackOpenedTime = std::chrono::steady_clock::now();
        });
        videoTrack->onClosed([this]() {
            spdlog::info("[WebRTC] Video track closed");
            videoTrackOpen.store(false);
        });

        videoRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(videoSsrc, "versus-video", kVideoPayloadType, kVideoClockRate);
        switch (videoCodec) {
            case PeerConfig::VideoCodec::H265:
                videoPacketizer =
                    std::make_shared<rtc::H265RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, videoRtpConfig);
                break;
            case PeerConfig::VideoCodec::AV1:
                videoPacketizer = std::make_shared<rtc::AV1RtpPacketizer>(
                    rtc::AV1RtpPacketizer::Packetization::TemporalUnit, videoRtpConfig);
                break;
            case PeerConfig::VideoCodec::H264:
            default:
                videoPacketizer =
                    std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, videoRtpConfig);
                break;
        }
        auto videoReporter = std::make_shared<rtc::RtcpSrReporter>(videoRtpConfig);
        auto videoNack = std::make_shared<rtc::RtcpNackResponder>();
        auto videoPli = std::make_shared<rtc::PliHandler>([this]() {
            spdlog::info("[WebRTC] Received PLI/FIR - keyframe requested by receiver");
            if (keyframeCallback) {
                keyframeCallback();
            }
        });
        videoPacketizer->addToChain(videoReporter);
        videoPacketizer->addToChain(videoNack);
        videoPacketizer->addToChain(videoPli);
        videoTrack->setMediaHandler(videoPacketizer);

        rtc::Description::Audio audio("audio", rtc::Description::Direction::SendOnly);
        audio.addOpusCodec(kAudioPayloadType);
        audio.addSSRC(audioSsrc, "versus-audio");
        audioTrack = pc->addTrack(audio);

        audioTrack->onOpen([this]() {
            spdlog::info("[WebRTC] Audio track opened");
            audioTrackOpen.store(true);
        });
        audioTrack->onClosed([this]() {
            spdlog::info("[WebRTC] Audio track closed");
            audioTrackOpen.store(false);
        });

        audioRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(audioSsrc, "versus-audio", kAudioPayloadType, kAudioClockRate);
        audioPacketizer = std::make_shared<rtc::OpusRtpPacketizer>(audioRtpConfig);
        auto audioReporter = std::make_shared<rtc::RtcpSrReporter>(audioRtpConfig);
        auto audioNack = std::make_shared<rtc::RtcpNackResponder>();
        audioPacketizer->addToChain(audioReporter);
        audioPacketizer->addToChain(audioNack);
        audioTrack->setMediaHandler(audioPacketizer);

        bindDataChannel(pc->createDataChannel("sendChannel"), "local");
    }
};

WebRtcClient::WebRtcClient() : impl_(std::make_unique<Impl>()) {}
WebRtcClient::~WebRtcClient() { shutdown(); }

bool WebRtcClient::initialize(const PeerConfig &config) {
    impl_->videoCodec = config.videoCodec;

    rtc::Configuration rtcConfig;
    for (const auto &ice : config.iceServers) {
        rtcConfig.iceServers.emplace_back(ice);
    }

    impl_->pc = std::make_shared<rtc::PeerConnection>(rtcConfig);

    impl_->pc->onStateChange([this](rtc::PeerConnection::State state) {
        const char* stateStr = "unknown";
        ConnectionState mapped = ConnectionState::Disconnected;
        if (state == rtc::PeerConnection::State::Connecting) {
            mapped = ConnectionState::Connecting;
            stateStr = "connecting";
        } else if (state == rtc::PeerConnection::State::Connected) {
            mapped = ConnectionState::Connected;
            stateStr = "connected";
        } else if (state == rtc::PeerConnection::State::Failed) {
            mapped = ConnectionState::Failed;
            stateStr = "failed";
        } else if (state == rtc::PeerConnection::State::Closed) {
            stateStr = "closed";
        } else if (state == rtc::PeerConnection::State::Disconnected) {
            stateStr = "disconnected";
        } else if (state == rtc::PeerConnection::State::New) {
            stateStr = "new";
        }
        spdlog::info("[WebRTC] PeerConnection state: {}", stateStr);
        impl_->state.store(mapped);
        if (impl_->stateCallback) {
            impl_->stateCallback(mapped);
        }
    });

    impl_->pc->onLocalCandidate([this](rtc::Candidate candidate) {
        if (impl_->iceCallback) {
            impl_->iceCallback(candidate.candidate(), candidate.mid(), 0);
        }
    });

    impl_->pc->onLocalDescription([this](rtc::Description desc) {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription = std::string(desc);
        spdlog::debug("[WebRTC] Local description set");
    });

    impl_->pc->onGatheringStateChange([this](rtc::PeerConnection::GatheringState state) {
        const char* stateStr = "unknown";
        if (state == rtc::PeerConnection::GatheringState::New) stateStr = "new";
        else if (state == rtc::PeerConnection::GatheringState::InProgress) stateStr = "in_progress";
        else if (state == rtc::PeerConnection::GatheringState::Complete) stateStr = "complete";
        spdlog::info("[WebRTC] ICE gathering state: {}", stateStr);
        if (state == rtc::PeerConnection::GatheringState::Complete) {
            impl_->gatheringComplete.store(true);
        }
    });

    impl_->pc->onDataChannel([this](std::shared_ptr<rtc::DataChannel> channel) {
        if (!channel) {
            return;
        }
        impl_->bindDataChannel(channel, "remote");
    });

    impl_->setupTracks();
    return true;
}

void WebRtcClient::shutdown() {
    impl_->clearDataChannel();
    if (impl_->pc) {
        impl_->pc->close();
        impl_->pc.reset();
    }
    impl_->videoTrack.reset();
    impl_->audioTrack.reset();
    impl_->videoTrackOpen.store(false);
    impl_->audioTrackOpen.store(false);
}

void WebRtcClient::resetPeerConnection() {
    spdlog::info("[WebRTC] Resetting PeerConnection for new viewer");

    // Close old connection
    impl_->clearDataChannel();
    if (impl_->pc) {
        impl_->pc->close();
        impl_->pc.reset();
    }
    impl_->videoTrack.reset();
    impl_->audioTrack.reset();
    impl_->videoPacketizer.reset();
    impl_->audioPacketizer.reset();
    impl_->videoTrackOpen.store(false);
    impl_->audioTrackOpen.store(false);
    impl_->gatheringComplete.store(false);
    impl_->sentFirstKeyframe.store(false);
    impl_->localDescription.clear();

    // Create fresh PeerConnection
    rtc::Configuration rtcConfig;
    rtcConfig.iceServers.emplace_back("stun:stun.l.google.com:19302");

    impl_->pc = std::make_shared<rtc::PeerConnection>(rtcConfig);

    impl_->pc->onStateChange([this](rtc::PeerConnection::State state) {
        const char* stateStr = "unknown";
        ConnectionState mapped = ConnectionState::Disconnected;
        if (state == rtc::PeerConnection::State::Connecting) {
            mapped = ConnectionState::Connecting;
            stateStr = "connecting";
        } else if (state == rtc::PeerConnection::State::Connected) {
            mapped = ConnectionState::Connected;
            stateStr = "connected";
        } else if (state == rtc::PeerConnection::State::Failed) {
            mapped = ConnectionState::Failed;
            stateStr = "failed";
        } else if (state == rtc::PeerConnection::State::Closed) {
            stateStr = "closed";
        } else if (state == rtc::PeerConnection::State::Disconnected) {
            stateStr = "disconnected";
        } else if (state == rtc::PeerConnection::State::New) {
            stateStr = "new";
        }
        spdlog::info("[WebRTC] PeerConnection state: {}", stateStr);
        impl_->state.store(mapped);
        if (impl_->stateCallback) {
            impl_->stateCallback(mapped);
        }
    });

    impl_->pc->onLocalCandidate([this](rtc::Candidate candidate) {
        if (impl_->iceCallback) {
            impl_->iceCallback(candidate.candidate(), candidate.mid(), 0);
        }
    });

    impl_->pc->onLocalDescription([this](rtc::Description desc) {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription = std::string(desc);
    });

    impl_->pc->onGatheringStateChange([this](rtc::PeerConnection::GatheringState state) {
        if (state == rtc::PeerConnection::GatheringState::Complete) {
            impl_->gatheringComplete.store(true);
        }
    });

    impl_->pc->onDataChannel([this](std::shared_ptr<rtc::DataChannel> channel) {
        if (!channel) {
            return;
        }
        impl_->bindDataChannel(channel, "remote");
    });

    impl_->setupTracks();
    spdlog::info("[WebRTC] PeerConnection reset complete");
}


bool WebRtcClient::setRemoteDescription(const std::string &sdp, const std::string &type) {
    if (!impl_->pc) {
        return false;
    }
    // Log the received SDP for debugging
    spdlog::info("[WebRTC] === SDP {} START ===", type);
    spdlog::info("{}", sdp);
    spdlog::info("[WebRTC] === SDP {} END ===", type);

    rtc::Description::Type descType = rtc::Description::Type::Offer;
    if (type == "answer") {
        descType = rtc::Description::Type::Answer;
    }
    impl_->pc->setRemoteDescription(rtc::Description(sdp, descType));
    return true;
}

std::string WebRtcClient::createOffer() {
    if (!impl_->pc) {
        return {};
    }
    impl_->localDescription.clear();
    impl_->gatheringComplete.store(false);

    spdlog::info("[WebRTC] Creating offer, waiting for ICE gathering...");
    impl_->pc->setLocalDescription(rtc::Description::Type::Offer);

    // Wait for ICE gathering to complete (up to 10 seconds)
    auto start = std::chrono::steady_clock::now();
    while (!impl_->gatheringComplete.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(10)) {
            spdlog::warn("[WebRTC] ICE gathering timeout, using partial candidates");
            break;
        }
    }

    // Get the final local description with all ICE candidates
    auto desc = impl_->pc->localDescription();
    if (desc) {
        std::string sdp = std::string(*desc);
        spdlog::info("[WebRTC] Offer created with {} bytes, gathering complete={}",
                     sdp.size(), impl_->gatheringComplete.load());
        // Log full SDP for debugging
        spdlog::info("[WebRTC] === SDP OFFER START ===");
        spdlog::info("{}", sdp);
        spdlog::info("[WebRTC] === SDP OFFER END ===");
        return sdp;
    }
    return impl_->localDescription;
}

std::string WebRtcClient::createAnswer(const std::string &offer) {
    if (!impl_->pc) {
        return {};
    }
    impl_->localDescription.clear();
    impl_->pc->setRemoteDescription(rtc::Description(offer, rtc::Description::Type::Offer));
    impl_->pc->setLocalDescription(rtc::Description::Type::Answer);
    auto start = std::chrono::steady_clock::now();
    while (impl_->localDescription.empty()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(5)) {
            break;
        }
    }
    return impl_->localDescription;
}

void WebRtcClient::addRemoteCandidate(const std::string &candidate, const std::string &mid, int mlineIndex) {
    if (!impl_->pc) {
        return;
    }
    impl_->pc->addRemoteCandidate(rtc::Candidate(candidate, mid));
}

void WebRtcClient::setIceCandidateCallback(IceCandidateCallback cb) {
    impl_->iceCallback = std::move(cb);
}

void WebRtcClient::setStateCallback(StateCallback cb) {
    impl_->stateCallback = std::move(cb);
}

void WebRtcClient::setKeyframeRequestCallback(KeyframeRequestCallback cb) {
    impl_->keyframeCallback = std::move(cb);
}

void WebRtcClient::setDataMessageCallback(DataMessageCallback cb) {
    impl_->dataMessageCallback = std::move(cb);
}

void WebRtcClient::setDataChannelStateCallback(DataChannelStateCallback cb) {
    impl_->dataChannelStateCallback = std::move(cb);
}

bool WebRtcClient::sendVideo(const EncodedVideoPacket &packet) {
    if (!impl_->videoTrack || !impl_->videoTrack->isOpen()) {
        return false;
    }
    if (packet.data.empty()) {
        return false;
    }

    // Log first packet info (with GOP=1, every frame is a keyframe)
    if (!impl_->sentFirstKeyframe.load()) {
        spdlog::info("[WebRTC] Starting video transmission, isKeyframe={}", packet.isKeyframe);
        impl_->sentFirstKeyframe.store(true);
    }

    // Update RTP timestamp from packet PTS
    // H.264 RTP uses 90kHz clock. If PTS is in 100ns units (MF timestamps), convert accordingly.
    // MF timestamps: 100ns units, so PTS / 10000 = ms, * 90 = RTP ticks
    // Or: PTS * 90 / 10000 = PTS * 9 / 1000
    uint32_t rtpTimestamp = static_cast<uint32_t>((packet.pts * 9) / 1000);
    impl_->videoRtpConfig->timestamp = rtpTimestamp;

    if (!impl_->firstVideoPacketLogged.exchange(true)) {
        spdlog::info("[WebRTC] First video packet sent: pts={}, rtpTimestamp={}, isKeyframe={}, size={}",
                     packet.pts, rtpTimestamp, packet.isKeyframe, packet.data.size());
    }

    // Send raw H264 data to the track - the media handler chain will packetize it
    rtc::binary binaryPayload = toBinary(packet.data);
    impl_->videoTrack->send(binaryPayload);

    const uint64_t packetsSent = impl_->videoPacketsSent.fetch_add(1) + 1;
    const uint64_t bytesSent = impl_->videoBytesSent.fetch_add(packet.data.size()) + packet.data.size();
    if (packetsSent % 300 == 0) {
        spdlog::info("[WebRTC] Video send heartbeat: packets={} bytes={} lastPts={} keyframe={}",
                     packetsSent, bytesSent, packet.pts, packet.isKeyframe);
    }
    return true;
}

bool WebRtcClient::sendAudio(const EncodedAudioPacket &packet) {
    if (!impl_->audioTrack || !impl_->audioTrack->isOpen()) {
        return false;
    }

    // Update RTP timestamp from packet PTS
    // Opus uses 48kHz clock. MF timestamps are in 100ns units.
    // PTS * 48000 / 10000000 = PTS * 48 / 10000 = PTS * 0.0048
    uint32_t rtpTimestamp = static_cast<uint32_t>((packet.pts * 48) / 10000);
    impl_->audioRtpConfig->timestamp = rtpTimestamp;

    // Send raw Opus data to the track - the media handler chain will packetize it
    rtc::binary binaryPayload = toBinary(packet.data);
    impl_->audioTrack->send(binaryPayload);
    return true;
}

bool WebRtcClient::sendDataMessage(const std::string &message) {
    std::shared_ptr<rtc::DataChannel> channel;
    {
        std::lock_guard<std::mutex> lock(impl_->dataChannelMutex);
        channel = impl_->sendChannel;
    }

    if (!channel || !channel->isOpen()) {
        return false;
    }
    return channel->send(message);
}

bool WebRtcClient::isDataChannelOpen() const {
    return impl_->dataChannelOpen.load();
}

bool WebRtcClient::hasActiveVideoTrack() const {
    return impl_->videoTrackOpen.load();
}

bool WebRtcClient::hasActiveAudioTrack() const {
    return impl_->audioTrackOpen.load();
}

}  // namespace versus::webrtc
