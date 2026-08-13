#include <QtCore/QCryptographicHash>
#include <QtTest/QtTest>

#include <algorithm>
#include <cstdint>
#include <deque>
#include <functional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "versus/webrtc/ice_config.h"

namespace {

using versus::webrtc::IceConfigDependencies;
using versus::webrtc::IceMode;
using versus::webrtc::IceServerConfig;
using versus::webrtc::ResolvedIceConfig;
using versus::webrtc::TurnRegistryHttpResponse;
using versus::webrtc::TurnRegistryOutcome;
using versus::webrtc::TurnRegistryRequest;

constexpr std::int64_t kTurnListEpochOffsetMs = 1653305816700LL;
constexpr int kTimeoutMs = 4321;

const std::string kValidSingleServer =
    R"({"version":1,"servers":[{"urls":"turn:one.invalid:3478","username":"user-one","credential":"credential-one","udp":true}]})";

QString qString(const std::string &value) {
    return QString::fromStdString(value);
}

std::string sha256(const std::string &value) {
    return QCryptographicHash::hash(QByteArray::fromStdString(value), QCryptographicHash::Sha256)
        .toHex()
        .toStdString();
}

TurnRegistryHttpResponse httpResponse(
    std::string body,
    int status = 200,
    bool transportSucceeded = true) {
    TurnRegistryHttpResponse response;
    response.transportSucceeded = transportSucceeded;
    response.httpStatus = status;
    response.body = std::move(body);
    return response;
}

class ScriptedRegistry {
  public:
    std::deque<TurnRegistryHttpResponse> responses;
    std::vector<TurnRegistryRequest> requests;
    std::vector<std::string> diagnostics;

    IceConfigDependencies dependencies() {
        IceConfigDependencies result;
        result.fetchTurnRegistry = [this](const TurnRegistryRequest &request) {
            requests.push_back(request);
            if (responses.empty()) {
                return httpResponse({}, 0, false);
            }
            TurnRegistryHttpResponse response = std::move(responses.front());
            responses.pop_front();
            return response;
        };
        result.emitDiagnostic = [this](std::string_view diagnostic) {
            diagnostics.emplace_back(diagnostic);
        };
        return result;
    }
};

ResolvedIceConfig resolve(
    IceMode mode,
    ScriptedRegistry &registry,
    int timeoutMs = kTimeoutMs) {
    const auto dependencies = registry.dependencies();
    return versus::webrtc::resolveIceConfigWithDependencies(mode, timeoutMs, dependencies);
}

std::vector<IceServerConfig> collectTurnServers(const ResolvedIceConfig &resolved) {
    std::vector<IceServerConfig> turns;
    for (const auto &server : resolved.servers) {
        if (server.url.starts_with("turn:") || server.url.starts_with("turns:")) {
            turns.push_back(server);
        }
    }
    return turns;
}

void compareServer(
    const IceServerConfig &actual,
    const std::string &url,
    const std::string &username,
    const std::string &credential,
    bool udp) {
    QCOMPARE(qString(actual.url), qString(url));
    QCOMPARE(qString(actual.username), qString(username));
    QCOMPARE(qString(actual.credential), qString(credential));
    QCOMPARE(actual.udp, udp);
}

void expectNoTurn(
    const ResolvedIceConfig &resolved,
    TurnRegistryOutcome expectedOutcome,
    bool fetchSucceeded) {
    QVERIFY(collectTurnServers(resolved).empty());
    QVERIFY(!resolved.usedFallbackTurnList);
    QVERIFY(!resolved.turn.configAccepted);
    QCOMPARE(static_cast<int>(resolved.turn.outcome), static_cast<int>(expectedOutcome));
    QCOMPARE(resolved.turn.fetchSucceeded, fetchSucceeded);
    QVERIFY(resolved.turn.canonicalConfigSha256.empty());
}

ResolvedIceConfig accepted(const std::string &body, ScriptedRegistry *outRegistry = nullptr) {
    ScriptedRegistry local;
    ScriptedRegistry &registry = outRegistry == nullptr ? local : *outRegistry;
    registry.responses.push_back(httpResponse(body));
    return resolve(IceMode::Relay, registry);
}

std::string fingerprint(const std::string &body) {
    return accepted(body).turn.canonicalConfigSha256;
}

}  // namespace

class TestIceConfig : public QObject {
    Q_OBJECT

