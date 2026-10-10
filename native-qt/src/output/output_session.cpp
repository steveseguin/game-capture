#include "versus/output/output_session.h"
#include "matroska_stream.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFileInfo>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRegularExpression>
#include <QTimer>
#include <QUrl>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#endif

namespace versus::output {
namespace {
using Clock = std::chrono::steady_clock;
constexpr size_t kMaximumQueueBytes = 8 * 1024 * 1024;
constexpr int64_t kMaximumQueueAge100ns = 10000000;
struct OutputError : std::runtime_error {
    bool permanent;
    OutputError(const char *message, bool permanent = false) : std::runtime_error(message), permanent(permanent) {}
};
struct Packet {
    enum class Kind { Video, Opus, Pcm } kind;
    QByteArray data;
    int64_t pts = 0;
    int width = 0, height = 0;
    bool keyframe = false;
};
bool sameOrigin(const QUrl &a, const QUrl &b) {
    return a.scheme() == b.scheme() && a.host().compare(b.host(), Qt::CaseInsensitive) == 0 &&
        a.port(a.scheme() == "https" ? 443 : 80) == b.port(b.scheme() == "https" ? 443 : 80);
}
bool allowedHttpUrl(const QUrl &url) {
    return url.isValid() && !url.host().isEmpty() && url.userInfo().isEmpty() && !url.hasFragment() &&
        (url.scheme() == "http" || url.scheme() == "https");
}
struct HttpResult {
    int status = 0;
    bool oversized = false;
    QByteArray body, contentType, links;
    QUrl url, location;
    QNetworkReply::NetworkError networkError = QNetworkReply::NoError;
};

std::vector<webrtc::IceServerConfig> iceServers(const QByteArray &links) {
    std::vector<webrtc::IceServerConfig> result;
    const QString text = QString::fromUtf8(links);
    auto matches = QRegularExpression("<([^>]+)>([^<]*)").globalMatch(text);
    while (matches.hasNext() && result.size() < 16) {
        const auto match = matches.next();
        const auto attributes = match.captured(2);
        const auto attribute = [&](const QString &name) {
            const auto pattern = QString("(?:^|;)\\s*%1\\s*=\\s*(?:\"((?:\\\\.|[^\"])*)\"|([^\\s;,]+))").arg(name);
            const auto parsed = QRegularExpression(pattern, QRegularExpression::CaseInsensitiveOption).match(attributes);
            auto value = parsed.captured(1).isNull() ? parsed.captured(2) : parsed.captured(1);
            value.replace(QRegularExpression("\\\\(.)"), "\\1");
            return value;
        };
        if (!attribute("rel").toLower().split(QRegularExpression("\\s+")).contains("ice-server")) continue;
        const auto url = match.captured(1);
        if (!url.startsWith("stun:") && !url.startsWith("stuns:") &&
            !url.startsWith("turn:") && !url.startsWith("turns:")) continue;
        result.push_back({url.toStdString(), attribute("username").toStdString(),
                          attribute("credential").toStdString(), !url.contains("transport=tcp")});
    }
    return result;
}
} // namespace

struct Session::Impl {
    Config config;
    MediaConfig media;
    std::function<void()> requestKeyframe;
    std::atomic<bool> stopping{true}, restartRequested{false};
    std::thread worker;
    mutable std::mutex mutex;
    std::condition_variable ready;
    std::deque<Packet> queue;
    size_t queuedBytes = 0;
    Status current;
    std::vector<webrtc::IceServerConfig> cachedIceServers;

    Impl(Config config, MediaConfig media, std::function<void()> request)
        : config(std::move(config)), media(std::move(media)), requestKeyframe(std::move(request)) {}

