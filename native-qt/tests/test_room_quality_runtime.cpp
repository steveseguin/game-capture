#include <QtTest/QtTest>

#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "versus/app/versus_app.h"

namespace versus::app {

class VersusAppTestAccess {
  public:
    using OpaquePeer = std::shared_ptr<void>;

    static void setRoomQualityContext(VersusApp &app,
                                      bool roomMode,
                                      bool requested) {
        {
            std::lock_guard<std::mutex> lock(app.lifecycleStateMutex_);
            app.room_ = roomMode ? "room-quality-regression" : std::string{};
            app.startOptions_.room = app.room_;
            app.startOptions_.roomModeLqEnabled = requested;
        }
    }

    static void setRoomQualityRequested(VersusApp &app, bool requested) {
        {
            std::lock_guard<std::mutex> lock(app.lifecycleStateMutex_);
            app.startOptions_.roomModeLqEnabled = requested;
        }
    }

    static bool enforceRoomQualityCompatibility(VersusApp &app) {
        app.syncRoomQualityDecision();
        return true;
    }

    static video::EncoderConfig configuredVideo(VersusApp &app) {
        std::lock_guard<std::mutex> lock(app.videoSendMutex_);
        return app.videoConfig_;
    }

    static StreamTier initializeRoomPeer(VersusApp &app,
                                         PeerRole role,
                                         int requestedVideoBitrateKbps) {
        auto peer = std::make_shared<VersusApp::PeerSession>();
        peer->roomMode = true;
        peer->requestedVideoBitrateKbps.store(
            requestedVideoBitrateKbps,
            std::memory_order_relaxed);
        app.applyPeerInitState(peer, true, role, true, true);
        return peer->assignedTier.load(std::memory_order_relaxed);
    }

    static OpaquePeer registerRoomViewer(VersusApp &app) {
        auto peer = std::make_shared<VersusApp::PeerSession>();
        peer->uuid = "room-quality-validator-peer";
        peer->session = "room-quality-validator-session";
        peer->activeWireSession = peer->session;
        peer->streamId = "room-quality-validator-stream";
        peer->roomMode = true;
        peer->requestedVideoBitrateKbps.store(-1, std::memory_order_relaxed);
        app.applyPeerInitState(peer, true, PeerRole::Viewer, true, true);
        {
            std::lock_guard<std::mutex> lock(app.peerSessionsMutex_);
            app.peerSessions_.emplace("room-quality-validator-peer", peer);
        }
        return std::static_pointer_cast<void>(peer);
    }

    static StreamTier peerTier(const OpaquePeer &opaque) {
        const auto peer = std::static_pointer_cast<VersusApp::PeerSession>(opaque);
        return peer
            ? peer->assignedTier.load(std::memory_order_relaxed)
            : StreamTier::None;
    }

    static RoomQualityDecision roomQualityDecision(const VersusApp &app) {
        return app.roomQualityDecisionSnapshot();
    }

    static void applyLockedRuntimeCodecUpdate(VersusApp &app,
                                              video::VideoCodec codec) {
        std::lock_guard<std::mutex> lock(app.videoSendMutex_);
        app.videoConfig_.codec = codec;
        app.publishVideoStateSnapshotLocked();
        app.updateRoomQualityDecisionForCodecLocked();
    }

    static void setBeforeRoomQualityDecisionCommitHook(
        VersusApp &app,
        std::function<void()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualitySyncTestHookMutex_);
        app.beforeRoomQualityDecisionCommitForTesting_ = std::move(hook);
    }