  private slots:
    void testModeRoutingFetchCountsAndRequestContract();
    void testHttpStatusAndVersionContract();
    void testSchemaValidationIsAtomic();
    void testScalarAndArrayUrlsWithAdditiveMetadata();
    void testFlattenPreservesEveryUrlOrderAndValue();
    void testFailureOutcomesPublishNoTurnAndNoFallback();
    void testAutoModeDegradesToStunWhenTurnRegistryUnavailable();
    void testDynamicResponseCounts();
    void testFullOrderedConfigFingerprintSensitivity();
    void testPeerBindingRequiresExactRegistryConsumption();
    void testDiagnosticsRedactCredentialsAndRawPayload();
    void testIndependentResolutionCyclesRefetchAndReplace();
    void testMissingDependenciesFailClosed();
    void testFilterSessionDescriptionForHostOnly();
    void testFilterSessionDescriptionForStunOnly();
    void testCandidateAllowedForMode();
};

void TestIceConfig::testModeRoutingFetchCountsAndRequestContract() {
    for (const IceMode mode : {IceMode::All, IceMode::Relay, IceMode::HostOnly, IceMode::StunOnly}) {
        ScriptedRegistry registry;
        registry.responses.push_back(httpResponse(kValidSingleServer));

        const ResolvedIceConfig result = resolve(mode, registry);
        const bool mustFetch = mode == IceMode::All || mode == IceMode::Relay;
        QCOMPARE(registry.requests.size(), mustFetch ? std::size_t{1} : std::size_t{0});

        if (!mustFetch) {
            QVERIFY(collectTurnServers(result).empty());
            QVERIFY(!result.turn.fetchAttempted);
            QCOMPARE(
                static_cast<int>(result.turn.outcome),
                static_cast<int>(TurnRegistryOutcome::NotRequired));
            continue;
        }

        const TurnRegistryRequest &request = registry.requests.front();
        QVERIFY(request.timestampUnixMs > kTurnListEpochOffsetMs);
        QVERIFY(!request.transactionId.empty());
        QCOMPARE(request.timeoutMs, kTimeoutMs);
        QCOMPARE(
            qString(request.url),
            qString(
                "https://turnservers.vdo.ninja/?ts=" +
                std::to_string(request.timestampUnixMs - kTurnListEpochOffsetMs)));

        QVERIFY(result.turn.fetchAttempted);
        QVERIFY(result.turn.fetchSucceeded);
        QVERIFY(result.turn.configAccepted);
        QCOMPARE(qString(result.turn.sourceUrl), qString(request.url));
        QCOMPARE(qString(result.turn.transactionId), qString(request.transactionId));
        QCOMPARE(result.turn.requestTimestampUnixMs, request.timestampUnixMs);
        QCOMPARE(result.turn.timeoutMs, request.timeoutMs);
        QCOMPARE(result.turn.httpStatus, 200);
        QCOMPARE(collectTurnServers(result).size(), std::size_t{1});
    }
}

void TestIceConfig::testHttpStatusAndVersionContract() {
    {
        ScriptedRegistry registry;
        registry.responses.push_back(httpResponse(kValidSingleServer, 201));
        const ResolvedIceConfig result = resolve(IceMode::Relay, registry);
        expectNoTurn(result, TurnRegistryOutcome::HttpStatusFailure, false);
        QCOMPARE(result.turn.httpStatus, 201);
    }
    {
        const std::string wrongVersion =
            R"({"version":2,"servers":[{"urls":"turn:version.invalid:3478","username":"user","credential":"secret","udp":true}]})";
        ScriptedRegistry registry;
        registry.responses.push_back(httpResponse(wrongVersion));
        const ResolvedIceConfig result = resolve(IceMode::Relay, registry);
        expectNoTurn(result, TurnRegistryOutcome::InvalidSchema, true);
        QCOMPARE(result.turn.responseVersion, 2);
    }
    {
        const ResolvedIceConfig result = accepted(kValidSingleServer);
        QCOMPARE(result.turn.httpStatus, 200);
        QCOMPARE(result.turn.responseVersion, 1);
    }
}