    void setState(State state, const std::string &message) {
        std::lock_guard lock(mutex);
        current.state = state; current.message = message;
    }
    void clearQueue() {
        std::lock_guard lock(mutex);
        queue.clear(); queuedBytes = 0;
    }
    bool push(Packet packet) {
        if (stopping.load() || packet.data.isEmpty()) return false;
        std::lock_guard lock(mutex);
        if (current.state == State::Error) return false;
        if (queuedBytes + size_t(packet.data.size()) > kMaximumQueueBytes ||
            (!queue.empty() && packet.pts - queue.front().pts > kMaximumQueueAge100ns)) {
            queue.clear(); queuedBytes = 0;
            restartRequested.store(true);
            ready.notify_one();
            return false;
        }
        queuedBytes += size_t(packet.data.size()); queue.push_back(std::move(packet));
        ready.notify_one();
        return true;
    }
    bool pop(Packet &packet, int timeoutMs = 10) {
        std::unique_lock lock(mutex);
        ready.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] {
            return stopping.load() || restartRequested.load() || !queue.empty();
        });
        if (stopping.load()) return false;
        if (restartRequested.load()) throw OutputError("Output stalled; reconnecting with fresh media.");
        if (queue.empty()) return false;
        packet = std::move(queue.front()); queue.pop_front(); queuedBytes -= size_t(packet.data.size());
        return true;
    }
    void count(const Packet &packet) {
        std::lock_guard lock(mutex);
        if (packet.kind == Packet::Kind::Video) { ++current.videoPackets; current.videoBytes += packet.data.size(); }
        else { ++current.audioPackets; current.audioBytes += packet.data.size(); }
    }
    bool pause(int milliseconds) {
        std::unique_lock lock(mutex);
        ready.wait_for(lock, std::chrono::milliseconds(milliseconds), [&] { return stopping.load(); });
        return !stopping.load();
    }

    HttpResult http(QNetworkAccessManager &network, QByteArray method, QUrl url,
                    const QByteArray &body, const QUrl &credentialOrigin, bool cleanup = false) {
        const auto started = Clock::now();
        for (int redirects = 0; redirects <= 5; ++redirects) {
            if (!allowedHttpUrl(url)) throw OutputError("WHIP returned an invalid HTTP destination.", true);
            QNetworkRequest request(url);
            request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
            request.setHeader(QNetworkRequest::ContentTypeHeader, "application/sdp");
            request.setRawHeader("Accept", "application/sdp");
            if (!config.bearerToken.empty() && sameOrigin(url, credentialOrigin))
                request.setRawHeader("Authorization", "Bearer " + QByteArray::fromStdString(config.bearerToken));
            auto *reply = network.sendCustomRequest(request, method, body);
            reply->setReadBufferSize(1024 * 1024 + 1);
            QEventLoop loop;
            QTimer timer; timer.setInterval(25);
            QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
            QObject::connect(&timer, &QTimer::timeout, &loop, [&] {
                if ((!cleanup && stopping.load()) ||
                    Clock::now() - started > std::chrono::milliseconds(cleanup ? 1500 : 10000) ||
                    reply->bytesAvailable() > 1024 * 1024) { reply->abort(); loop.quit(); }
            });
            timer.start();
            if (!reply->isFinished()) loop.exec();
            timer.stop();
            HttpResult result;
            result.status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            result.networkError = reply->error();
            result.body = reply->readAll(); result.url = url;
            result.contentType = reply->rawHeader("Content-Type");
            result.location = url.resolved(QUrl(QString::fromUtf8(reply->rawHeader("Location"))));
            if (!reply->hasRawHeader("Location")) result.location = {};
            for (const auto &header : reply->rawHeaderPairs())
                if (header.first.toLower() == "link") result.links += header.second + ',';
            delete reply;
            result.oversized = result.body.size() > 1024 * 1024;
            if (result.oversized) return result;
            if ((result.status == 307 || result.status == 308) && method != "DELETE") {
                if (url.scheme() == "https" && result.location.scheme() != "https")
                    throw OutputError("WHIP refused a redirect from HTTPS to an insecure endpoint.", true);
                url = result.location;
                continue;
            }
            return result;
        }
        throw OutputError("WHIP exceeded the redirect limit.", true);
    }

    void runWhip() {
        QEventLoop dispatcher;
        QNetworkAccessManager network;
        const QUrl endpoint(QString::fromStdString(config.url));
        QUrl resource, resourceCredentialOrigin = endpoint;
        webrtc::WebRtcClient client;
        auto cleanup = [&] {
            client.prepareForShutdown(); client.shutdown();
            if (!resource.isEmpty()) {
                try { http(network, "DELETE", resource, {}, resourceCredentialOrigin, true); } catch (...) {}
                resource = {};
            }
        };
        try {
            const auto options = http(network, "OPTIONS", endpoint, {}, endpoint);
            if (stopping.load()) return;
            if (options.oversized) throw OutputError("WHIP response exceeded the size limit.", true);
            webrtc::PeerConfig peer;
            peer.enableDataChannel = false; peer.initialVideo = true; peer.initialAudio = media.audioEnabled;
            peer.audioChannels = media.audioChannels;
            peer.videoWidth = media.width; peer.videoHeight = media.height; peer.videoFps = media.fps;
            peer.iceServers = iceServers(options.links);
            if (peer.iceServers.empty()) peer.iceServers = cachedIceServers;
            client.setKeyframeRequestCallback([this](uint64_t) { if (!stopping.load()) requestKeyframe(); });
            if (!client.initialize(peer) || client.createOffer().empty()) throw OutputError("WHIP could not create a WebRTC offer.");
            const auto gatheringStart = Clock::now();
            while (!stopping.load() && !client.iceGatheringComplete()) {
                if (Clock::now() - gatheringStart > std::chrono::seconds(10)) throw OutputError("WHIP ICE gathering timed out.");
                pause(25);
            }
            if (stopping.load()) { cleanup(); return; }
            // libdatachannel supports only multiplexed RTP/RTCP. Advertise the
            // stricter WHIP requirement without altering ordinary VDO offers.
            auto offer = QByteArray::fromStdString(client.localDescriptionWithCandidates());
            offer.replace("a=rtcp-mux\r\n", "a=rtcp-mux\r\na=rtcp-mux-only\r\n");
            const auto answer = http(network, "POST", endpoint, offer, endpoint);
            if (answer.status == 201) resource = answer.location;
            if (answer.oversized) throw OutputError("WHIP response exceeded the size limit.", true);
            if (answer.status == 401 || answer.status == 403) throw OutputError("WHIP authentication failed. Check the endpoint and bearer token.", true);
            if (answer.status == 404) throw OutputError("WHIP endpoint was not found. Check the complete endpoint URL.", true);
            if (answer.status == 400 || answer.status == 422) throw OutputError("WHIP server rejected H.264/Opus negotiation.", true);
            if (answer.networkError == QNetworkReply::SslHandshakeFailedError)
                throw OutputError("WHIP TLS certificate validation failed.", true);
            if (stopping.load()) { cleanup(); return; }
            if (answer.status != 201) throw OutputError("WHIP connection failed. Check the endpoint and network.");
            // Servers may advertise TURN only on the first successful POST.
            // Keep those credentials for a fresh session if direct ICE fails.
            const auto advertisedServers = iceServers(answer.links);
            if (!advertisedServers.empty()) cachedIceServers = advertisedServers;
            if (resource.isEmpty() || !allowedHttpUrl(resource) ||
                (answer.url.scheme() == "https" && resource.scheme() != "https"))
                throw OutputError("WHIP did not return a valid secure session location.", true);
            // A resource on another origin receives no bearer credential. The
            // server can use an opaque signed session URL for that resource.
            if (!answer.contentType.toLower().startsWith("application/sdp") ||
                !client.setRemoteDescription(answer.body.toStdString(), "answer"))
                throw OutputError("WHIP returned an invalid SDP answer.", true);
            const auto connectStart = Clock::now();
            while (!stopping.load() && (!client.hasActiveVideoTrack() || (media.audioEnabled && !client.hasActiveAudioTrack()))) {
                if (client.connectionState() == webrtc::ConnectionState::Failed ||
                    Clock::now() - connectStart > std::chrono::seconds(15)) throw OutputError("WHIP media connection timed out.");
                pause(25);
            }
            clearQueue(); restartRequested.store(false); requestKeyframe();
            if (!stopping.load()) setState(State::Live, "Publishing to " + destinationLabel(config));
            bool haveKeyframe = false;
            while (!stopping.load()) {
                const auto state = client.connectionState();
                if (state == webrtc::ConnectionState::Failed || state == webrtc::ConnectionState::Closed || state == webrtc::ConnectionState::Disconnected)
                    throw OutputError("WHIP connection was lost.");
                Packet packet;
                if (!pop(packet)) continue;
                bool sent = false;
                const std::vector<uint8_t> data(packet.data.begin(), packet.data.end());
                if (packet.kind == Packet::Kind::Video) {
                    if (!haveKeyframe && !packet.keyframe) continue;
                    sent = client.sendVideo({data, packet.pts, packet.keyframe});
                    if (sent && packet.keyframe) haveKeyframe = true;
                } else if (packet.kind == Packet::Kind::Opus) {
                    size_t bytes = 0;
                    sent = client.sendAudio({data, packet.pts, 48000, uint16_t(media.audioChannels), false}, &bytes);
                    if (!bytes) continue;
                }
                if (!sent) throw OutputError("WHIP media send failed.");
                count(packet);
            }
            cleanup();
        } catch (...) { cleanup(); throw; }
    }

    void runMux() {
        QProcess process;
#ifdef _WIN32
        process.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *args) {
            args->flags |= CREATE_NO_WINDOW;
        });