    static void setBeforePeerActiveVideoTrackQueryHook(
        VersusApp &app,
        std::function<void()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualityArchitectureTestHookMutex_);
        app.beforePeerActiveVideoTrackQueryForTesting_ = std::move(hook);
    }

    static void setBeforeLqEncoderInitializeHook(
        VersusApp &app,
        std::function<bool()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualityArchitectureTestHookMutex_);
        app.beforeLqEncoderInitializeForTesting_ = std::move(hook);
    }

    static void setAfterRoomQualityLifecycleMutationHook(
        VersusApp &app,
        std::function<void()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualityArchitectureTestHookMutex_);
        app.afterRoomQualityLifecycleMutationForTesting_ = std::move(hook);
    }

    static void setDuringRoomQualityLifecycleMutationHook(
        VersusApp &app,
        std::function<void()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualityArchitectureTestHookMutex_);
        app.duringRoomQualityLifecycleMutationForTesting_ = std::move(hook);
    }

    static void setAfterDiagnosticsVideoSnapshotHook(
        VersusApp &app,
        std::function<void()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualityArchitectureTestHookMutex_);
        app.afterDiagnosticsVideoSnapshotForTesting_ = std::move(hook);
    }

    static void setDiagnosticsActiveVideoTrackHook(
        VersusApp &app,
        std::function<bool()> hook) {
        std::lock_guard<std::mutex> lock(app.roomQualityArchitectureTestHookMutex_);
        app.peerActiveVideoTrackForDiagnosticsTesting_ = std::move(hook);
    }

    static std::pair<std::string, bool> roomQualityLifecycle(const VersusApp &app) {
        const auto snapshot = app.lifecycleStateSnapshot();
        return {snapshot.room, snapshot.startOptions.roomModeLqEnabled};
    }

    static void snapshotLifecycleDecisionAfterVideoTryLock(
        VersusApp &app,
        const std::function<void(bool)> &afterVideoTryLock,
        std::pair<std::string, bool> &lifecycle,
        RoomQualityDecision &decision) {
        std::unique_lock<std::mutex> videoLock(app.videoSendMutex_, std::defer_lock);
        const bool videoTryLockSucceeded = videoLock.try_lock();
        afterVideoTryLock(videoTryLockSucceeded);
        if (!videoTryLockSucceeded) {
            videoLock.lock();
        }
        std::lock_guard<std::mutex> lifecycleLock(app.lifecycleStateMutex_);
        std::lock_guard<std::mutex> decisionLock(app.roomQualityDecisionMutex_);
        lifecycle = {app.room_, app.startOptions_.roomModeLqEnabled};
        decision = app.roomQualityState_.decision;
    }

    static std::array<bool, 3> probeCoreLockAvailability(VersusApp &app) {
        const auto tryLock = [](std::mutex &mutex) {
            if (!mutex.try_lock()) {
                return false;
            }
            mutex.unlock();
            return true;
        };
        return {
            tryLock(app.videoSendMutex_),
            tryLock(app.roomQualityDecisionMutex_),
            tryLock(app.peerSessionsMutex_),
        };
    }

    static void attachClientForEncodeQuery(const OpaquePeer &opaque) {
        const auto peer = std::static_pointer_cast<VersusApp::PeerSession>(opaque);
        peer->client = std::make_unique<webrtc::WebRtcClient>();
    }

    static bool invokeEncodeQueryPath(VersusApp &app) {
        app.live_.store(true, std::memory_order_relaxed);
        const video::CapturedFrame frame;
        return app.encodeAndSendVideoFrame(frame, false);
    }

    static void finishEncodeQueryPath(VersusApp &app) {
        app.live_.store(false, std::memory_order_relaxed);
        app.clearPeerSessions();
    }

    static void forceCommittedCodecMismatchAndRefresh(
        VersusApp &app,
        video::VideoCodec committedCodec) {
        std::lock_guard<std::mutex> videoLock(app.videoSendMutex_);
        std::lock_guard<std::mutex> decisionLock(app.roomQualityDecisionMutex_);
        app.roomQualityState_.roomMode = true;
        app.roomQualityState_.codec = committedCodec;
        app.roomQualityState_.alphaWorkflowEnabled = false;
        app.roomQualityState_.decision = {
            true,
            true,
            RoomQualityReason::Enabled,
        };
        app.refreshRoomQualityPeerTiersLocked(app.roomQualityState_.decision);
    }

    static video::VideoCodec committedRoomQualityCodec(const VersusApp &app) {
        std::lock_guard<std::mutex> decisionLock(app.roomQualityDecisionMutex_);
        return app.roomQualityState_.codec;
    }

    static bool invokeLqGuard(VersusApp &app) {
        std::lock_guard<std::mutex> videoLock(app.videoSendMutex_);
        return app.ensureLqEncoderInitializedLocked();
    }

    static bool raceDirectorInitAgainstFallback(VersusApp &app) {
        for (int iteration = 0; iteration < 500; ++iteration) {
            auto peer = std::make_shared<VersusApp::PeerSession>();
            peer->roomMode = true;
            peer->initReceived.store(false, std::memory_order_relaxed);
            std::atomic<bool> start{false};
            std::thread fallback([&]() {
                while (!start.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
                app.applyPeerInitFallbackIfPending(peer, true, true);
            });
            std::thread director([&]() {
                while (!start.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
                app.applyPeerInitState(peer, true, PeerRole::Director, true, true);
            });
            start.store(true, std::memory_order_release);
            fallback.join();
            director.join();
            if (!peer->initReceived.load(std::memory_order_relaxed) ||
                !peer->roleValid.load(std::memory_order_relaxed) ||
                peer->role.load(std::memory_order_relaxed) != PeerRole::Director) {
                return false;
            }
        }
        return true;
    }
};

}  // namespace versus::app

namespace {

constexpr char kVp9UnavailableWarning[] =
    "Room Quality is unavailable with VP9; continuing HQ-only without changing the selected codec or alpha workflow.";

versus::video::EncoderConfig selectedConfig(versus::video::VideoCodec codec) {
    versus::video::EncoderConfig config;
    config.codec = codec;
    config.enableAlpha = true;
    config.alphaBackgroundMode = versus::video::AlphaBackgroundMode::Chroma;
    config.alphaBackgroundRed = 17;
    config.alphaBackgroundGreen = 34;
    config.alphaBackgroundBlue = 51;
    config.forceFfmpegNvenc = true;
    return config;
}

QString codecName(versus::video::VideoCodec codec) {
    switch (codec) {
        case versus::video::VideoCodec::H264:
            return QStringLiteral("H264");
        case versus::video::VideoCodec::H265:
            return QStringLiteral("H265");
        case versus::video::VideoCodec::VP9:
            return QStringLiteral("VP9");
        case versus::video::VideoCodec::AV1:
            return QStringLiteral("AV1");
        case versus::video::VideoCodec::VP8:
            return QStringLiteral("VP8");
    }
    return QStringLiteral("unknown");
}

struct RuntimeEvent {
    std::string message;
    bool fatal = false;
};

struct AbortGoLiveAfterLifecycleHook {};

}  // namespace

class TestRoomQualityRuntime : public QObject {
    Q_OBJECT

  private slots:
    void testNonH264RoomQualityPreservesSelectedCodec_data();
    void testNonH264RoomQualityPreservesSelectedCodec();
    void testNonH264RoomQualityPreservesAlphaConfiguration_data();
    void testNonH264RoomQualityPreservesAlphaConfiguration();
    void testVp9UnavailableWarningIsExactAndInformational();
    void testVp9UnavailableWarningOccursOncePerTransition();
    void testChangingUnavailableCodecStartsOneNamedTransition();
    void testPeerInitCannotExposeLqWhenRoomQualityIsIneffective_data();
    void testPeerInitCannotExposeLqWhenRoomQualityIsIneffective();
    void testDiagnosticsSeparateRequestedEffectiveAndReason_data();
    void testDiagnosticsSeparateRequestedEffectiveAndReason();
    void testConcurrentCodecUpdateWinsOverStaleSync_data();
    void testConcurrentCodecUpdateWinsOverStaleSync();
    void testLockedRuntimeCodecUpdateRefreshesPeerTier_data();
    void testLockedRuntimeCodecUpdateRefreshesPeerTier();
    void testStopLiveClearsRoomQualityAvailabilityContext();
    void testPeerVideoTrackQueryRunsWithoutCoreLocks();
    void testLqRejectsActualCommittedCodecMismatch();
    void testLifecycleRoomQualityMutationIsAtomic();
    void testDiagnosticsRoomQualitySnapshotIsCoherent();
    void testExplicitDirectorInitWinsTimeoutFallbackRace();
};