void TestIceConfig::testSchemaValidationIsAtomic() {
    const std::vector<std::string> invalidBodies = {
        R"([])",
        R"({"servers":[]})",
        R"({"version":"1","servers":[]})",
        R"({"version":2,"servers":[]})",
        R"({"version":1})",
        R"({"version":1,"servers":{}})",
        R"({"version":1,"servers":[]})",
        R"({"version":1,"servers":["not-an-object"]})",
        R"({"version":1,"servers":[{"url":"turn:legacy.invalid:3478","username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:no-user.invalid:3478","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:empty-user.invalid:3478","username":"","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:user-type.invalid:3478","username":7,"credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:no-credential.invalid:3478","username":"user","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:empty-credential.invalid:3478","username":"user","credential":"","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:credential-type.invalid:3478","username":"user","credential":7,"udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:no-udp.invalid:3478","username":"user","credential":"secret"}]})",
        R"({"version":1,"servers":[{"urls":"turn:udp-type.invalid:3478","username":"user","credential":"secret","udp":"true"}]})",
        R"({"version":1,"servers":[{"username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"","username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":[],"username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":["turn:one.invalid:3478",7],"username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"stun:not-turn.invalid:3478","username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:","username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:control.invalid:3478\u0000suffix","username":"user","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:control.invalid:3478","username":"user\u0000suffix","credential":"secret","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:control.invalid:3478","username":"user","credential":"secret\u0007suffix","udp":true}]})",
        R"({"version":1,"servers":[{"urls":"turn:valid-first.invalid:3478","username":"user","credential":"secret","udp":true},{"urls":[],"username":"user","credential":"secret","udp":true}]})",
    };

    for (const std::string &body : invalidBodies) {
        ScriptedRegistry registry;
        registry.responses.push_back(httpResponse(body));
        const ResolvedIceConfig result = resolve(IceMode::Relay, registry);
        expectNoTurn(result, TurnRegistryOutcome::InvalidSchema, true);
        QCOMPARE(result.turn.responseServerCount, std::size_t{0});
        QCOMPARE(result.turn.responseUrlCount, std::size_t{0});
    }
}

void TestIceConfig::testScalarAndArrayUrlsWithAdditiveMetadata() {
    const std::string body =
        R"({"version":1,"generatedBy":"fixture","servers":[{"urls":"turn:scalar.invalid:3478","username":"scalar-user","credential":"scalar-secret","udp":true,"distance":999,"future":{"safe":true}},{"urls":["turn:array-a.invalid:3478","turns:array-b.invalid:443"],"username":"array-user","credential":"array-secret","udp":false,"tz":-60}]})";
    const ResolvedIceConfig result = accepted(body);
    const auto turns = collectTurnServers(result);

    QCOMPARE(turns.size(), std::size_t{3});
    compareServer(turns[0], "turn:scalar.invalid:3478", "scalar-user", "scalar-secret", true);
    compareServer(turns[1], "turn:array-a.invalid:3478", "array-user", "array-secret", false);
    compareServer(turns[2], "turns:array-b.invalid:443", "array-user", "array-secret", false);
    QCOMPARE(result.turn.responseServerCount, std::size_t{2});
    QCOMPARE(result.turn.responseUrlCount, std::size_t{3});
}

void TestIceConfig::testFlattenPreservesEveryUrlOrderAndValue() {
    const std::string body =
        R"({"version":1,"servers":[{"urls":["turn:first.invalid:3478","turn:second.invalid:3478","turns:third.invalid:443","turn:fourth.invalid:3478"],"username":"array-user","credential":"array-secret","udp":true,"distance":5000},{"urls":"turn:fifth.invalid:3478","username":"scalar-user","credential":"scalar-secret","udp":false,"tz":0}]})";
    const ResolvedIceConfig result = accepted(body);
    const auto turns = collectTurnServers(result);

    QCOMPARE(turns.size(), std::size_t{5});
    QCOMPARE(qString(turns[0].url), QString("turn:first.invalid:3478"));
    QCOMPARE(qString(turns[1].url), QString("turn:second.invalid:3478"));
    QCOMPARE(qString(turns[2].url), QString("turns:third.invalid:443"));
    QCOMPARE(qString(turns[3].url), QString("turn:fourth.invalid:3478"));
    QCOMPARE(qString(turns[4].url), QString("turn:fifth.invalid:3478"));
}