#endif
        const auto cleanup = [&] {
            if (process.state() != QProcess::NotRunning) {
                process.closeWriteChannel();
                if (!process.waitForFinished(2500)) {
                    process.kill(); process.waitForFinished(1000);
                }
            }
            std::lock_guard lock(mutex); current.processId = 0;
        };
        try {
            requestKeyframe();
            Packet first;
            std::deque<Packet> initialAudio;
            std::vector<QByteArray> units;
            QByteArray codec;
            const auto keyframeStart = Clock::now();
            while (!stopping.load()) {
                if (Clock::now() - keyframeStart > std::chrono::seconds(10)) throw OutputError("Output did not receive an H.264 keyframe.");
                if (!pop(first)) continue;
                if (first.kind == Packet::Kind::Pcm) {
                    initialAudio.push_back(first);
                    while (initialAudio.size() > 30) initialAudio.pop_front();
                } else if (first.kind == Packet::Kind::Video && first.keyframe) {
                    units = detail::MatroskaStream::nals(std::vector<uint8_t>(first.data.begin(), first.data.end()));
                    codec = detail::MatroskaStream::codecPrivate(units);
                    if (!codec.isEmpty()) break;
                }
            }
            if (stopping.load()) return;
            while (!initialAudio.empty() && initialAudio.front().pts < first.pts - 2000000) initialAudio.pop_front();
            int64_t epoch = first.pts;
            if (!initialAudio.empty()) epoch = std::min(epoch, initialAudio.front().pts);
            QStringList args{"-hide_banner", "-loglevel", "error", "-nostdin", "-probesize", "65536", "-analyzeduration", "100000",
                "-f", "matroska", "-i", "pipe:0", "-map", "0:v:0", "-c:v", "copy"};
            if (media.audioEnabled) args << "-map" << "0:a:0" << "-c:a" << "aac" << "-b:a"
                << QString::number(config.aacBitrateKbps) + 'k' << "-ar" << "48000" << "-ac" << QString::number(media.audioChannels);
            else args << "-an";
            args << "-max_interleave_delta" << "100000" << "-flush_packets" << "1" << "-stats_period" << "0.5"
                 << "-progress" << "pipe:1" << "-rw_timeout" << "5000000";
            if (config.protocol == Protocol::Srt) args << "-f" << "mpegts" << "-mpegts_flags" << "+resend_headers" << "-muxdelay" << "0" << "-muxpreload" << "0";
            else {
                args << "-f" << "flv" << "-flvflags" << "no_duration_filesize";
                if (QUrl(QString::fromStdString(config.url)).scheme() == "rtmps") args << "-tls_verify" << "1";
            }
            args << QString::fromStdString(destinationUrl(config));
            process.start(QString::fromStdString(media.ffmpegPath), args, QIODevice::ReadWrite);
            if (!process.waitForStarted(2000)) throw OutputError("Output FFmpeg could not start. Check the FFmpeg path.", true);
            { std::lock_guard lock(mutex); current.processId = process.processId(); }
            detail::MatroskaStream mux;
            auto write = [&](const QByteArray &data) {
                if (process.state() == QProcess::NotRunning) throw OutputError("Output connection closed. Check server availability and credentials.");
                if (process.bytesToWrite() + data.size() > qint64(kMaximumQueueBytes)) throw OutputError("Output connection cannot keep up with the selected bitrate.");
                if (process.write(data) != data.size()) throw OutputError("Output FFmpeg input failed.");
                process.waitForBytesWritten(5);
                // FFmpeg can echo full output URLs on failure. Keep stderr out
                // of application logs and drain it to prevent buffer growth.
                process.readAllStandardError();
            };
            write(mux.header(codec, first.width, first.height, media.fps, media.audioChannels, media.audioEnabled));
            for (const auto &audio : initialAudio) { write(mux.audio(audio.data, audio.pts - epoch)); count(audio); }
            write(mux.video(units, first.pts - epoch, true)); count(first);
            auto lastProgress = Clock::now();
            qint64 lastFrame = 0, lastOutputTime = -1;
            QByteArray progress;
            while (!stopping.load()) {
                // This worker has no Qt event loop. Pump the child's output
                // explicitly, including when the input pipe drains instantly.
                process.waitForReadyRead(1);
                progress += process.readAllStandardOutput();
                if (progress.size() > 65536) throw OutputError("Output FFmpeg returned excessive progress data.");
                for (qsizetype end; (end = progress.indexOf('\n')) >= 0;) {
                    const auto line = progress.left(end).trimmed(); progress.remove(0, end + 1);
                    bool advanced = false;
                    if (line.startsWith("frame=")) {
                        const auto frame = line.mid(6).toLongLong();
                        advanced = frame > lastFrame; lastFrame = std::max(lastFrame, frame);
                    } else if (line.startsWith("out_time_us=")) {
                        bool valid = false;
                        const auto time = line.mid(12).toLongLong(&valid);
                        advanced = valid && time > lastOutputTime && lastFrame > 0;
                        if (valid) lastOutputTime = std::max(lastOutputTime, time);
                    }
                    if (advanced) {
                        lastProgress = Clock::now();
                        setState(State::Live, "Publishing to " + destinationLabel(config));
                    }
                }
                if (Clock::now() - lastProgress > std::chrono::seconds(10)) throw OutputError("Output stopped making progress.");
                process.readAllStandardError();
                if (process.state() == QProcess::NotRunning) throw OutputError("Output connection closed. Check server availability and credentials.");
                Packet packet;
                if (!pop(packet)) { process.waitForBytesWritten(5); continue; }
                if (packet.kind == Packet::Kind::Video) {
                    if (packet.width != first.width || packet.height != first.height) throw OutputError("Source size changed; reconnecting output.");
                    units = detail::MatroskaStream::nals(std::vector<uint8_t>(packet.data.begin(), packet.data.end()));
                    const auto nextCodec = detail::MatroskaStream::codecPrivate(units);
                    if (!nextCodec.isEmpty() && nextCodec != codec) throw OutputError("Video configuration changed; reconnecting output.");
                    write(mux.video(units, packet.pts - epoch, packet.keyframe));
                } else if (packet.kind == Packet::Kind::Pcm) write(mux.audio(packet.data, packet.pts - epoch));
                else continue;
                count(packet);
            }
            cleanup();
        } catch (...) { cleanup(); throw; }
    }

    void run() {
        int attempt = 0;
        while (!stopping.load()) {
            clearQueue(); restartRequested.store(false);
            setState(attempt ? State::Reconnecting : State::Connecting,
                     std::string(attempt ? "Reconnecting to " : "Connecting to ") + destinationLabel(config));
            try {
                if (config.protocol == Protocol::Whip) runWhip(); else runMux();
            } catch (const OutputError &error) {
                if (stopping.load()) break;
                if (error.permanent) { setState(State::Error, error.what()); clearQueue(); return; }
                setState(State::Reconnecting, error.what());
            } catch (...) {
                if (stopping.load()) break;
                // Library exception messages may contain a destination URL.
                setState(State::Reconnecting, "Output failed; reconnecting with fresh media.");
            }
            if (stopping.load()) break;
            { std::lock_guard lock(mutex); ++current.reconnects; }
            ++attempt; clearQueue();
            if (!pause(std::min(attempt, 5) * 1000)) break;
        }
        clearQueue(); setState(State::Stopped, "Output stopped");
    }
};