void TestRoomQualityRuntime::testExplicitDirectorInitWinsTimeoutFallbackRace() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);

    QVERIFY(versus::app::VersusAppTestAccess::raceDirectorInitAgainstFallback(app));
}

void TestRoomQualityRuntime::testNonH264RoomQualityPreservesSelectedCodec_data() {
    QTest::addColumn<int>("codecValue");

    QTest::newRow("vp9") << static_cast<int>(versus::video::VideoCodec::VP9);
    QTest::newRow("h265") << static_cast<int>(versus::video::VideoCodec::H265);
    QTest::newRow("av1") << static_cast<int>(versus::video::VideoCodec::AV1);
}

void TestRoomQualityRuntime::testNonH264RoomQualityPreservesSelectedCodec() {
    QFETCH(int, codecValue);
    const auto codec = static_cast<versus::video::VideoCodec>(codecValue);

    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(codec));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);

    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    const auto actual = versus::app::VersusAppTestAccess::configuredVideo(app);
    QVERIFY2(actual.codec == codec,
             qPrintable(QStringLiteral("Room Quality changed selected codec %1 to %2")
                            .arg(codecName(codec), codecName(actual.codec))));
}

void TestRoomQualityRuntime::testNonH264RoomQualityPreservesAlphaConfiguration_data() {
    testNonH264RoomQualityPreservesSelectedCodec_data();
}

void TestRoomQualityRuntime::testNonH264RoomQualityPreservesAlphaConfiguration() {
    QFETCH(int, codecValue);
    const auto codec = static_cast<versus::video::VideoCodec>(codecValue);

    versus::app::VersusApp app;
    const auto expected = selectedConfig(codec);
    app.setVideoConfig(expected);
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);

    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    const auto actual = versus::app::VersusAppTestAccess::configuredVideo(app);
    QVERIFY2(actual.enableAlpha == expected.enableAlpha &&
                 actual.alphaBackgroundMode == expected.alphaBackgroundMode &&
                 actual.alphaBackgroundRed == expected.alphaBackgroundRed &&
                 actual.alphaBackgroundGreen == expected.alphaBackgroundGreen &&
                 actual.alphaBackgroundBlue == expected.alphaBackgroundBlue,
             qPrintable(QStringLiteral("Room Quality mutated the selected %1 alpha configuration")
                            .arg(codecName(codec))));
}

void TestRoomQualityRuntime::testVp9UnavailableWarningIsExactAndInformational() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);

    std::vector<RuntimeEvent> events;
    app.onRuntimeEvent([&](const std::string &message, bool fatal) {
        events.push_back({message, fatal});
    });

    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QCOMPARE(events.size(), std::size_t{1});
    QCOMPARE(QString::fromStdString(events.front().message),
             QString::fromLatin1(kVp9UnavailableWarning));
    QVERIFY(!events.front().fatal);
}

void TestRoomQualityRuntime::testVp9UnavailableWarningOccursOncePerTransition() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);

    std::vector<RuntimeEvent> events;
    app.onRuntimeEvent([&](const std::string &message, bool fatal) {
        events.push_back({message, fatal});
    });

    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QCOMPARE(events.size(), std::size_t{1});

    versus::app::VersusAppTestAccess::setRoomQualityRequested(app, false);
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QCOMPARE(events.size(), std::size_t{1});

    versus::app::VersusAppTestAccess::setRoomQualityRequested(app, true);
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QCOMPARE(events.size(), std::size_t{2});
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QCOMPARE(events.size(), std::size_t{2});

    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    QCOMPARE(events.size(), std::size_t{3});

    for (const auto &event : events) {
        QCOMPARE(QString::fromStdString(event.message), QString::fromLatin1(kVp9UnavailableWarning));
        QVERIFY(!event.fatal);
    }
}

void TestRoomQualityRuntime::testChangingUnavailableCodecStartsOneNamedTransition() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);

    std::vector<RuntimeEvent> events;
    app.onRuntimeEvent([&](const std::string &message, bool fatal) {
        events.push_back({message, fatal});
    });

    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H265));
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::AV1));
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));

    QCOMPARE(events.size(), std::size_t{3});
    QCOMPARE(QString::fromStdString(events[0].message), QString::fromLatin1(kVp9UnavailableWarning));
    QCOMPARE(
        QString::fromStdString(events[1].message),
        QStringLiteral("Room Quality is unavailable with H.265; continuing HQ-only without changing the selected codec or alpha workflow."));
    QCOMPARE(
        QString::fromStdString(events[2].message),
        QStringLiteral("Room Quality is unavailable with AV1; continuing HQ-only without changing the selected codec or alpha workflow."));
    for (const auto &event : events) {
        QVERIFY(!event.fatal);
    }
}

void TestRoomQualityRuntime::testPeerInitCannotExposeLqWhenRoomQualityIsIneffective_data() {
    QTest::addColumn<int>("codecValue");
    QTest::addColumn<int>("requestedVideoBitrateKbps");

    const std::pair<const char *, versus::video::VideoCodec> codecs[] = {
        {"vp9", versus::video::VideoCodec::VP9},
        {"h265", versus::video::VideoCodec::H265},
        {"av1", versus::video::VideoCodec::AV1},
    };
    for (const auto &[name, codec] : codecs) {
        QTest::newRow((std::string(name) + "-normal").c_str())
            << static_cast<int>(codec) << -1;
        QTest::newRow((std::string(name) + "-500kbps").c_str())
            << static_cast<int>(codec) << 500;
    }
}

void TestRoomQualityRuntime::testPeerInitCannotExposeLqWhenRoomQualityIsIneffective() {
    QFETCH(int, codecValue);
    QFETCH(int, requestedVideoBitrateKbps);

    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(
        static_cast<versus::video::VideoCodec>(codecValue)));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));

    QCOMPARE(versus::app::VersusAppTestAccess::initializeRoomPeer(
                 app,
                 versus::app::PeerRole::Viewer,
                 requestedVideoBitrateKbps),
             versus::app::StreamTier::HQ);
}