void TestIceConfig::testFailureOutcomesPublishNoTurnAndNoFallback() {
    struct Case {
        TurnRegistryHttpResponse response;
        TurnRegistryOutcome outcome;
        bool fetchSucceeded;
    };
    const std::vector<Case> cases = {
        {httpResponse({}, 0, false), TurnRegistryOutcome::TransportFailure, false},
        {httpResponse(kValidSingleServer, 503), TurnRegistryOutcome::HttpStatusFailure, false},
        {httpResponse(""), TurnRegistryOutcome::EmptyBody, true},
        {httpResponse(" \r\n\t "), TurnRegistryOutcome::EmptyBody, true},
        {httpResponse("{not-json"), TurnRegistryOutcome::InvalidJson, true},
        {httpResponse(R"({"version":1,"servers":[]})"), TurnRegistryOutcome::InvalidSchema, true},
    };

    for (const Case &item : cases) {
        ScriptedRegistry registry;
        registry.responses.push_back(item.response);
        const ResolvedIceConfig result = resolve(IceMode::Relay, registry);
        expectNoTurn(result, item.outcome, item.fetchSucceeded);
        QVERIFY(result.turn.fetchAttempted);
        QCOMPARE(registry.requests.size(), std::size_t{1});
    }
}

void TestIceConfig::testAutoModeDegradesToStunWhenTurnRegistryUnavailable() {
    struct Case {
        TurnRegistryHttpResponse response;
        TurnRegistryOutcome outcome;
        bool fetchSucceeded;
    };
    const std::vector<Case> cases = {
        {httpResponse({}, 0, false), TurnRegistryOutcome::TransportFailure, false},
        {httpResponse(kValidSingleServer, 503), TurnRegistryOutcome::HttpStatusFailure, false},
        {httpResponse(""), TurnRegistryOutcome::EmptyBody, true},
        {httpResponse("{not-json"), TurnRegistryOutcome::InvalidJson, true},
        {httpResponse(R"({"version":1,"servers":[]})"), TurnRegistryOutcome::InvalidSchema, true},
    };

    for (const Case &item : cases) {
        ScriptedRegistry registry;
        registry.responses.push_back(item.response);
        const ResolvedIceConfig result = resolve(IceMode::All, registry);
        expectNoTurn(result, item.outcome, item.fetchSucceeded);
        QVERIFY(std::any_of(
            result.servers.begin(),
            result.servers.end(),
            [](const IceServerConfig &server) { return server.url.starts_with("stun:"); }));

        const auto automatic = versus::webrtc::validateIceConfigBinding(
            IceMode::All,
            result.servers,
            result.turn);
        QVERIFY2(
            automatic.accepted,
            qPrintable(
                QString("Auto mode should retain direct STUN connectivity after TURN failure: %1")
                    .arg(qString(automatic.failureReason))));
        QCOMPARE(automatic.turnServerCount, std::size_t{0});

        const auto relayOnly = versus::webrtc::validateIceConfigBinding(
            IceMode::Relay,
            result.servers,
            result.turn);
        QVERIFY2(!relayOnly.accepted, "Relay-only mode must fail closed without TURN");
        QCOMPARE(qString(relayOnly.failureReason), QString("turn-registry-no-turn-servers"));
    }

    ScriptedRegistry registry;
    registry.responses.push_back(httpResponse({}, 0, false));
    const ResolvedIceConfig failed = resolve(IceMode::All, registry);
    const auto missingFailureProvenance = versus::webrtc::validateIceConfigBinding(
        IceMode::All,
        failed.servers,
        {});
    QVERIFY2(
        !missingFailureProvenance.accepted,
        "Auto mode must not degrade without recorded registry-failure provenance");
}

void TestIceConfig::testDynamicResponseCounts() {
    const std::string body =
        R"({"version":1,"servers":[{"urls":["turn:count-a.invalid:3478","turn:count-b.invalid:3478","turns:count-c.invalid:443"],"username":"user-a","credential":"secret-a","udp":true},{"urls":"turn:count-d.invalid:3478","username":"user-b","credential":"secret-b","udp":false},{"urls":["turn:count-e.invalid:3478","turns:count-f.invalid:443"],"username":"user-c","credential":"secret-c","udp":true}]})";
    const ResolvedIceConfig result = accepted(body);

    QCOMPARE(result.turn.responseVersion, 1);
    QCOMPARE(result.turn.responseServerCount, std::size_t{3});
    QCOMPARE(result.turn.responseUrlCount, std::size_t{6});
    QCOMPARE(collectTurnServers(result).size(), std::size_t{6});
    QCOMPARE(qString(result.turn.rawResponseSha256), qString(sha256(body)));
}

