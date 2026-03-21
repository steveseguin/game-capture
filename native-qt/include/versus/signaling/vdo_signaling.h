#pragma once

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace versus::signaling {

struct RoomConfig {
    std::string room;
    std::string password;
    std::string streamId;
    std::string label;
    std::string salt = "vdo.ninja";
    bool broadcast = true;
};

struct PeerInfo {
    std::string uuid;
    std::string streamId;
    std::string label;
    bool isPublisher = false;
};

struct SignalOffer {
    std::string uuid;
    std::string sdp;
    std::string session;
    std::string streamId;
};

struct SignalAnswer {
    std::string uuid;
    std::string sdp;
    std::string session;
    std::string streamId;
};

struct SignalCandidate {
    std::string uuid;
    std::string candidate;
    std::string mid;
    int mlineIndex = 0;
    std::string session;
    std::string type;
};

struct ParsedSignalMessage {
    bool hasOffer = false;
    SignalOffer offer;
    bool hasAnswer = false;
    SignalAnswer answer;
    std::vector<SignalCandidate> candidates;
};

class VdoSignaling {
  public:
    using ConnectedCallback = std::function<void()>;
    using DisconnectedCallback = std::function<void()>;
    using ErrorCallback = std::function<void(const std::string &)>;
    using AlertCallback = std::function<void(const std::string &)>;
    using OfferCallback = std::function<void(const SignalOffer &)>;
    using AnswerCallback = std::function<void(const SignalAnswer &)>;
    using CandidateCallback = std::function<void(const SignalCandidate &)>;
    using OfferRequestCallback = std::function<void(const std::string &uuid, const std::string &session, const std::string &streamId)>;
    using ListingCallback = std::function<void(const std::vector<PeerInfo> &)>;

    VdoSignaling();
    ~VdoSignaling();

    bool connect(const std::string &server = "wss://wss.vdo.ninja");
    void disconnect();
    bool isConnected() const;

    bool joinRoom(const RoomConfig &config);
    void leaveRoom();

    bool publish(const std::string &streamId, const std::string &label);
    void unpublish();

    bool sendOffer(const SignalOffer &offer);
    bool sendAnswer(const SignalAnswer &answer);
    bool sendCandidate(const SignalCandidate &candidate);
    bool tryParseSignalPayload(const std::string &payload, ParsedSignalMessage &parsed) const;
    void setCandidateType(const std::string &type);

    void setPassword(const std::string &password);
    void disableEncryption();

    std::string getViewUrl() const;
    std::string getStreamId() const;
    std::string getRoomId() const;

    void onConnected(ConnectedCallback cb);
    void onDisconnected(DisconnectedCallback cb);
    void onError(ErrorCallback cb);
    void onAlert(AlertCallback cb);
    void onOffer(OfferCallback cb);
    void onAnswer(AnswerCallback cb);
    void onCandidate(CandidateCallback cb);
    void onOfferRequest(OfferRequestCallback cb);
    void onListing(ListingCallback cb);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace versus::signaling