void TestRoomQualityRuntime::testDiagnosticsSeparateRequestedEffectiveAndReason_data() {
    QTest::addColumn<bool>("roomMode");
    QTest::addColumn<bool>("requested");
    QTest::addColumn<int>("codecValue");
    QTest::addColumn<bool>("effective");
    QTest::addColumn<QString>("reason");

    QTest::newRow("enabled")
        << true << true << static_cast<int>(versus::video::VideoCodec::H264)
        << true << QStringLiteral("enabled");
    QTest::newRow("not-in-room")
        << false << true << static_cast<int>(versus::video::VideoCodec::H264)
        << false << QStringLiteral("not-in-room");
    QTest::newRow("not-requested")
        << true << false << static_cast<int>(versus::video::VideoCodec::H264)
        << false << QStringLiteral("not-requested");
    QTest::newRow("codec-not-h264")
        << true << true << static_cast<int>(versus::video::VideoCodec::VP9)
        << false << QStringLiteral("codec-not-h264");
}

void TestRoomQualityRuntime::testDiagnosticsSeparateRequestedEffectiveAndReason() {
    QFETCH(bool, roomMode);
    QFETCH(bool, requested);
    QFETCH(int, codecValue);
    QFETCH(bool, effective);
    QFETCH(QString, reason);

    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(
        static_cast<versus::video::VideoCodec>(codecValue)));
    versus::app::VersusAppTestAccess::setRoomQualityContext(
        app,
        roomMode,
        requested);
    QVERIFY(versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app));

    QJsonParseError parseError;
    const QJsonDocument diagnostics = QJsonDocument::fromJson(
        QByteArray::fromStdString(app.buildDiagnosticsJson()),
        &parseError);
    QCOMPARE(parseError.error, QJsonParseError::NoError);
    QVERIFY(diagnostics.isObject());

    const QJsonObject root = diagnostics.object();
    QVERIFY2(root.contains(QStringLiteral("room_quality")),
             "Diagnostics must expose a distinct room_quality object");
    const QJsonObject roomQuality = root.value(QStringLiteral("room_quality")).toObject();
    QVERIFY(roomQuality.contains(QStringLiteral("requested")));
    QVERIFY(roomQuality.contains(QStringLiteral("effective")));
    QVERIFY(roomQuality.contains(QStringLiteral("reason")));
    QCOMPARE(roomQuality.value(QStringLiteral("requested")).toBool(), requested);
    QCOMPARE(roomQuality.value(QStringLiteral("effective")).toBool(), effective);
    QCOMPARE(roomQuality.value(QStringLiteral("reason")).toString(), reason);
}

void TestRoomQualityRuntime::testConcurrentCodecUpdateWinsOverStaleSync_data() {
    QTest::addColumn<int>("snapshotCodecValue");
    QTest::addColumn<int>("updateCodecValue");
    QTest::addColumn<bool>("expectedEffective");
    QTest::addColumn<QString>("expectedReason");
    QTest::addColumn<int>("expectedTierValue");

    QTest::newRow("vp9-snapshot-h264-update")
        << static_cast<int>(versus::video::VideoCodec::VP9)
        << static_cast<int>(versus::video::VideoCodec::H264)
        << true
        << QStringLiteral("enabled")
        << static_cast<int>(versus::app::StreamTier::LQ);
    QTest::newRow("h264-snapshot-vp9-update")
        << static_cast<int>(versus::video::VideoCodec::H264)
        << static_cast<int>(versus::video::VideoCodec::VP9)
        << false
        << QStringLiteral("codec-not-h264")
        << static_cast<int>(versus::app::StreamTier::HQ);
}

void TestRoomQualityRuntime::testConcurrentCodecUpdateWinsOverStaleSync() {
    QFETCH(int, snapshotCodecValue);
    QFETCH(int, updateCodecValue);
    QFETCH(bool, expectedEffective);
    QFETCH(QString, expectedReason);
    QFETCH(int, expectedTierValue);

    const auto snapshotCodec =
        static_cast<versus::video::VideoCodec>(snapshotCodecValue);
    const auto updateCodec =
        static_cast<versus::video::VideoCodec>(updateCodecValue);

    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(snapshotCodec));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    const auto peer = versus::app::VersusAppTestAccess::registerRoomViewer(app);

    std::atomic<bool> hookEntered{false};
    std::mutex updateMutex;
    std::condition_variable updateFinishedCv;
    bool updateFinished = false;
    std::thread updater;
    versus::app::VersusAppTestAccess::setBeforeRoomQualityDecisionCommitHook(
        app,
        [&]() {
            if (hookEntered.exchange(true, std::memory_order_acq_rel)) {
                return;
            }
            updater = std::thread([&]() {
                versus::app::VersusAppTestAccess::applyLockedRuntimeCodecUpdate(
                    app,
                    updateCodec);
                {
                    std::lock_guard<std::mutex> lock(updateMutex);
                    updateFinished = true;
                }
                updateFinishedCv.notify_one();
            });
            std::unique_lock<std::mutex> lock(updateMutex);
            updateFinishedCv.wait_for(
                lock,
                std::chrono::milliseconds(750),
                [&]() { return updateFinished; });
        });

    const bool syncOk =
        versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    versus::app::VersusAppTestAccess::setBeforeRoomQualityDecisionCommitHook(app, {});
    if (updater.joinable()) {
        updater.join();
    }

    const auto configured =
        versus::app::VersusAppTestAccess::configuredVideo(app);
    const auto decision =
        versus::app::VersusAppTestAccess::roomQualityDecision(app);
    const auto tier = versus::app::VersusAppTestAccess::peerTier(peer);
    const QJsonObject diagnostics = QJsonDocument::fromJson(
        QByteArray::fromStdString(app.buildDiagnosticsJson())).object();
    const QJsonObject diagnosticRoomQuality =
        diagnostics.value(QStringLiteral("room_quality")).toObject();
    const QString diagnosticTier = diagnostics
        .value(QStringLiteral("peers"))
        .toArray()
        .at(0)
        .toObject()
        .value(QStringLiteral("room"))
        .toObject()
        .value(QStringLiteral("assigned_tier"))
        .toString();

    QVERIFY(syncOk);
    QVERIFY(hookEntered.load(std::memory_order_acquire));
    QCOMPARE(configured.codec, updateCodec);
    QCOMPARE(decision.requested, true);
    QCOMPARE(decision.effective, expectedEffective);
    QCOMPARE(
        QString::fromLatin1(versus::app::roomQualityReasonName(decision.reason)),
        expectedReason);
    QCOMPARE(static_cast<int>(tier), expectedTierValue);
    QCOMPARE(diagnosticRoomQuality.value(QStringLiteral("requested")).toBool(), true);
    QCOMPARE(diagnosticRoomQuality.value(QStringLiteral("effective")).toBool(), expectedEffective);
    QCOMPARE(diagnosticRoomQuality.value(QStringLiteral("reason")).toString(), expectedReason);
    QCOMPARE(
        diagnosticTier,
        expectedTierValue == static_cast<int>(versus::app::StreamTier::LQ)
            ? QStringLiteral("lq")
            : QStringLiteral("hq"));
}