void TestIceConfig::testFullOrderedConfigFingerprintSensitivity() {
    const std::string baseline =
        R"({"version":1,"servers":[{"urls":["turn:fingerprint-a.invalid:3478","turns:fingerprint-b.invalid:443"],"username":"user-a","credential":"secret-a","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})";
    const std::string expectedCanonical =
        "game-capture-turn-registry-config-v1\n"
        R"([{"urls":["turn:fingerprint-a.invalid:3478","turns:fingerprint-b.invalid:443"],"username":"user-a","credential":"secret-a","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}])";
    const std::string expectedConsumedCanonical =
        "game-capture-consumed-turn-config-v1\n"
        R"([{"url":"turn:fingerprint-a.invalid:3478","username":"user-a","credential":"secret-a","udp":true},{"url":"turns:fingerprint-b.invalid:443","username":"user-a","credential":"secret-a","udp":true},{"url":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}])";
    const ResolvedIceConfig baselineResolved = accepted(baseline);
    const std::string baselineFingerprint = baselineResolved.turn.canonicalConfigSha256;
    const std::string baselineConsumedFingerprint =
        baselineResolved.turn.consumedConfigSha256;
    QCOMPARE(qString(baselineFingerprint), qString(sha256(expectedCanonical)));
    QCOMPARE(
        qString(baselineConsumedFingerprint),
        qString(sha256(expectedConsumedCanonical)));

    const std::vector<std::string> mutations = {
        R"({"version":1,"servers":[{"urls":["turn:fingerprint-z.invalid:3478","turns:fingerprint-b.invalid:443"],"username":"user-a","credential":"secret-a","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})",
        R"({"version":1,"servers":[{"urls":["turn:fingerprint-a.invalid:3478","turns:fingerprint-b.invalid:443"],"username":"user-z","credential":"secret-a","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})",
        R"({"version":1,"servers":[{"urls":["turn:fingerprint-a.invalid:3478","turns:fingerprint-b.invalid:443"],"username":"user-a","credential":"secret-z","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})",
        R"({"version":1,"servers":[{"urls":["turn:fingerprint-a.invalid:3478","turns:fingerprint-b.invalid:443"],"username":"user-a","credential":"secret-a","udp":false},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})",
        R"({"version":1,"servers":[{"urls":["turns:fingerprint-b.invalid:443","turn:fingerprint-a.invalid:3478"],"username":"user-a","credential":"secret-a","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})",
        R"({"version":1,"servers":[{"urls":"turn:fingerprint-a.invalid:3478","username":"user-a","credential":"secret-a","udp":true},{"urls":["turns:fingerprint-b.invalid:443"],"username":"user-a","credential":"secret-a","udp":true},{"urls":"turn:fingerprint-c.invalid:3478","username":"user-b","credential":"secret-b","udp":false}]})",
    };

    for (std::size_t index = 0; index < mutations.size(); ++index) {
        const ResolvedIceConfig mutated = accepted(mutations[index]);
        QVERIFY(mutated.turn.canonicalConfigSha256 != baselineFingerprint);
        if (index + 1 == mutations.size()) {
            QCOMPARE(
                qString(mutated.turn.consumedConfigSha256),
                qString(baselineConsumedFingerprint));
        } else {
            QVERIFY(mutated.turn.consumedConfigSha256 != baselineConsumedFingerprint);
        }
    }
}

