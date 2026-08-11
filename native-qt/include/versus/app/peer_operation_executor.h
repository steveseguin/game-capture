#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

namespace versus::app {

// WebRtcClient deliberately holds its callback-dispatch lease while invoking
// user callbacks. App operations which can enter the peer client-operation
// mutex must therefore be handed off before that callback returns. This
// executor supplies one serialized app-owned boundary and drops work after its
// transport generation is no longer current. Capacity does not imply
// losslessness: ordinary work is bounded per peer, and lower-value critical
// work can be rejected behind a queue containing only more valuable work.
// Convergent recovery/terminal work is never rejected merely because the
// critical queue is full; it displaces the oldest equal/lower-value item, and
// every displacement/rejection is counted for diagnostics.
class GenerationTaggedPeerOperationExecutor {
  public:
    using GenerationPredicate = std::function<bool(uint64_t)>;
    using Operation = std::function<void(uint64_t)>;

    enum class CompletionDisposition {
        Executed,
        OperationThrew,
        StaleGeneration,
        Superseded,
        Evicted,
        RejectedInvalid,
        RejectedStopped,
        RejectedOrdinaryCapacity,
        RejectedCriticalCapacity,
        DroppedOnStop,
    };
    using Completion =
        std::function<void(uint64_t, CompletionDisposition)>;

    enum class Priority {
        Ordinary,
        Critical,
    };

    // At critical-only capacity, newer work may displace an older item of
    // equal or lower value, but never a more valuable one.
    enum class Criticality : uint8_t {
        Replaceable,
        State,
        Convergent,
    };

    enum class EnqueueResult {
        Queued,
        CoalescedCritical,
        QueuedAfterEvictingOrdinary,
        QueuedAfterEvictingCritical,
        RejectedInvalid,
        RejectedStopped,
        RejectedOrdinaryCapacity,
        RejectedCriticalCapacity,
    };

    struct Stats {
        std::size_t queuedCritical = 0;
        std::size_t queuedOrdinary = 0;
        std::size_t inFlight = 0;
        uint64_t acceptedCritical = 0;
        uint64_t acceptedOrdinary = 0;
        uint64_t coalescedCritical = 0;
        uint64_t droppedOrdinaryCapacity = 0;
        uint64_t evictedOrdinaryForCritical = 0;
        uint64_t evictedCriticalForCritical = 0;
        uint64_t rejectedCriticalCapacity = 0;
        uint64_t rejectedInvalid = 0;
        uint64_t rejectedStopped = 0;
        uint64_t staleGeneration = 0;
        uint64_t droppedOnStop = 0;
    };

    explicit GenerationTaggedPeerOperationExecutor(std::size_t maxQueued = 1024);
    ~GenerationTaggedPeerOperationExecutor();

    GenerationTaggedPeerOperationExecutor(const GenerationTaggedPeerOperationExecutor &) = delete;
    GenerationTaggedPeerOperationExecutor &operator=(const GenerationTaggedPeerOperationExecutor &) = delete;

    bool start();
    void stop();
    EnqueueResult enqueue(uint64_t generation,
                          std::string peerKey,
                          Priority priority,
                          std::string coalesceKey,
                          GenerationPredicate generationIsCurrent,
                          Operation operation,
                          Criticality criticality = Criticality::State,
                          Completion completion = {});

    static bool accepted(EnqueueResult result);

    bool waitUntilIdle(std::chrono::milliseconds timeout);
    std::size_t pendingCount() const;
    uint64_t droppedCount() const;
    Stats stats() const;

  private:
    friend class VersusAppTestAccess;

    struct Item {
        uint64_t generation = 0;
        std::string peerKey;
        std::string coalesceKey;
        Criticality criticality = Criticality::State;
        GenerationPredicate generationIsCurrent;
        Operation operation;
        Completion completion;
    };

    static void invokeCompletion(
        Completion &completion,
        uint64_t generation,
        CompletionDisposition disposition) noexcept;
    void finalizeStoppedWorker(bool waitForExit, uint64_t stoppedWorkerEpoch);
    Item popFairLocked(std::deque<Item> &queue, bool ordinary);
    void workerLoop();

    const std::size_t maxQueued_;
    const std::size_t criticalReserve_;
    const std::size_t ordinaryCapacity_;
    const std::size_t perPeerOrdinaryLimit_;
    // Only start and quiescent-worker finalization own this lock. stop() never
    // holds it while invoking a completion and never joins while a worker
    // callback is active: that callback may be waiting for the thread which
    // requested stop. Every finalizer also carries the epoch it stopped, so a
    // delayed caller cannot join a later worker installed by start().
    std::mutex lifecycleMutex_;
    mutable std::mutex mutex_;
    std::condition_variable workCv_;
    std::condition_variable idleCv_;
    std::deque<Item> criticalQueue_;
    std::deque<Item> ordinaryQueue_;
    std::deque<Item> droppedCompletionQueue_;
    std::unordered_map<std::string, std::size_t> ordinaryQueuedByPeer_;
    std::thread worker_;
    uint64_t workerEpoch_ = 0;
    std::string lastServedPeerKey_;
    bool running_ = false;
    bool stopRequested_ = false;
    bool workerExited_ = false;
    std::size_t inFlight_ = 0;
    std::size_t consecutiveCritical_ = 0;
    std::function<void(uint64_t)> beforeStopFinalizeForTesting_;
    Stats stats_;
};

}  // namespace versus::app