void TestRoomQualityRuntime::testLockedRuntimeCodecUpdateRefreshesPeerTier_data() {
    QTest::addColumn<int>("initialCodecValue");
    QTest::addColumn<int>("updatedCodecValue");
    QTest::addColumn<int>("initialTierValue");
    QTest::addColumn<int>("expectedTierValue");

    QTest::newRow("vp9-hq-to-h264-lq")
        << static_cast<int>(versus::video::VideoCodec::VP9)
        << static_cast<int>(versus::video::VideoCodec::H264)
        << static_cast<int>(versus::app::StreamTier::HQ)
        << static_cast<int>(versus::app::StreamTier::LQ);
    QTest::newRow("h264-lq-to-vp9-hq")
        << static_cast<int>(versus::video::VideoCodec::H264)
        << static_cast<int>(versus::video::VideoCodec::VP9)
        << static_cast<int>(versus::app::StreamTier::LQ)
        << static_cast<int>(versus::app::StreamTier::HQ);
}

void TestRoomQualityRuntime::testLockedRuntimeCodecUpdateRefreshesPeerTier() {
    QFETCH(int, initialCodecValue);
    QFETCH(int, updatedCodecValue);
    QFETCH(int, initialTierValue);
    QFETCH(int, expectedTierValue);

    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(
        static_cast<versus::video::VideoCodec>(initialCodecValue)));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    const auto peer = versus::app::VersusAppTestAccess::registerRoomViewer(app);
    QCOMPARE(
        static_cast<int>(versus::app::VersusAppTestAccess::peerTier(peer)),
        initialTierValue);

    versus::app::VersusAppTestAccess::applyLockedRuntimeCodecUpdate(
        app,
        static_cast<versus::video::VideoCodec>(updatedCodecValue));

    const auto decision =
        versus::app::VersusAppTestAccess::roomQualityDecision(app);
    const auto tier = versus::app::VersusAppTestAccess::peerTier(peer);
    const QJsonObject diagnostics = QJsonDocument::fromJson(
        QByteArray::fromStdString(app.buildDiagnosticsJson())).object();
    const QString diagnosticTier = diagnostics
        .value(QStringLiteral("peers"))
        .toArray()
        .at(0)
        .toObject()
        .value(QStringLiteral("room"))
        .toObject()
        .value(QStringLiteral("assigned_tier"))
        .toString();

    QCOMPARE(decision.effective,
             updatedCodecValue == static_cast<int>(versus::video::VideoCodec::H264));
    QCOMPARE(static_cast<int>(tier), expectedTierValue);
    QCOMPARE(
        diagnosticTier,
        expectedTierValue == static_cast<int>(versus::app::StreamTier::LQ)
            ? QStringLiteral("lq")
            : QStringLiteral("hq"));
}

void TestRoomQualityRuntime::testStopLiveClearsRoomQualityAvailabilityContext() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);

    std::vector<RuntimeEvent> events;
    app.onRuntimeEvent([&](const std::string &message, bool fatal) {
        events.push_back({message, fatal});
    });

    app.stopLive();
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));

    const auto decision =
        versus::app::VersusAppTestAccess::roomQualityDecision(app);
    const QJsonObject diagnosticRoomQuality = QJsonDocument::fromJson(
        QByteArray::fromStdString(app.buildDiagnosticsJson()))
        .object()
        .value(QStringLiteral("room_quality"))
        .toObject();
    const QString decisionReason =
        QString::fromLatin1(versus::app::roomQualityReasonName(decision.reason));
    const QString diagnosticReason =
        diagnosticRoomQuality.value(QStringLiteral("reason")).toString();

    QVERIFY2(
        events.empty() &&
            decision.requested &&
            !decision.effective &&
            decisionReason == QStringLiteral("not-in-room") &&
            diagnosticRoomQuality.value(QStringLiteral("requested")).toBool() &&
            !diagnosticRoomQuality.value(QStringLiteral("effective")).toBool() &&
            diagnosticReason == QStringLiteral("not-in-room"),
        qPrintable(QStringLiteral(
            "warnings=%1 decision={requested:%2,effective:%3,reason:%4} diagnostics={requested:%5,effective:%6,reason:%7}")
                       .arg(events.size())
                       .arg(decision.requested)
                       .arg(decision.effective)
                       .arg(decisionReason)
                       .arg(diagnosticRoomQuality.value(QStringLiteral("requested")).toBool())
                       .arg(diagnosticRoomQuality.value(QStringLiteral("effective")).toBool())
                       .arg(diagnosticReason)));
}