void TestIceConfig::testPeerBindingRequiresExactRegistryConsumption() {
    const std::string body =
        R"({"version":1,"servers":[{"urls":["turn:binding-a.invalid:3478","turns:binding-b.invalid:443"],"username":"binding-user","credential":"binding-secret","udp":true}]})";
    const ResolvedIceConfig resolved = accepted(body);

    for (const IceMode mode : {IceMode::All, IceMode::Relay}) {
        const auto validation = versus::webrtc::validateIceConfigBinding(
            mode,
            resolved.servers,
            resolved.turn);
        QVERIFY2(validation.accepted, validation.failureReason.c_str());
        QCOMPARE(validation.iceServerCount, resolved.servers.size());
        QCOMPARE(validation.turnServerCount, std::size_t{2});
        QCOMPARE(
            qString(validation.consumedConfigSha256),
            qString(resolved.turn.consumedConfigSha256));
    }

    const auto expectRejected = [&resolved](
                                    IceMode mode,
                                    std::vector<IceServerConfig> servers,
                                    versus::webrtc::TurnRegistryProvenance provenance,
                                    const char *expectedReason) {
        const auto validation = versus::webrtc::validateIceConfigBinding(
            mode,
            servers,
            provenance);
        QVERIFY2(!validation.accepted, "Invalid ICE registry binding was accepted");
        QCOMPARE(qString(validation.failureReason), QString::fromUtf8(expectedReason));
    };

    expectRejected(
        IceMode::All,
        resolved.servers,
        {},
        "turn-registry-not-accepted");

    auto wrongSource = resolved.turn;
    wrongSource.sourceUrl = "https://not-vdo.invalid/?ts=1";
    expectRejected(
        IceMode::All,
        resolved.servers,
        wrongSource,
        "turn-registry-source-mismatch");

    auto wrongCount = resolved.turn;
    ++wrongCount.responseUrlCount;
    expectRejected(
        IceMode::Relay,
        resolved.servers,
        wrongCount,
        "turn-registry-url-count-mismatch");

    auto wrongFingerprint = resolved.turn;
    wrongFingerprint.consumedConfigSha256.assign(64, '0');
    expectRejected(
        IceMode::Relay,
        resolved.servers,
        wrongFingerprint,
        "turn-registry-consumed-hash-mismatch");

    auto mutatedCredentials = resolved.servers;
    mutatedCredentials.back().credential = "different-secret";
    expectRejected(
        IceMode::All,
        mutatedCredentials,
        resolved.turn,
        "turn-registry-consumed-hash-mismatch");

    auto malformedHash = resolved.turn;
    malformedHash.rawResponseSha256 = "not-a-sha256";
    expectRejected(
        IceMode::All,
        resolved.servers,
        malformedHash,
        "turn-registry-hash-format");

    auto noTurns = resolved.servers;
    noTurns.erase(
        std::remove_if(
            noTurns.begin(),
            noTurns.end(),
            [](const IceServerConfig &server) {
                return server.url.starts_with("turn:") || server.url.starts_with("turns:");
            }),
        noTurns.end());
    expectRejected(
        IceMode::All,
        noTurns,
        resolved.turn,
        "turn-registry-no-turn-servers");

    const versus::webrtc::TurnRegistryProvenance notRequired;
    const auto hostOnly = versus::webrtc::validateIceConfigBinding(
        IceMode::HostOnly,
        {},
        notRequired);
    QVERIFY2(hostOnly.accepted, hostOnly.failureReason.c_str());

    const std::vector<IceServerConfig> stunOnlyServers = {
        {"stun:stun.example.invalid:3478", "", "", true},
    };
    const auto stunOnly = versus::webrtc::validateIceConfigBinding(
        IceMode::StunOnly,
        stunOnlyServers,
        notRequired);
    QVERIFY2(stunOnly.accepted, stunOnly.failureReason.c_str());

    expectRejected(
        IceMode::HostOnly,
        stunOnlyServers,
        notRequired,
        "host-only-has-ice-servers");
    expectRejected(
        IceMode::StunOnly,
        resolved.servers,
        notRequired,
        "turn-servers-not-permitted-for-mode");
}