Session::Session(Config config, MediaConfig media, std::function<void()> requestKeyframe)
    : impl_(std::make_unique<Impl>(std::move(config), std::move(media), std::move(requestKeyframe))) {}
Session::~Session() { stop(); }
bool Session::start() {
    const auto error = validateConfig(impl_->config);
    if (!error.empty()) { impl_->setState(State::Error, error); return false; }
    if (impl_->config.protocol == Protocol::VdoNinja) return false;
    if (usesPcmInput() && !QFileInfo::exists(QString::fromStdString(impl_->media.ffmpegPath))) {
        impl_->setState(State::Error, "Output FFmpeg is unavailable."); return false;
    }
    if (!impl_->stopping.exchange(false)) return true;
    impl_->setState(State::Connecting, "Connecting to " + destinationLabel(impl_->config));
    impl_->worker = std::thread([this] { impl_->run(); });
    return true;
}
void Session::stop() {
    impl_->stopping.store(true); impl_->ready.notify_all();
    if (impl_->worker.joinable()) impl_->worker.join();
}
bool Session::wantsVideo() const {
    std::lock_guard lock(impl_->mutex);
    return !impl_->stopping.load() && impl_->current.state != State::Error;
}
bool Session::wantsAudio() const { return impl_->media.audioEnabled && wantsVideo(); }
bool Session::usesPcmInput() const { return impl_->config.protocol == Protocol::Rtmp || impl_->config.protocol == Protocol::Srt; }
bool Session::sendVideo(const webrtc::EncodedVideoPacket &packet, int width, int height) {
    return impl_->push({Packet::Kind::Video, QByteArray(reinterpret_cast<const char *>(packet.data.data()), packet.data.size()),
                        packet.pts, width, height, packet.isKeyframe});
}
bool Session::sendOpus(const webrtc::EncodedAudioPacket &packet) {
    if (usesPcmInput() || packet.pcm) return false;
    return impl_->push({Packet::Kind::Opus, QByteArray(reinterpret_cast<const char *>(packet.data.data()), packet.data.size()), packet.pts});
}
bool Session::sendPcm(const std::vector<float> &stereo48k, int64_t pts) {
    if (!usesPcmInput() || !impl_->media.audioEnabled) return false;
    QByteArray bytes;
    if (impl_->media.audioChannels == 1) {
        std::vector<float> mono(stereo48k.size() / 2);
        for (size_t i = 0; i < mono.size(); ++i) mono[i] = (stereo48k[i * 2] + stereo48k[i * 2 + 1]) * 0.5f;
        bytes = QByteArray(reinterpret_cast<const char *>(mono.data()), mono.size() * sizeof(float));
    } else bytes = QByteArray(reinterpret_cast<const char *>(stereo48k.data()), stereo48k.size() * sizeof(float));
    return impl_->push({Packet::Kind::Pcm, std::move(bytes), pts});
}
Status Session::status() const {
    std::lock_guard lock(impl_->mutex);
    auto status = impl_->current; status.queuedBytes = impl_->queuedBytes;
    return status;
}
} // namespace versus::output
