#include <QCoreApplication>
#include <QProcess>
#include <QStringList>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "signaling_lifecycle/fake_websocket_control.h"
#include "versus/signaling/vdo_signaling.h"

namespace {

using namespace std::chrono_literals;
using versus::signaling::VdoSignaling;

constexpr const char *kAlertMessage = R"({"alert":"lifecycle-probe"})";

template <typename Predicate>
bool waitUntil(Predicate &&predicate, std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (predicate()) {
            return true;
        }
        std::this_thread::sleep_for(5ms);
    }
    return predicate();
}

int failScenario(const std::string &scenario, const std::string &reason) {
    std::cout << "SCENARIO_FAIL:" << scenario << ":" << reason << std::endl;
    rtc::signaling_lifecycle_test::joinCallbacks();
    return 2;
}

int passScenario(const std::string &scenario) {
    std::cout << "SCENARIO_PASS:" << scenario << std::endl;
    return 0;
}

int runSameThreadDisconnect() {
    const std::string scenario = "same-thread-disconnect";
    rtc::signaling_lifecycle_test::reset();
    std::atomic<bool> callbackEntered{false};
    std::atomic<bool> disconnectReturned{false};

    {
        VdoSignaling signaling;
        if (!signaling.connect("ws://lifecycle.test/initial")) {
            return failScenario(scenario, "initial-connect-failed");
        }
        signaling.onAlert([&](const std::string &) {
            callbackEntered.store(true, std::memory_order_release);
            std::cout << "LIFECYCLE_BRANCH:same-thread:callback-entered" << std::endl;
            signaling.disconnect();
            disconnectReturned.store(true, std::memory_order_release);
            std::cout << "LIFECYCLE_BRANCH:same-thread:disconnect-returned" << std::endl;
        });

        if (!rtc::signaling_lifecycle_test::emitTextOnLatest(kAlertMessage) ||
            !waitUntil(
                [&]() { return disconnectReturned.load(std::memory_order_acquire); },
                1500ms)) {
            return failScenario(scenario, "callback-did-not-return");
        }
        rtc::signaling_lifecycle_test::joinCallbacks();
        if (!callbackEntered.load(std::memory_order_acquire) || signaling.isConnected()) {
            return failScenario(scenario, "post-disconnect-state-invalid");
        }
    }

    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runCrossThreadReconnect() {
    const std::string scenario = "cross-thread-reconnect";
    rtc::signaling_lifecycle_test::reset();

    std::atomic<bool> callbackEntered{false};
    std::atomic<bool> callbackExited{false};
    std::atomic<bool> disconnectReturned{false};
    std::atomic<bool> logicalDisconnectObserved{false};
    std::atomic<bool> firstReconnectResult{true};
    std::mutex completionMutex;
    std::condition_variable completionCv;
    bool reconnectComplete = false;
    std::thread reconnectThread;

    {
        VdoSignaling signaling;
        if (!signaling.connect("ws://lifecycle.test/initial")) {
            return failScenario(scenario, "initial-connect-failed");
        }

        signaling.onAlert([&](const std::string &) {
            reconnectThread = std::thread([&]() {
                std::cout << "LIFECYCLE_BRANCH:cross-thread:reconnect-started" << std::endl;
                signaling.disconnect();
                disconnectReturned.store(true, std::memory_order_release);
                std::cout << "LIFECYCLE_BRANCH:cross-thread:disconnect-returned" << std::endl;
                const bool logicallyDisconnected =
                    !signaling.isConnected() &&
                    !rtc::signaling_lifecycle_test::socketIsOpen(0);
                logicalDisconnectObserved.store(
                    logicallyDisconnected,
                    std::memory_order_release);
                std::cout << "LIFECYCLE_BRANCH:cross-thread:logical-disconnect="
                          << (logicallyDisconnected ? "true" : "false") << std::endl;
                firstReconnectResult.store(
                    signaling.connect("ws://lifecycle.test/reconnect-during-callback"),
                    std::memory_order_release);
                {
                    std::lock_guard<std::mutex> lock(completionMutex);
                    reconnectComplete = true;
                }
                completionCv.notify_all();
            });

            callbackEntered.store(true, std::memory_order_release);
            std::cout << "LIFECYCLE_BRANCH:cross-thread:callback-entered" << std::endl;
            std::unique_lock<std::mutex> lock(completionMutex);
            completionCv.wait(lock, [&]() { return reconnectComplete; });
            callbackExited.store(true, std::memory_order_release);
            std::cout << "LIFECYCLE_BRANCH:cross-thread:callback-exited" << std::endl;
        });

        if (!rtc::signaling_lifecycle_test::emitTextOnLatest(kAlertMessage) ||
            !waitUntil(
                [&]() { return callbackEntered.load(std::memory_order_acquire); },
                1500ms)) {
            return failScenario(scenario, "callback-did-not-enter");
        }

        if (!waitUntil(
                [&]() { return callbackExited.load(std::memory_order_acquire); },
                1500ms)) {
            std::cout << "LIFECYCLE_BRANCH:cross-thread:cycle-observed" << std::endl;
            // The supervisor owns the bound and reaps this expendable child.
            for (;;) {
                std::this_thread::sleep_for(1s);
            }
        }

        rtc::signaling_lifecycle_test::joinCallbacks();
        if (reconnectThread.joinable()) {
            reconnectThread.join();
        }
        if (!disconnectReturned.load(std::memory_order_acquire)) {
            return failScenario(scenario, "disconnect-did-not-return");
        }
        if (!logicalDisconnectObserved.load(std::memory_order_acquire)) {
            return failScenario(scenario, "disconnect-left-transport-active");
        }
        if (firstReconnectResult.load(std::memory_order_acquire)) {
            return failScenario(scenario, "reconnect-did-not-fail-fast");
        }

        signaling.onAlert(VdoSignaling::AlertCallback{});
        const bool externalReconnect =
            signaling.connect("ws://lifecycle.test/external-reconnect");
        std::cout << "LIFECYCLE_BRANCH:cross-thread:external-reconnect="
                  << (externalReconnect ? "true" : "false") << std::endl;
        if (!externalReconnect) {
            return failScenario(scenario, "external-reconnect-failed");
        }
        signaling.disconnect();
    }

    rtc::signaling_lifecycle_test::joinCallbacks();
    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runPreAdmissionDestruction() {
    const std::string scenario = "pre-admission-destruction-waits";
    rtc::signaling_lifecycle_test::reset();

    auto signaling = std::make_unique<VdoSignaling>();
    if (!signaling->connect("ws://lifecycle.test/initial")) {
        return failScenario(scenario, "initial-connect-failed");
    }

    std::atomic<int> alertCallbacks{0};
    std::atomic<bool> destructionReturned{false};
    signaling->onAlert([&](const std::string &) {
        alertCallbacks.fetch_add(1, std::memory_order_acq_rel);
    });

    rtc::signaling_lifecycle_test::holdNextTextBeforeDispatch();
    if (!rtc::signaling_lifecycle_test::emitTextOnLatest(kAlertMessage) ||
        !rtc::signaling_lifecycle_test::waitForHeldText(1500)) {
        rtc::signaling_lifecycle_test::releaseHeldText();
        return failScenario(scenario, "transport-callback-did-not-hold");
    }
    std::cout << "LIFECYCLE_BRANCH:pre-admission:transport-callback-held" << std::endl;

    std::thread destroyer([&]() {
        signaling.reset();
        destructionReturned.store(true, std::memory_order_release);
        std::cout << "LIFECYCLE_BRANCH:pre-admission:destruction-returned" << std::endl;
    });

    std::this_thread::sleep_for(100ms);
    const bool returnedWhileHeld = destructionReturned.load(std::memory_order_acquire);
    rtc::signaling_lifecycle_test::releaseHeldText();
    rtc::signaling_lifecycle_test::joinCallbacks();
    destroyer.join();

    if (returnedWhileHeld || !destructionReturned.load(std::memory_order_acquire)) {
        rtc::signaling_lifecycle_test::reset();
        return failScenario(scenario, "destruction-did-not-wait-before-admission");
    }
    if (alertCallbacks.load(std::memory_order_acquire) != 0) {
        rtc::signaling_lifecycle_test::reset();
        return failScenario(scenario, "stale-user-callback-was-admitted");
    }

    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runExternalDestruction() {
    const std::string scenario = "external-destruction-waits";
    rtc::signaling_lifecycle_test::reset();

    auto signaling = std::make_unique<VdoSignaling>();
    if (!signaling->connect("ws://lifecycle.test/initial")) {
        return failScenario(scenario, "initial-connect-failed");
    }

    std::mutex callbackMutex;
    std::condition_variable callbackCv;
    bool callbackEntered = false;
    bool releaseCallback = false;
    std::atomic<bool> destructionReturned{false};

    signaling->onAlert([&](const std::string &) {
        std::unique_lock<std::mutex> lock(callbackMutex);
        callbackEntered = true;
        std::cout << "LIFECYCLE_BRANCH:destruction:callback-entered" << std::endl;
        callbackCv.notify_all();
        callbackCv.wait(lock, [&]() { return releaseCallback; });
        std::cout << "LIFECYCLE_BRANCH:destruction:callback-released" << std::endl;
    });

    if (!rtc::signaling_lifecycle_test::emitTextOnLatest(kAlertMessage)) {
        return failScenario(scenario, "message-not-delivered");
    }
    {
        std::unique_lock<std::mutex> lock(callbackMutex);
        if (!callbackCv.wait_for(lock, 1500ms, [&]() { return callbackEntered; })) {
            return failScenario(scenario, "callback-did-not-enter");
        }
    }

    std::thread destroyer([&]() {
        signaling.reset();
        destructionReturned.store(true, std::memory_order_release);
        std::cout << "LIFECYCLE_BRANCH:destruction:returned" << std::endl;
    });

    std::this_thread::sleep_for(100ms);
    const bool returnedWhileHeld = destructionReturned.load(std::memory_order_acquire);
    {
        std::lock_guard<std::mutex> lock(callbackMutex);
        releaseCallback = true;
    }
    callbackCv.notify_all();
    rtc::signaling_lifecycle_test::joinCallbacks();
    destroyer.join();

    if (returnedWhileHeld || !destructionReturned.load(std::memory_order_acquire)) {
        rtc::signaling_lifecycle_test::reset();
        return failScenario(scenario, "destruction-did-not-wait-for-callback");
    }

    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runOldSocketIsolation() {
    const std::string scenario = "old-socket-isolation";
    rtc::signaling_lifecycle_test::reset();
    std::atomic<int> disconnectedCallbacks{0};

    {
        VdoSignaling signaling;
        signaling.onDisconnected([&]() {
            disconnectedCallbacks.fetch_add(1, std::memory_order_acq_rel);
        });
        if (!signaling.connect("ws://lifecycle.test/first")) {
            return failScenario(scenario, "first-connect-failed");
        }
        if (rtc::signaling_lifecycle_test::socketCount() != 1) {
            return failScenario(scenario, "first-socket-not-created");
        }

        signaling.disconnect();
        if (!signaling.connect("ws://lifecycle.test/second")) {
            return failScenario(scenario, "second-connect-failed");
        }
        if (rtc::signaling_lifecycle_test::socketCount() != 2 ||
            !rtc::signaling_lifecycle_test::latestSocketIsOpen()) {
            return failScenario(scenario, "replacement-socket-not-current");
        }

        if (!rtc::signaling_lifecycle_test::emitClosed(0)) {
            return failScenario(scenario, "old-close-not-delivered");
        }
        rtc::signaling_lifecycle_test::joinCallbacks();
        if (!signaling.isConnected() ||
            disconnectedCallbacks.load(std::memory_order_acquire) != 0) {
            return failScenario(scenario, "old-callback-mutated-current-state");
        }
        std::cout << "LIFECYCLE_BRANCH:old-socket:ignored" << std::endl;
        signaling.disconnect();
    }

    rtc::signaling_lifecycle_test::joinCallbacks();
    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runSendSuccessControl() {
    const std::string scenario = "send-success-control";
    rtc::signaling_lifecycle_test::reset();

    VdoSignaling signaling;
    signaling.disableEncryption();
    if (!signaling.connect("ws://lifecycle.test/send-success")) {
        return failScenario(scenario, "connect-failed");
    }
    const versus::signaling::SignalOffer offer{
        "viewer-success",
        "v=0\r\n",
        "session-success",
        "stream-success",
    };
    if (!signaling.publish("stream-success", "") || !signaling.sendOffer(offer)) {
        return failScenario(scenario, "successful-send-reported-failure");
    }
    if (rtc::signaling_lifecycle_test::sentMessageCount() != 2) {
        return failScenario(scenario, "successful-send-was-not-recorded");
    }

    signaling.disconnect();
    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runSendFalseReportsFailure() {
    const std::string scenario = "send-false-reports-failure";
    rtc::signaling_lifecycle_test::reset();

    VdoSignaling signaling;
    if (!signaling.connect("ws://lifecycle.test/send-false")) {
        return failScenario(scenario, "connect-failed");
    }
    rtc::signaling_lifecycle_test::failNextSend();
    bool published = true;
    try {
        published = signaling.publish("stream-false", "");
    } catch (...) {
        return failScenario(scenario, "send-false-leaked-exception");
    }
    if (published) {
        return failScenario(scenario, "send-false-reported-success");
    }
    if (rtc::signaling_lifecycle_test::sentMessageCount() != 0) {
        return failScenario(scenario, "failed-send-was-recorded");
    }

    signaling.disconnect();
    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runSendThrowIsContained() {
    const std::string scenario = "send-throw-is-contained";
    rtc::signaling_lifecycle_test::reset();

    VdoSignaling signaling;
    signaling.disableEncryption();
    if (!signaling.connect("ws://lifecycle.test/send-throw")) {
        return failScenario(scenario, "connect-failed");
    }
    const versus::signaling::SignalOffer offer{
        "viewer-throw",
        "v=0\r\n",
        "session-throw",
        "stream-throw",
    };
    rtc::signaling_lifecycle_test::throwNextSend();
    bool sent = true;
    try {
        sent = signaling.sendOffer(offer);
    } catch (...) {
        return failScenario(scenario, "send-exception-escaped");
    }
    if (sent) {
        return failScenario(scenario, "send-exception-reported-success");
    }
    if (rtc::signaling_lifecycle_test::sentMessageCount() != 0) {
        return failScenario(scenario, "throwing-send-was-recorded");
    }

    signaling.disconnect();
    rtc::signaling_lifecycle_test::reset();
    return passScenario(scenario);
}

int runChild(const QString &scenario) {
    if (scenario == QStringLiteral("control-hang")) {
        std::cout << "CONTROL_HANG_ENTERED" << std::endl;
        for (;;) {
            std::this_thread::sleep_for(1s);
        }
    }
    if (scenario == QStringLiteral("control-abort")) {
        std::cout << "CONTROL_ABORT_ENTERED" << std::endl;
        std::abort();
    }
    if (scenario == QStringLiteral("same-thread-disconnect")) {
        return runSameThreadDisconnect();
    }
    if (scenario == QStringLiteral("cross-thread-reconnect")) {
        return runCrossThreadReconnect();
    }
    if (scenario == QStringLiteral("external-destruction-waits")) {
        return runExternalDestruction();
    }
    if (scenario == QStringLiteral("pre-admission-destruction-waits")) {
        return runPreAdmissionDestruction();
    }
    if (scenario == QStringLiteral("old-socket-isolation")) {
        return runOldSocketIsolation();
    }
    if (scenario == QStringLiteral("send-success-control")) {
        return runSendSuccessControl();
    }
    if (scenario == QStringLiteral("send-false-reports-failure")) {
        return runSendFalseReportsFailure();
    }
    if (scenario == QStringLiteral("send-throw-is-contained")) {
        return runSendThrowIsContained();
    }
    std::cout << "UNKNOWN_SCENARIO:" << scenario.toStdString() << std::endl;
    return 64;
}

enum class ChildDisposition {
    Normal,
    Crash,
    Timeout,
    StartFailure
};

struct ChildResult {
    ChildDisposition disposition = ChildDisposition::StartFailure;
    int exitCode = -1;
    QString output;
};

ChildResult supervise(const QString &scenario, int timeoutMs) {
    QProcess process;
    process.setProcessChannelMode(QProcess::MergedChannels);
    process.start(
        QCoreApplication::applicationFilePath(),
        {QStringLiteral("--child"), scenario});
    if (!process.waitForStarted(2000)) {
        return {ChildDisposition::StartFailure, -1, process.errorString()};
    }
    if (!process.waitForFinished(timeoutMs)) {
        process.kill();
        process.waitForFinished(2000);
        return {
            ChildDisposition::Timeout,
            process.exitCode(),
            QString::fromUtf8(process.readAll())};
    }
    return {
        process.exitStatus() == QProcess::CrashExit
            ? ChildDisposition::Crash
            : ChildDisposition::Normal,
        process.exitCode(),
        QString::fromUtf8(process.readAll())};
}

bool outputContains(const ChildResult &result, const QString &sentinel) {
    return result.output.contains(sentinel, Qt::CaseSensitive);
}

int runSupervisor() {
    int accepted = 0;
    int rejected = 0;

    const auto record = [&](const QString &name, bool ok, const ChildResult &result) {
        std::cout << (ok ? "[LIFECYCLE GATE PASS] " : "[LIFECYCLE GATE FAIL] ")
                  << name.toStdString()
                  << " disposition=" << static_cast<int>(result.disposition)
                  << " exit=" << result.exitCode << std::endl;
        std::cout << result.output.toStdString();
        if (ok) {
            ++accepted;
        } else {
            ++rejected;
        }
    };

    const ChildResult hangControl = supervise(QStringLiteral("control-hang"), 400);
    record(
        QStringLiteral("control-hang"),
        hangControl.disposition == ChildDisposition::Timeout &&
            outputContains(hangControl, QStringLiteral("CONTROL_HANG_ENTERED")),
        hangControl);

    const ChildResult abortControl = supervise(QStringLiteral("control-abort"), 5000);
    record(
        QStringLiteral("control-abort"),
        abortControl.disposition == ChildDisposition::Crash &&
            outputContains(abortControl, QStringLiteral("CONTROL_ABORT_ENTERED")),
        abortControl);

    for (const QString &scenario : {
             QStringLiteral("same-thread-disconnect"),
             QStringLiteral("external-destruction-waits"),
             QStringLiteral("pre-admission-destruction-waits"),
             QStringLiteral("old-socket-isolation"),
             QStringLiteral("send-success-control"),
             QStringLiteral("send-false-reports-failure"),
             QStringLiteral("send-throw-is-contained"),
         }) {
        const ChildResult result = supervise(scenario, 4000);
        record(
            scenario,
            result.disposition == ChildDisposition::Normal &&
                result.exitCode == 0 &&
                outputContains(result, QStringLiteral("SCENARIO_PASS:") + scenario),
            result);
    }

    const QString cycleScenario = QStringLiteral("cross-thread-reconnect");
    const ChildResult cycle = supervise(cycleScenario, 4000);
    record(
        cycleScenario,
        cycle.disposition == ChildDisposition::Normal &&
            cycle.exitCode == 0 &&
            outputContains(cycle, QStringLiteral("SCENARIO_PASS:") + cycleScenario) &&
            outputContains(
                cycle,
                QStringLiteral("LIFECYCLE_BRANCH:cross-thread:disconnect-returned")) &&
            outputContains(
                cycle,
                QStringLiteral("LIFECYCLE_BRANCH:cross-thread:external-reconnect=true")),
        cycle);

    std::cout << "[LIFECYCLE GATE SUMMARY] accepted=" << accepted
              << " rejected=" << rejected << " total=" << (accepted + rejected)
              << std::endl;
    return rejected == 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char **argv) {
    QCoreApplication application(argc, argv);
    const QStringList arguments = application.arguments();
    if (arguments.size() == 3 && arguments[1] == QStringLiteral("--child")) {
        return runChild(arguments[2]);
    }
    return runSupervisor();
}