void TestIceConfig::testDiagnosticsRedactCredentialsAndRawPayload() {
    const std::string body =
        R"({"version":1,"payloadMarker":"RAW_PAYLOAD_DO_NOT_LOG","servers":[{"urls":["turn:diagnostic-a.invalid:3478","turns:diagnostic-b.invalid:443"],"username":"USERNAME_DO_NOT_LOG","credential":"CREDENTIAL_DO_NOT_LOG","udp":true}]})";
    ScriptedRegistry registry;
    registry.responses.push_back(httpResponse(body));
    const ResolvedIceConfig result = resolve(IceMode::Relay, registry);

    QVERIFY(result.turn.configAccepted);
    QCOMPARE(registry.diagnostics.size(), std::size_t{1});
    const std::string &diagnostic = registry.diagnostics.front();
    const std::vector<std::string> requiredFields = {
        "[ICE] TurnRegistryFetch",
        "turnRegistrySourceUrl=" + result.turn.sourceUrl,
        "turnRegistryTransactionId=" + result.turn.transactionId,
        "turnRegistryRequestTimestampUnixMs=" +
            std::to_string(result.turn.requestTimestampUnixMs),
        "turnRegistryTimeoutMs=" + std::to_string(result.turn.timeoutMs),
        "turnRegistryFetchAttempted=true",
        "turnRegistryFetchSucceeded=true",
        "turnRegistryConfigAccepted=true",
        "turnRegistryOutcome=success",
        "turnRegistryHttpStatus=200",
        "turnRegistryResponseVersion=1",
        "turnConfigV1Count=1",
        "turnUrlCount=2",
        "turnRegistryResponseSha256=" + result.turn.rawResponseSha256,
        "turnConfigV1Sha256=" + result.turn.canonicalConfigSha256,
        "consumedConfigSha256=" + result.turn.consumedConfigSha256,
        "turn:diagnostic-a.invalid:3478",
        "turns:diagnostic-b.invalid:443",
    };
    for (const std::string &required : requiredFields) {
        QVERIFY2(diagnostic.find(required) != std::string::npos, required.c_str());
    }
    QVERIFY(diagnostic.find("USERNAME_DO_NOT_LOG") == std::string::npos);
    QVERIFY(diagnostic.find("CREDENTIAL_DO_NOT_LOG") == std::string::npos);
    QVERIFY(diagnostic.find("RAW_PAYLOAD_DO_NOT_LOG") == std::string::npos);
    QVERIFY(diagnostic.find(body) == std::string::npos);

    const auto binding = versus::webrtc::validateIceConfigBinding(
        IceMode::Relay,
        result.servers,
        result.turn);
    QVERIFY2(binding.accepted, binding.failureReason.c_str());
    const std::string consumedDiagnostic = versus::webrtc::consumedIceConfigDiagnostic(
        IceMode::Relay,
        binding,
        result.turn);
    const std::vector<std::string> requiredConsumedFields = {
        "[WebRTC] ConsumedIceConfig",
        "mode=relay",
        "iceServerCount=" + std::to_string(result.servers.size()),
        "turnUrlCount=2",
        "turnConfigV1Count=1",
        "turnRegistrySourceUrl=" + result.turn.sourceUrl,
        "turnRegistryTransactionId=" + result.turn.transactionId,
        "turnRegistryResponseSha256=" + result.turn.rawResponseSha256,
        "turnConfigV1Sha256=" + result.turn.canonicalConfigSha256,
        "consumedConfigSha256=" + result.turn.consumedConfigSha256,
    };
    for (const std::string &required : requiredConsumedFields) {
        QVERIFY2(
            consumedDiagnostic.find(required) != std::string::npos,
            required.c_str());
    }
    QVERIFY(consumedDiagnostic.find("USERNAME_DO_NOT_LOG") == std::string::npos);
    QVERIFY(consumedDiagnostic.find("CREDENTIAL_DO_NOT_LOG") == std::string::npos);
    QVERIFY(consumedDiagnostic.find("RAW_PAYLOAD_DO_NOT_LOG") == std::string::npos);
    QVERIFY(consumedDiagnostic.find(body) == std::string::npos);
}

void TestIceConfig::testIndependentResolutionCyclesRefetchAndReplace() {
    const std::string firstBody =
        R"({"version":1,"servers":[{"urls":"turn:cycle-a.invalid:3478","username":"user-a","credential":"secret-a","udp":true}]})";
    const std::string secondBody =
        R"({"version":1,"servers":[{"urls":["turn:cycle-b.invalid:3478","turns:cycle-c.invalid:443"],"username":"user-b","credential":"secret-b","udp":false}]})";
    ScriptedRegistry registry;
    registry.responses.push_back(httpResponse(firstBody));
    registry.responses.push_back(httpResponse(secondBody));

    const ResolvedIceConfig first = resolve(IceMode::Relay, registry);
    const ResolvedIceConfig second = resolve(IceMode::Relay, registry);
    QCOMPARE(registry.requests.size(), std::size_t{2});
    QCOMPARE(collectTurnServers(first).size(), std::size_t{1});
    QCOMPARE(collectTurnServers(second).size(), std::size_t{2});
    QCOMPARE(qString(collectTurnServers(first)[0].url), QString("turn:cycle-a.invalid:3478"));
    QCOMPARE(qString(collectTurnServers(second)[0].url), QString("turn:cycle-b.invalid:3478"));
    QCOMPARE(qString(collectTurnServers(second)[1].url), QString("turns:cycle-c.invalid:443"));
    QVERIFY(collectTurnServers(second)[0].url != collectTurnServers(first)[0].url);
    QVERIFY(first.turn.transactionId != second.turn.transactionId);
    QVERIFY(first.turn.rawResponseSha256 != second.turn.rawResponseSha256);
    QVERIFY(first.turn.canonicalConfigSha256 != second.turn.canonicalConfigSha256);
    QVERIFY(second.turn.requestTimestampUnixMs >= first.turn.requestTimestampUnixMs);
}