void TestRoomQualityRuntime::testPeerVideoTrackQueryRunsWithoutCoreLocks() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    const auto peer = versus::app::VersusAppTestAccess::registerRoomViewer(app);
    versus::app::VersusAppTestAccess::attachClientForEncodeQuery(peer);

    std::atomic<int> hookCount{0};
    std::atomic<bool> probeEntered{false};
    std::atomic<bool> probeCompleted{false};
    std::array<bool, 3> lockAvailable{false, false, false};
    versus::app::VersusAppTestAccess::setBeforePeerActiveVideoTrackQueryHook(
        app,
        [&]() {
            hookCount.fetch_add(1, std::memory_order_relaxed);
            std::thread lockProbe([&]() {
                probeEntered.store(true, std::memory_order_release);
                lockAvailable =
                    versus::app::VersusAppTestAccess::probeCoreLockAvailability(app);
                probeCompleted.store(true, std::memory_order_release);
            });
            lockProbe.join();
        });

    const bool encodeResult =
        versus::app::VersusAppTestAccess::invokeEncodeQueryPath(app);
    versus::app::VersusAppTestAccess::setBeforePeerActiveVideoTrackQueryHook(app, {});
    versus::app::VersusAppTestAccess::finishEncodeQueryPath(app);

    QVERIFY2(
        hookCount.load(std::memory_order_relaxed) == 1 &&
            probeEntered.load(std::memory_order_acquire) &&
            probeCompleted.load(std::memory_order_acquire) &&
            lockAvailable[0] &&
            lockAvailable[1] &&
            lockAvailable[2],
        qPrintable(QStringLiteral(
            "WebRtcClient::hasActiveVideoTrack query lock state: hook_count=%1 probe_entered=%2 probe_completed=%3 video_available=%4 decision_available=%5 peers_available=%6 encode_result=%7")
                       .arg(hookCount.load(std::memory_order_relaxed))
                       .arg(probeEntered.load(std::memory_order_acquire))
                       .arg(probeCompleted.load(std::memory_order_acquire))
                       .arg(lockAvailable[0])
                       .arg(lockAvailable[1])
                       .arg(lockAvailable[2])
                       .arg(encodeResult)));
}

void TestRoomQualityRuntime::testLqRejectsActualCommittedCodecMismatch() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    const auto peer = versus::app::VersusAppTestAccess::registerRoomViewer(app);

    versus::app::VersusAppTestAccess::forceCommittedCodecMismatchAndRefresh(
        app,
        versus::video::VideoCodec::VP9);
    const auto actualCodec =
        versus::app::VersusAppTestAccess::configuredVideo(app).codec;
    const auto committedCodec =
        versus::app::VersusAppTestAccess::committedRoomQualityCodec(app);
    const auto routedTier = versus::app::VersusAppTestAccess::peerTier(peer);

    bool backendInitializationReached = false;
    versus::app::VersusAppTestAccess::setBeforeLqEncoderInitializeHook(
        app,
        [&]() {
            backendInitializationReached = true;
            return false;
        });
    const bool lqInitialized = versus::app::VersusAppTestAccess::invokeLqGuard(app);
    versus::app::VersusAppTestAccess::setBeforeLqEncoderInitializeHook(app, {});
    app.stopLive();

    QVERIFY2(
        actualCodec == versus::video::VideoCodec::H264 &&
            committedCodec == versus::video::VideoCodec::VP9 &&
            !backendInitializationReached &&
            !lqInitialized &&
            routedTier == versus::app::StreamTier::HQ,
        qPrintable(QStringLiteral(
            "LQ mismatch guard/routing: actual=%1 committed=%2 backend_init_reached=%3 ensure_result=%4 routed_tier=%5")
                       .arg(codecName(actualCodec))
                       .arg(codecName(committedCodec))
                       .arg(backendInitializationReached)
                       .arg(lqInitialized)
                       .arg(QString::fromLatin1(versus::app::streamTierName(routedTier)))));
}

