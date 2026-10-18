#include <QtTest>
#include <QFile>
#include <QProcess>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QtEndian>
#include <QElapsedTimer>
#include <csignal>
#include <cerrno>
#include <algorithm>
#include "versus/platform/macos_ffmpeg_encoder.h"
#include "versus/video/video_encoder.h"
#include "versus/video/window_capture.h"

using namespace versus::video;
class MacEncoderGate : public QObject {
    Q_OBJECT
private slots:
    void keyframePolicy_data() {
        QTest::addColumn<bool>("hardware");
        QTest::addColumn<bool>("lowLatency");
        QTest::newRow("vt-low-latency") << true << true;
        QTest::newRow("x264-low-latency") << false << true;
        QTest::newRow("vt-explicit-long-gop") << true << false;
        QTest::newRow("x264-explicit-long-gop") << false << false;
    }
    void keyframePolicy() {
        QFETCH(bool, hardware);
        QFETCH(bool, lowLatency);
        EncoderConfig config;
        config.width = 128; config.height = 72; config.frameRate = 15;
        config.gopSize = 60; config.lowLatency = lowLatency;
        config.preferredHardware = hardware ? HardwareEncoder::VideoToolbox : HardwareEncoder::None;
        config.explicitEncoderSelection = true;
        VideoEncoder encoder;
        QVERIFY(encoder.initialize(config));
        QTemporaryDir directory;
        QFile stream(directory.filePath("constant.h264"));
        QVERIFY(stream.open(QIODevice::WriteOnly));
        CapturedFrame frame;
        frame.width = 128; frame.height = 72; frame.stride = 128 * 4;
        frame.data.assign(frame.stride * frame.height, 128);
        for (int i = 0; i < 76; ++i) {
            frame.timestamp = 100000000LL + i * 10000000LL / 15;
            EncodedPacket packet;
            QVERIFY(encoder.encode(frame, packet));
            QCOMPARE(packet.pts, packet.dts);
            QCOMPARE(stream.write(reinterpret_cast<const char *>(packet.data.data()), packet.data.size()),
                     qint64(packet.data.size()));
        }
        encoder.shutdown(); stream.close();
        QProcess probe;
        probe.start(QStandardPaths::findExecutable("ffprobe"), {"-v", "error", "-show_frames",
            "-show_entries", "frame=key_frame,pict_type", "-of", "json", stream.fileName()});
        QVERIFY(probe.waitForFinished(15000)); QCOMPARE(probe.exitCode(), 0);
        const auto frames = QJsonDocument::fromJson(probe.readAllStandardOutput()).object().value("frames").toArray();
        QCOMPARE(frames.size(), 76);
        int lastKey = -1, longest = 0;
        for (int i = 0; i < frames.size(); ++i) {
            const auto decoded = frames[i].toObject();
            QVERIFY(decoded.value("pict_type").toString() != "B");
            if (decoded.value("key_frame").toInt()) {
                if (lastKey >= 0) longest = std::max(longest, i - lastKey);
                lastKey = i;
            }
            QVERIFY(lastKey >= 0);
            QVERIFY(i - lastKey < (lowLatency ? 15 : 60));
        }
        QVERIFY(longest > 0);
        QVERIFY(longest <= (lowLatency ? 15 : 60));
        if (!lowLatency) QVERIFY(longest > 15);
    }
    void encodeAndDecode_data() {
        QTest::addColumn<int>("hardware");
        QTest::addColumn<int>("codec");
        QTest::addColumn<bool>("background");
        QTest::newRow("videotoolbox-h264") << int(HardwareEncoder::VideoToolbox) << int(VideoCodec::H264) << false;
        QTest::newRow("videotoolbox-hevc") << int(HardwareEncoder::VideoToolbox) << int(VideoCodec::H265) << false;
        QTest::newRow("vp9") << int(HardwareEncoder::None) << int(VideoCodec::VP9) << false;
        QTest::newRow("av1") << int(HardwareEncoder::None) << int(VideoCodec::AV1) << false;
        QTest::newRow("av1-background") << int(HardwareEncoder::None) << int(VideoCodec::AV1) << true;
        QTest::newRow("x264") << int(HardwareEncoder::None) << int(VideoCodec::H264) << false;
    }
    void encodeAndDecode() {
        QFETCH(int, hardware);
        QFETCH(int, codec);
        QFETCH(bool, background);
        EncoderConfig config;
        config.codec = static_cast<VideoCodec>(codec);
        if (background) config.alphaBackgroundMode = AlphaBackgroundMode::Chroma;
        const bool ivf = config.codec == VideoCodec::VP9 || config.codec == VideoCodec::AV1;
        if (ivf) config.ffmpegPath = qEnvironmentVariable("VERSUS_GATE_FFMPEG").toStdString();
        config.width = 128; config.height = 72; config.frameRate = 30;
        config.bitrate = 500; config.maxBitrate = 500; config.gopSize = 60;
        config.preferredHardware = static_cast<HardwareEncoder>(hardware);
        config.explicitEncoderSelection = true;
        VideoEncoder encoder;
        QVERIFY2(encoder.initialize(config), "The explicitly selected native encoder must initialize");
        QCOMPARE(encoder.activeCodec(), config.codec);
        QCOMPARE(encoder.isHardwareEncoderActive(), config.preferredHardware == HardwareEncoder::VideoToolbox);
        QVERIFY(encoder.activeEncoderName().find(config.preferredHardware == HardwareEncoder::VideoToolbox ? "VideoToolbox" : config.codec == VideoCodec::VP9 ? "libvpx-vp9" : config.codec == VideoCodec::AV1 ? "libaom-av1" : "x264") != std::string::npos);
        QTemporaryDir temporary;
        QFile encoded(temporary.filePath(ivf ? "stream.ivf" : config.codec == VideoCodec::H265 ? "stream.hevc" : "stream.h264"));
        QVERIFY(encoded.open(QIODevice::WriteOnly));
        if (ivf) {
            QByteArray header(32, 0); header.replace(0, 4, "DKIF"); header.replace(8, 4, config.codec == VideoCodec::AV1 ? "AV01" : "VP90");
            auto *p = reinterpret_cast<uchar *>(header.data());
            qToLittleEndian<quint16>(32, p + 6); qToLittleEndian<quint16>(128, p + 12);
            qToLittleEndian<quint16>(72, p + 14); qToLittleEndian<quint32>(30, p + 16);
            qToLittleEndian<quint32>(1, p + 20); qToLittleEndian<quint32>(30, p + 24);
            encoded.write(header);
        }
        CapturedFrame frame;
        frame.width = 128; frame.height = 72; frame.stride = frame.width * 4;
        frame.data.resize(frame.stride * frame.height);
        std::vector<bool> keyframes;
        for (int i = 0; i < 30; ++i) {
            for (size_t pixel = 0; pixel < frame.data.size(); pixel += 4) {
                frame.data[pixel] = i % 2 ? 240 : 0;
                frame.data[pixel + 1] = 0;
                frame.data[pixel + 2] = i % 2 ? 0 : 240;
                // A color track retains straight RGB even for transparent
                // input; its mask is encoded separately.
                frame.data[pixel + 3] = (i % 4) * 85;
            }
            frame.timestamp = 900000000000LL + i * 10000000LL / 30;
            if (i == 10) { encoder.setBitrate(600); encoder.requestKeyframe(); }
            EncodedPacket packet;
            QVERIFY2(encoder.encodeWithSourceTimestamp(frame, packet, 10000 + i), qPrintable(QString("Frame %1 failed with kind %2").arg(i).arg(static_cast<int>(encoder.lastEncodeFailureKind()))));
            QCOMPARE(packet.sourceTimestamp, int64_t(10000 + i));
            QCOMPARE(packet.pts, frame.timestamp);
            QCOMPARE(packet.codec, config.codec);
            if (config.codec == VideoCodec::H264)
                QCOMPARE(packet.isKeyframe, detail::h264AccessUnitIsKeyframe(packet.data, detail::H264BitstreamFormat::AnnexB));
            else if (ivf) QCOMPARE(packet.isKeyframe, detail::ivfFrameIsKeyframe(config.codec, packet.data));
            else {
                bool irap = false, vps = false, sps = false, pps = false;
                for (size_t n = 0; n + 5 < packet.data.size(); ++n) {
                    if (packet.data[n] || packet.data[n+1] || packet.data[n+2] || packet.data[n+3] != 1) continue;
                    const int type = (packet.data[n+4] >> 1) & 63;
                    irap |= type >= 16 && type <= 23;
                    vps |= type == 32; sps |= type == 33; pps |= type == 34;
                }
                QCOMPARE(packet.isKeyframe, irap);
                if (packet.isKeyframe) QVERIFY(vps && sps && pps);
            }
            if (i == 0 || i == 10) QVERIFY(packet.isKeyframe);
            keyframes.push_back(packet.isKeyframe);
            if (ivf) {
                QByteArray header(12, 0); auto *p = reinterpret_cast<uchar *>(header.data());
                qToLittleEndian<quint32>(packet.data.size(), p); qToLittleEndian<quint64>(i, p + 4);
                encoded.write(header);
            }
            QCOMPARE(encoded.write(reinterpret_cast<const char *>(packet.data.data()), packet.data.size()), qint64(packet.data.size()));
        }
        encoded.close();
        QProcess probe;
        const QString ffprobe = QStandardPaths::findExecutable("ffprobe");
        QVERIFY2(!ffprobe.isEmpty(), "FFprobe is required for the independent color metadata gate");
        probe.start(ffprobe, {"-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=color_space,color_range,color_transfer,color_primaries:frame=key_frame", "-of", "json", encoded.fileName()});
        QVERIFY(probe.waitForFinished(10000)); QCOMPARE(probe.exitCode(), 0);
        const auto decodedInfo = QJsonDocument::fromJson(probe.readAllStandardOutput()).object();
        const auto streams = decodedInfo.value("streams").toArray();
        QCOMPARE(streams.size(), 1); const auto metadata = streams.first().toObject();
        const auto matrix = metadata.value("color_space").toString();
        QVERIFY(matrix == "smpte170m" || (config.codec == VideoCodec::VP9 && matrix == "bt470bg"));
        QCOMPARE(metadata.value("color_range").toString(), QString("tv"));
        if (config.codec != VideoCodec::VP9) {
            QCOMPARE(metadata.value("color_primaries").toString(), QString("bt709"));
            QCOMPARE(metadata.value("color_transfer").toString(), QString("iec61966-2-1"));
        }
        if (config.codec == VideoCodec::AV1) {
            const auto frames = decodedInfo.value("frames").toArray();
            QCOMPARE(frames.size(), 30);
            for (int i = 0; i < frames.size(); ++i)
                QCOMPARE(frames[i].toObject().value("key_frame").toInt() != 0, keyframes[i]);
            QVERIFY(std::count(keyframes.begin(), keyframes.end(), false) > 0);
        }
        encoder.shutdown();
        QVERIFY(!encoder.isHardwareEncoderActive());
        QVERIFY(encoder.initialize(config));
        EncodedPacket restarted;
        QVERIFY(encoder.encode(frame, restarted));
        QVERIFY(restarted.isKeyframe);
        encoder.shutdown();

        const QString ffmpeg = QStandardPaths::findExecutable("ffmpeg");
        QVERIFY2(!ffmpeg.isEmpty(), "Install FFmpeg for the independent decode gate");
        QProcess decoder;
        decoder.start(ffmpeg, {"-v", "error", "-i", encoded.fileName(), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"});
        QVERIFY(decoder.waitForFinished(15000));
        const auto errors = decoder.readAllStandardError();
        QCOMPARE(decoder.exitStatus(), QProcess::NormalExit);
        QVERIFY2(decoder.exitCode() == 0, errors.constData());
        const auto rgb = decoder.readAllStandardOutput();
        QCOMPARE(rgb.size(), qsizetype(128 * 72 * 3 * 30));
        // Independent decode checks every frame's red/blue identity and range,
        // not just the presence of output bytes or a valid H.264 header.
        for (int i = 0; i < 30; ++i) {
            const auto *pixel = reinterpret_cast<const unsigned char *>(rgb.constData()) + (i * 128 * 72 + 36 * 128 + 64) * 3;
            QVERIFY(std::abs(int(pixel[i % 2 ? 2 : 0]) - 240) <= 12);
            QVERIFY(pixel[1] <= 12);
            QVERIFY(pixel[i % 2 ? 0 : 2] <= 12);
        }
    }
    void protectedVp9AlphaRange() {
        EncoderConfig config;
        config.codec = VideoCodec::VP9; config.width = 128; config.height = 72;
        config.frameRate = 30; config.bitrate = 1000;
        config.preferredHardware = HardwareEncoder::None; config.explicitEncoderSelection = true;
        config.ffmpegPath = qEnvironmentVariable("VERSUS_GATE_FFMPEG").toStdString();
        config.enableAlpha = true; config.requireEveryFrameKeyframe = true;
        config.ffmpegOptions = "-g 120 -lag-in-frames 25 -auto-alt-ref 1 -c:v libx264";
        VideoEncoder encoder; QVERIFY(encoder.initialize(config));
        QTemporaryDir temporary; QFile encoded(temporary.filePath("alpha.ivf"));
        QVERIFY(encoded.open(QIODevice::WriteOnly));
        QByteArray header(32, 0); header.replace(0,4,"DKIF"); header.replace(8,4,"VP90");
        auto *p = reinterpret_cast<uchar *>(header.data());
        qToLittleEndian<quint16>(32,p+6); qToLittleEndian<quint16>(128,p+12);
        qToLittleEndian<quint16>(72,p+14); qToLittleEndian<quint32>(30,p+16);
        qToLittleEndian<quint32>(1,p+20); qToLittleEndian<quint32>(8,p+24); encoded.write(header);
        CapturedFrame frame; frame.format = CapturedFrame::Format::Gray;
        frame.width = 128; frame.height = 72; frame.stride = 144;
        frame.data.resize(frame.stride * frame.height, 123);
        for (int i=0;i<8;++i) {
            for (int y=0;y<72;++y) for (int x=0;x<128;++x)
                frame.data[y*frame.stride+x] = ((x/32+i)%4)*85;
            frame.timestamp = 1000000 + i*333333;
            if (i==4) { encoder.setBitrate(1200); encoder.requestKeyframe(); }
            EncodedPacket packet; QVERIFY(encoder.encodeWithSourceTimestamp(frame,packet,500+i));
            QCOMPARE(packet.codec,VideoCodec::VP9); QCOMPARE(packet.sourceTimestamp,int64_t(500+i));
            QVERIFY(packet.isKeyframe); QVERIFY(detail::vp9FrameIsKeyframe(packet.data));
            QByteArray record(12,0); auto *r=reinterpret_cast<uchar *>(record.data());
            qToLittleEndian<quint32>(packet.data.size(),r); qToLittleEndian<quint64>(i,r+4);
            encoded.write(record); encoded.write(reinterpret_cast<const char *>(packet.data.data()),packet.data.size());
        }
        encoded.close(); encoder.shutdown();
        QProcess decoder; decoder.start(QStandardPaths::findExecutable("ffmpeg"),
            {"-v","error","-i",encoded.fileName(),"-f","rawvideo","-pix_fmt","gray","pipe:1"});
        QVERIFY(decoder.waitForFinished(15000)); QCOMPARE(decoder.exitCode(),0);
        const auto gray=decoder.readAllStandardOutput(); QCOMPARE(gray.size(),qsizetype(128*72*8));
        for (int i=0;i<8;++i) for(int stripe=0;stripe<4;++stripe) {
            const int actual=static_cast<uchar>(gray[(i*72+36)*128+stripe*32+16]);
            QVERIFY2(std::abs(actual-((stripe+i)%4)*85)<=5,qPrintable(QString("alpha %1").arg(actual)));
        }
    }
    void vp9FailureQuarantinesGeneration_data() {
        QTest::addColumn<QByteArray>("behavior"); QTest::addColumn<int>("expected"); QTest::addColumn<int>("codec");
        for (auto codec : {VideoCodec::VP9, VideoCodec::AV1}) {
            const QByteArray name = codec == VideoCodec::AV1 ? "av1-" : "vp9-";
            QTest::newRow((name+"stalled").constData()) << QByteArray("exec /bin/sleep 60\n") << int(EncodeFailureKind::Timeout) << int(codec);
            QTest::newRow((name+"exited").constData()) << QByteArray("exit 9\n") << int(EncodeFailureKind::ProcessExited) << int(codec);
            QTest::newRow((name+"malformed").constData()) << QByteArray("printf 'invalid_header_01234567890123456789'; exec /bin/sleep 60\n") << int(EncodeFailureKind::InvalidInput) << int(codec);
        }
    }
    void vp9FailureQuarantinesGeneration() {
        QFETCH(QByteArray,behavior); QFETCH(int,expected); QFETCH(int,codec);
        QTemporaryDir directory; QFile helper(directory.filePath("ffmpeg"));
        QVERIFY(helper.open(QIODevice::WriteOnly));
        helper.write("#!/bin/sh\ncase \"$2\" in\n-version) printf 'ffmpeg version fixture\\nconfiguration: --enable-version3\\n'; exit 0;;\n-encoders) printf ' V..... libvpx-vp9\\n V..... libaom-av1\\n'; exit 0;;\nesac\nprintf '%s\\n' \"$$\" > \"${0}.pid\"\n" + behavior);
        helper.close(); QVERIFY(helper.setPermissions(QFileDevice::ReadOwner|QFileDevice::WriteOwner|QFileDevice::ExeOwner));
        EncoderConfig config; config.codec=static_cast<VideoCodec>(codec); config.width=128; config.height=72;
        config.frameRate=30; config.preferredHardware=HardwareEncoder::None; config.explicitEncoderSelection=true;
        config.ffmpegPath=helper.fileName().toStdString();
        versus::platform::MacFfmpegEncoder encoder; QVERIFY(encoder.initialize(config));
        CapturedFrame frame; frame.width=128; frame.height=72; frame.stride=512;
        frame.data.resize(frame.stride*frame.height,255); EncodedPacket packet;
        QElapsedTimer timer; timer.start(); QVERIFY(!encoder.encode(frame,packet,123));
        QCOMPARE(encoder.lastFailure(),static_cast<EncodeFailureKind>(expected)); QVERIFY(timer.elapsed()<3000);
        QVERIFY(packet.data.empty()); QVERIFY(!encoder.encode(frame,packet,124));
        encoder.shutdown();
        QFile pidFile(helper.fileName()+".pid"); QVERIFY(pidFile.open(QIODevice::ReadOnly));
        const auto pid=pidFile.readAll().trimmed().toLongLong(); QVERIFY(pid>1);
        QTRY_VERIFY_WITH_TIMEOUT(::kill(static_cast<pid_t>(pid),0)==-1 && errno==ESRCH,2000);
    }
    void strictSelectionAndInvalidInput() {
        VideoEncoder encoder;
        EncoderConfig config;
        config.explicitEncoderSelection = true;
        config.preferredHardware = HardwareEncoder::NVENC;
        QVERIFY(!encoder.initialize(config));
        config.preferredHardware = HardwareEncoder::None;
        config.codec = VideoCodec::H265;
        QVERIFY(!encoder.initialize(config));
        config.codec = VideoCodec::AV1;
        config.preferredHardware = HardwareEncoder::VideoToolbox;
        QVERIFY(!encoder.initialize(config));
        config.preferredHardware = HardwareEncoder::None;
        config.enableAlpha = true;
        QVERIFY(!encoder.initialize(config));
        config.enableAlpha = false;
        config.codec = VideoCodec::H264;
        config.width = 128; config.height = 72;
        QVERIFY(encoder.initialize(config));
        CapturedFrame invalid;
        invalid.width = 128; invalid.height = 72; invalid.stride = 512;
        EncodedPacket packet;
        QVERIFY(!encoder.encode(invalid, packet));
        QCOMPARE(encoder.lastEncodeFailureKind(), EncodeFailureKind::InvalidInput);
    }
    void hevcAutoUsesHardware() {
        VideoEncoder encoder;
        EncoderConfig config;
        config.width = 128; config.height = 72; config.frameRate = 30;
        config.codec = VideoCodec::H265;
        config.explicitEncoderSelection = false;
        QVERIFY(encoder.initialize(config));
        QCOMPARE(encoder.activeCodec(), VideoCodec::H265);
        QVERIFY(encoder.isHardwareEncoderActive());
        QVERIFY(encoder.activeEncoderName().find("VideoToolbox H.265") != std::string::npos);
    }
};
QTEST_MAIN(MacEncoderGate)
#include "test_macos_encoder.moc"