void TestIceConfig::testMissingDependenciesFailClosed() {
    IceConfigDependencies missingFetcher;
    missingFetcher.emitDiagnostic = [](std::string_view) {};
    QVERIFY_EXCEPTION_THROWN(
        versus::webrtc::resolveIceConfigWithDependencies(IceMode::Relay, kTimeoutMs, missingFetcher),
        std::invalid_argument);

    IceConfigDependencies missingDiagnostic;
    missingDiagnostic.fetchTurnRegistry = [](const TurnRegistryRequest &) {
        return httpResponse(kValidSingleServer);
    };
    QVERIFY_EXCEPTION_THROWN(
        versus::webrtc::resolveIceConfigWithDependencies(IceMode::Relay, kTimeoutMs, missingDiagnostic),
        std::invalid_argument);

    const IceConfigDependencies missingBoth;
    QVERIFY_EXCEPTION_THROWN(
        versus::webrtc::resolveIceConfigWithDependencies(IceMode::HostOnly, kTimeoutMs, missingBoth),
        std::invalid_argument);
}

void TestIceConfig::testFilterSessionDescriptionForHostOnly() {
    const std::string input =
        "v=0\r\n"
        "m=video 50596 UDP/TLS/RTP/SAVPF 96\r\n"
        "c=IN IP4 10.0.0.9\r\n"
        "a=candidate:1 1 UDP 2114977535 10.0.0.9 50596 typ host\r\n"
        "a=candidate:2 1 UDP 1678769151 99.246.137.16 50596 typ srflx raddr 0.0.0.0 rport 0\r\n"
        "a=candidate:3 1 UDP 12345 55.66.77.88 3478 typ relay raddr 0.0.0.0 rport 0\r\n";

    const std::string filtered =
        versus::webrtc::filterSessionDescriptionForMode(input, IceMode::HostOnly);

    QVERIFY(filtered.find(" typ srflx") == std::string::npos);
    QVERIFY(filtered.find(" typ relay") == std::string::npos);
    QVERIFY(filtered.find("10.0.0.9") != std::string::npos);
    QVERIFY(filtered.find("c=IN IP4 10.0.0.9") != std::string::npos);
}

void TestIceConfig::testFilterSessionDescriptionForStunOnly() {
    const std::string input =
        "v=0\r\n"
        "m=video 50596 UDP/TLS/RTP/SAVPF 96\r\n"
        "c=IN IP4 10.0.0.9\r\n"
        "a=candidate:1 1 UDP 2114977535 10.0.0.9 50596 typ host\r\n"
        "a=candidate:2 1 UDP 1678769151 99.246.137.16 50596 typ srflx raddr 0.0.0.0 rport 0\r\n"
        "a=candidate:3 1 UDP 12345 55.66.77.88 3478 typ relay raddr 0.0.0.0 rport 0\r\n";

    const std::string filtered =
        versus::webrtc::filterSessionDescriptionForMode(input, IceMode::StunOnly);

    QVERIFY(filtered.find(" typ relay") == std::string::npos);
    QVERIFY(filtered.find(" typ host") == std::string::npos);
    QVERIFY(filtered.find("99.246.137.16") != std::string::npos);
    QVERIFY(filtered.find("c=IN IP4 99.246.137.16") != std::string::npos);
}

void TestIceConfig::testCandidateAllowedForMode() {
    const std::string hostCandidate =
        "candidate:1 1 UDP 2114977535 10.0.0.9 50596 typ host";
    const std::string stunCandidate =
        "candidate:2 1 UDP 1678769151 99.246.137.16 50596 typ srflx raddr 0.0.0.0 rport 0";
    const std::string relayCandidate =
        "candidate:3 1 UDP 12345 55.66.77.88 3478 typ relay raddr 0.0.0.0 rport 0";

    QVERIFY(versus::webrtc::candidateAllowedForMode(hostCandidate, IceMode::HostOnly));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(stunCandidate, IceMode::HostOnly));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(relayCandidate, IceMode::HostOnly));

    QVERIFY(!versus::webrtc::candidateAllowedForMode(hostCandidate, IceMode::StunOnly));
    QVERIFY(versus::webrtc::candidateAllowedForMode(stunCandidate, IceMode::StunOnly));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(relayCandidate, IceMode::StunOnly));

    QVERIFY(!versus::webrtc::candidateAllowedForMode(hostCandidate, IceMode::Relay));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(stunCandidate, IceMode::Relay));
    QVERIFY(versus::webrtc::candidateAllowedForMode(relayCandidate, IceMode::Relay));
}

QTEST_MAIN(TestIceConfig)
#include "test_ice_config.moc"