void TestRoomQualityRuntime::testLifecycleRoomQualityMutationIsAtomic() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, false, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);

    const auto coherentLifecycleDecision = [](
                                                const std::pair<std::string, bool> &lifecycle,
                                                const versus::app::RoomQualityDecision &decision) {
        if (!lifecycle.second || !decision.requested) {
            return false;
        }
        if (lifecycle.first.empty()) {
            return !decision.effective &&
                decision.reason == versus::app::RoomQualityReason::NotInRoom;
        }
        return decision.effective &&
            decision.reason == versus::app::RoomQualityReason::Enabled;
    };

    struct TransitionProbe {
        std::mutex mutex;
        std::condition_variable attemptCv;
        bool duringHookSeen = false;
        bool attemptCompleted = false;
        bool videoTryLockSucceeded = false;
        bool snapshotCompleted = false;
        bool afterHookSeen = false;
        bool workerJoined = false;
        std::pair<std::string, bool> lifecycle;
        versus::app::RoomQualityDecision decision;
        std::thread worker;
    };

    TransitionProbe startProbe;
    bool startHookAborted = false;
    versus::app::VersusAppTestAccess::setDuringRoomQualityLifecycleMutationHook(
        app,
        [&]() {
            startProbe.duringHookSeen = true;
            startProbe.worker = std::thread([&]() {
                versus::app::VersusAppTestAccess::snapshotLifecycleDecisionAfterVideoTryLock(
                    app,
                    [&](bool videoTryLockSucceeded) {
                        {
                            std::lock_guard<std::mutex> probeLock(startProbe.mutex);
                            startProbe.videoTryLockSucceeded = videoTryLockSucceeded;
                            startProbe.attemptCompleted = true;
                        }
                        startProbe.attemptCv.notify_one();
                    },
                    startProbe.lifecycle,
                    startProbe.decision);
                startProbe.snapshotCompleted = true;
            });
            std::unique_lock<std::mutex> probeLock(startProbe.mutex);
            startProbe.attemptCv.wait(
                probeLock,
                [&]() { return startProbe.attemptCompleted; });
        });
    versus::app::VersusAppTestAccess::setAfterRoomQualityLifecycleMutationHook(
        app,
        [&]() {
            startProbe.afterHookSeen = true;
            if (startProbe.worker.joinable()) {
                startProbe.worker.join();
                startProbe.workerJoined = true;
            }
            throw AbortGoLiveAfterLifecycleHook{};
        });
    versus::app::StartOptions startOptions;
    startOptions.room = "room-quality-start-transition";
    startOptions.roomModeLqEnabled = true;
    try {
        app.goLive(startOptions);
    } catch (const AbortGoLiveAfterLifecycleHook &) {
        startHookAborted = true;
    }
    if (startProbe.worker.joinable()) {
        startProbe.worker.join();
        startProbe.workerJoined = true;
    }
    versus::app::VersusAppTestAccess::setDuringRoomQualityLifecycleMutationHook(app, {});
    versus::app::VersusAppTestAccess::setAfterRoomQualityLifecycleMutationHook(app, {});
    const bool startCoherent = coherentLifecycleDecision(
        startProbe.lifecycle,
        startProbe.decision);

    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    TransitionProbe stopProbe;
    versus::app::VersusAppTestAccess::setDuringRoomQualityLifecycleMutationHook(
        app,
        [&]() {
            stopProbe.duringHookSeen = true;
            stopProbe.worker = std::thread([&]() {
                versus::app::VersusAppTestAccess::snapshotLifecycleDecisionAfterVideoTryLock(
                    app,
                    [&](bool videoTryLockSucceeded) {
                        {
                            std::lock_guard<std::mutex> probeLock(stopProbe.mutex);
                            stopProbe.videoTryLockSucceeded = videoTryLockSucceeded;
                            stopProbe.attemptCompleted = true;
                        }
                        stopProbe.attemptCv.notify_one();
                    },
                    stopProbe.lifecycle,
                    stopProbe.decision);
                stopProbe.snapshotCompleted = true;
            });
            std::unique_lock<std::mutex> probeLock(stopProbe.mutex);
            stopProbe.attemptCv.wait(
                probeLock,
                [&]() { return stopProbe.attemptCompleted; });
        });
    versus::app::VersusAppTestAccess::setAfterRoomQualityLifecycleMutationHook(
        app,
        [&]() {
            stopProbe.afterHookSeen = true;
            if (stopProbe.worker.joinable()) {
                stopProbe.worker.join();
                stopProbe.workerJoined = true;
            }
        });
    app.stopLive();
    if (stopProbe.worker.joinable()) {
        stopProbe.worker.join();
        stopProbe.workerJoined = true;
    }
    versus::app::VersusAppTestAccess::setDuringRoomQualityLifecycleMutationHook(app, {});
    versus::app::VersusAppTestAccess::setAfterRoomQualityLifecycleMutationHook(app, {});
    const bool stopCoherent = coherentLifecycleDecision(
        stopProbe.lifecycle,
        stopProbe.decision);

    QVERIFY2(
        startProbe.duringHookSeen &&
            startProbe.attemptCompleted &&
            startProbe.snapshotCompleted &&
            startProbe.afterHookSeen &&
            startProbe.workerJoined &&
            startHookAborted &&
            startCoherent &&
            stopProbe.duringHookSeen &&
            stopProbe.attemptCompleted &&
            stopProbe.snapshotCompleted &&
            stopProbe.afterHookSeen &&
            stopProbe.workerJoined &&
            stopCoherent,
        qPrintable(QStringLiteral(
            "Lifecycle/decision atomicity: start={during:%1,attempt:%2,video_try:%3,snapshot:%4,after:%5,joined:%6,aborted:%7,room:'%8',requested:%9,effective:%10,reason:%11,coherent:%12} stop={during:%13,attempt:%14,video_try:%15,snapshot:%16,after:%17,joined:%18,room:'%19',requested:%20,effective:%21,reason:%22,coherent:%23}")
                       .arg(startProbe.duringHookSeen)
                       .arg(startProbe.attemptCompleted)
                       .arg(startProbe.videoTryLockSucceeded)
                       .arg(startProbe.snapshotCompleted)
                       .arg(startProbe.afterHookSeen)
                       .arg(startProbe.workerJoined)
                       .arg(startHookAborted)
                       .arg(QString::fromStdString(startProbe.lifecycle.first))
                       .arg(startProbe.decision.requested)
                       .arg(startProbe.decision.effective)
                       .arg(QString::fromLatin1(versus::app::roomQualityReasonName(startProbe.decision.reason)))
                       .arg(startCoherent)
                       .arg(stopProbe.duringHookSeen)
                       .arg(stopProbe.attemptCompleted)
                       .arg(stopProbe.videoTryLockSucceeded)
                       .arg(stopProbe.snapshotCompleted)
                       .arg(stopProbe.afterHookSeen)
                       .arg(stopProbe.workerJoined)
                       .arg(QString::fromStdString(stopProbe.lifecycle.first))
                       .arg(stopProbe.decision.requested)
                       .arg(stopProbe.decision.effective)
                       .arg(QString::fromLatin1(versus::app::roomQualityReasonName(stopProbe.decision.reason)))
                       .arg(stopCoherent)));
}

void TestRoomQualityRuntime::testDiagnosticsRoomQualitySnapshotIsCoherent() {
    versus::app::VersusApp app;
    app.setVideoConfig(selectedConfig(versus::video::VideoCodec::H264));
    versus::app::VersusAppTestAccess::setRoomQualityContext(app, true, true);
    versus::app::VersusAppTestAccess::enforceRoomQualityCompatibility(app);
    const auto peer = versus::app::VersusAppTestAccess::registerRoomViewer(app);
    versus::app::VersusAppTestAccess::attachClientForEncodeQuery(peer);

    std::atomic<int> activeVideoObservationCount{0};
    versus::app::VersusAppTestAccess::setDiagnosticsActiveVideoTrackHook(
        app,
        [&]() {
            activeVideoObservationCount.fetch_add(1, std::memory_order_relaxed);
            return true;
        });

    bool transitionRan = false;
    versus::app::VersusAppTestAccess::setAfterDiagnosticsVideoSnapshotHook(
        app,
        [&]() {
            transitionRan = true;
            app.stopLive();
            app.setVideoConfig(selectedConfig(versus::video::VideoCodec::VP9));
        });
    QJsonParseError parseError;
    const QJsonDocument diagnostics = QJsonDocument::fromJson(
        QByteArray::fromStdString(app.buildDiagnosticsJson()),
        &parseError);
    versus::app::VersusAppTestAccess::setAfterDiagnosticsVideoSnapshotHook(app, {});
    versus::app::VersusAppTestAccess::setDiagnosticsActiveVideoTrackHook(app, {});

    const QJsonObject root = diagnostics.object();
    const QJsonObject roomQuality =
        root.value(QStringLiteral("room_quality")).toObject();
    const QString configuredCodec = root
        .value(QStringLiteral("video"))
        .toObject()
        .value(QStringLiteral("configured_codec"))
        .toString();
    const QString lifecycleRoom = root
        .value(QStringLiteral("signaling"))
        .toObject()
        .value(QStringLiteral("room"))
        .toString();
    const QJsonObject peerCounts =
        root.value(QStringLiteral("peer_counts")).toObject();
    const int peerCount = peerCounts.value(QStringLiteral("total")).toInt(-1);
    const int activeVideoPeerCount =
        peerCounts.value(QStringLiteral("active_video")).toInt(-1);
    const int hqPeerCount = peerCounts.value(QStringLiteral("hq")).toInt(-1);
    const int lqPeerCount = peerCounts.value(QStringLiteral("lq")).toInt(-1);
    const QJsonObject metrics = root.value(QStringLiteral("metrics")).toObject();
    const int metricsPeerCount =
        metrics.value(QStringLiteral("peer_count")).toInt(-1);
    const int metricsHqPeerCount =
        metrics.value(QStringLiteral("hq_peer_count")).toInt(-1);
    const int metricsLqPeerCount =
        metrics.value(QStringLiteral("lq_peer_count")).toInt(-1);
    const int metricsActiveVideoPeerCount =
        metrics.value(QStringLiteral("active_video_peers")).toInt(-1);
    const QJsonArray peers = root.value(QStringLiteral("peers")).toArray();
    const QString expectedPeerUuid = QStringLiteral("room-quality-validator-peer");
    const QString peerUuid = peers.size() == 1
        ? peers.at(0).toObject().value(QStringLiteral("uuid")).toString()
        : QString{};
    int serializedHqPeerCount = 0;
    int serializedLqPeerCount = 0;
    bool serializedPeerHasIdentity = false;
    for (const QJsonValue &peerValue : peers) {
        const QJsonObject peerObject = peerValue.toObject();
        serializedPeerHasIdentity = serializedPeerHasIdentity ||
            !peerObject.value(QStringLiteral("uuid")).toString().isEmpty();
        const QString assignedTier = peerObject
            .value(QStringLiteral("room"))
            .toObject()
            .value(QStringLiteral("assigned_tier"))
            .toString();
        if (assignedTier == QStringLiteral("hq")) {
            ++serializedHqPeerCount;
        } else if (assignedTier == QStringLiteral("lq")) {
            ++serializedLqPeerCount;
        }
    }
    const bool requested = roomQuality.value(QStringLiteral("requested")).toBool();
    const bool effective = roomQuality.value(QStringLiteral("effective")).toBool();
    const QString reason = roomQuality.value(QStringLiteral("reason")).toString();
    const bool countViewsAgree =
        metricsPeerCount == peerCount &&
        metricsHqPeerCount == hqPeerCount &&
        metricsLqPeerCount == lqPeerCount &&
        metricsActiveVideoPeerCount == activeVideoPeerCount &&
        peerCount == peers.size() &&
        hqPeerCount == serializedHqPeerCount &&
        lqPeerCount == serializedLqPeerCount &&
        serializedHqPeerCount + serializedLqPeerCount == peers.size();

    const bool coherentOldState =
        configuredCodec == QStringLiteral("H.264") &&
        requested &&
        effective &&
        reason == QStringLiteral("enabled") &&
        lifecycleRoom == QStringLiteral("room-quality-regression") &&
        peerCount == 1 &&
        activeVideoPeerCount == 1 &&
        hqPeerCount == 0 &&
        lqPeerCount == 1 &&
        peers.size() == 1 &&
        peerUuid == expectedPeerUuid &&
        serializedPeerHasIdentity &&
        countViewsAgree;
    const bool coherentNewState =
        configuredCodec == QStringLiteral("VP9") &&
        requested &&
        !effective &&
        reason == QStringLiteral("not-in-room") &&
        lifecycleRoom.isEmpty() &&
        peerCount == 0 &&
        activeVideoPeerCount == 0 &&
        hqPeerCount == 0 &&
        lqPeerCount == 0 &&
        peers.isEmpty() &&
        peerUuid.isEmpty() &&
        !serializedPeerHasIdentity &&
        countViewsAgree;

    QVERIFY2(
        parseError.error == QJsonParseError::NoError &&
            transitionRan &&
            activeVideoObservationCount.load(std::memory_order_relaxed) > 0 &&
            (coherentOldState || coherentNewState),
        qPrintable(QStringLiteral(
            "Diagnostics mixed room-quality generations: parse=%1 transition=%2 active_observations=%3 codec=%4 requested=%5 effective=%6 reason=%7 room='%8' peer_counts={total:%9,active_video:%10,hq:%11,lq:%12} metrics={total:%13,active_video:%14,hq:%15,lq:%16} serialized={size:%17,hq:%18,lq:%19,uuid:'%20',has_identity:%21} counts_agree=%22 old=%23 new=%24")
                       .arg(parseError.errorString())
                       .arg(transitionRan)
                       .arg(activeVideoObservationCount.load(std::memory_order_relaxed))
                       .arg(configuredCodec)
                       .arg(requested)
                       .arg(effective)
                       .arg(reason)
                       .arg(lifecycleRoom)
                       .arg(peerCount)
                       .arg(activeVideoPeerCount)
                       .arg(hqPeerCount)
                       .arg(lqPeerCount)
                       .arg(metricsPeerCount)
                       .arg(metricsActiveVideoPeerCount)
                       .arg(metricsHqPeerCount)
                       .arg(metricsLqPeerCount)
                       .arg(peers.size())
                       .arg(serializedHqPeerCount)
                       .arg(serializedLqPeerCount)
                       .arg(peerUuid)
                       .arg(serializedPeerHasIdentity)
                       .arg(countViewsAgree)
                       .arg(coherentOldState)
                       .arg(coherentNewState)));
}

QTEST_MAIN(TestRoomQualityRuntime)
#include "test_room_quality_runtime.moc"
