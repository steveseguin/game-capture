#include "versus/app/peer_operation_executor.h"

#include <algorithm>
#include <exception>
#include <optional>
#include <utility>

#include <spdlog/spdlog.h>

namespace versus::app {
namespace {

constexpr std::size_t kMaxConsecutiveCritical = 8;

}  // namespace

GenerationTaggedPeerOperationExecutor::GenerationTaggedPeerOperationExecutor(
    std::size_t maxQueued)
    : maxQueued_(std::max<std::size_t>(1, maxQueued)),
      criticalReserve_(maxQueued_ > 1
                           ? std::min(maxQueued_ - 1,
                                      std::max<std::size_t>(1, maxQueued_ / 8))
                           : 0),
      ordinaryCapacity_(maxQueued_ - criticalReserve_),
      perPeerOrdinaryLimit_(std::min<std::size_t>(
          64,
          std::max<std::size_t>(
              1,
              std::min<std::size_t>(
                  ordinaryCapacity_,
                  std::max<std::size_t>(4, ordinaryCapacity_ / 4))))) {}

GenerationTaggedPeerOperationExecutor::~GenerationTaggedPeerOperationExecutor() {
    stop();
    uint64_t stoppedWorkerEpoch = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopRequested_) {
            stoppedWorkerEpoch = workerEpoch_;
        }
    }
    finalizeStoppedWorker(true, stoppedWorkerEpoch);
}

bool GenerationTaggedPeerOperationExecutor::start() {
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
    std::lock_guard<std::mutex> lock(mutex_);
    if (running_) {
        if (!stopRequested_) {
            return true;
        }
        // A stopped worker can be joined without waiting on any operation,
        // predicate, or completion. Until it reports that quiescent point,
        // start must fail closed instead of reviving a partial lifecycle.
        if (!workerExited_) {
            return false;
        }
        if (worker_.joinable()) {
            worker_.join();
        }
        running_ = false;
        stopRequested_ = false;
        workerExited_ = false;
        inFlight_ = 0;
        consecutiveCritical_ = 0;
        lastServedPeerKey_.clear();
    } else if (worker_.joinable()) {
        if (!workerExited_) {
            return false;
        }
        worker_.join();
        stopRequested_ = false;
        workerExited_ = false;
    }
    stopRequested_ = false;
    workerExited_ = false;
    uint64_t nextWorkerEpoch = workerEpoch_ + 1;
    if (nextWorkerEpoch == 0) {
        nextWorkerEpoch = 1;
    }
    try {
        worker_ = std::thread([this]() { workerLoop(); });
        workerEpoch_ = nextWorkerEpoch;
        running_ = true;
        return true;
    } catch (const std::exception &e) {
        spdlog::error("[PeerOperations] Failed to start serialized executor: {}", e.what());
    } catch (...) {
        spdlog::error("[PeerOperations] Failed to start serialized executor");
    }
    return false;
}

void GenerationTaggedPeerOperationExecutor::stop() {
    uint64_t stoppedWorkerEpoch = 0;
    std::function<void(uint64_t)> beforeFinalize;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (running_ || worker_.joinable()) {
            stopRequested_ = true;
            stoppedWorkerEpoch = workerEpoch_;
        }

        const std::size_t queued = criticalQueue_.size() + ordinaryQueue_.size();
        stats_.droppedOnStop += queued;
        while (!criticalQueue_.empty()) {
            droppedCompletionQueue_.push_back(
                std::move(criticalQueue_.front()));
            criticalQueue_.pop_front();
        }
        while (!ordinaryQueue_.empty()) {
            droppedCompletionQueue_.push_back(
                std::move(ordinaryQueue_.front()));
            ordinaryQueue_.pop_front();
        }
        ordinaryQueuedByPeer_.clear();
        beforeFinalize = beforeStopFinalizeForTesting_;
    }
    workCv_.notify_all();
    if (beforeFinalize) {
        beforeFinalize(stoppedWorkerEpoch);
    }
    finalizeStoppedWorker(false, stoppedWorkerEpoch);
}

void GenerationTaggedPeerOperationExecutor::finalizeStoppedWorker(
    bool waitForExit,
    uint64_t stoppedWorkerEpoch) {
    if (stoppedWorkerEpoch == 0) {
        return;
    }
    if (waitForExit) {
        // Do not own the lifecycle lock while waiting for callbacks. A worker
        // callback is allowed to call start(), which must observe the pending
        // stop and fail closed rather than deadlock behind a destructor join.
        std::unique_lock<std::mutex> lock(mutex_);
        if (worker_.joinable() &&
            worker_.get_id() == std::this_thread::get_id()) {
            return;
        }
        idleCv_.wait(lock, [this, stoppedWorkerEpoch]() {
            return !worker_.joinable() ||
                workerEpoch_ != stoppedWorkerEpoch ||
                ((workerExited_ || inFlight_ == 0) &&
                 droppedCompletionQueue_.empty());
        });
    }

    std::unique_lock<std::mutex> lifecycleLock(
        lifecycleMutex_,
        std::defer_lock);
    if (waitForExit) {
        lifecycleLock.lock();
    } else if (!lifecycleLock.try_lock()) {
        return;
    }
    std::thread worker;
    {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!worker_.joinable() ||
            workerEpoch_ != stoppedWorkerEpoch) {
            return;
        }
        if (worker_.get_id() == std::this_thread::get_id()) {
            return;
        }
        if ((!workerExited_ && inFlight_ != 0) ||
            !droppedCompletionQueue_.empty()) {
            return;
        }
        worker.swap(worker_);
    }
    worker.join();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        running_ = false;
        stopRequested_ = false;
        workerExited_ = false;
        inFlight_ = 0;
        consecutiveCritical_ = 0;
        lastServedPeerKey_.clear();
    }
    idleCv_.notify_all();
}

GenerationTaggedPeerOperationExecutor::EnqueueResult
GenerationTaggedPeerOperationExecutor::enqueue(
    uint64_t generation,
    std::string peerKey,
    Priority priority,
    std::string coalesceKey,
    GenerationPredicate generationIsCurrent,
    Operation operation,
    Criticality criticality,
    Completion completion) {
    if (generation == 0 || peerKey.empty() || !generationIsCurrent || !operation) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            ++stats_.rejectedInvalid;
        }
        invokeCompletion(
            completion,
            generation,
            CompletionDisposition::RejectedInvalid);
        return EnqueueResult::RejectedInvalid;
    }

    EnqueueResult result = EnqueueResult::Queued;
    std::optional<Item> displaced;
    {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!running_ || stopRequested_) {
            ++stats_.rejectedStopped;
            lock.unlock();
            invokeCompletion(
                completion,
                generation,
                CompletionDisposition::RejectedStopped);
            return EnqueueResult::RejectedStopped;
        }

        if (priority == Priority::Critical && !coalesceKey.empty()) {
            const auto existing = std::find_if(
                criticalQueue_.begin(),
                criticalQueue_.end(),
                [&](const Item &item) {
                    return item.peerKey == peerKey &&
                        item.coalesceKey == coalesceKey;
                });
            if (existing != criticalQueue_.end()) {
                Completion supersededCompletion =
                    std::move(existing->completion);
                const uint64_t supersededGeneration = existing->generation;
                existing->generation = generation;
                existing->criticality = criticality;
                existing->generationIsCurrent = std::move(generationIsCurrent);
                existing->operation = std::move(operation);
                existing->completion = std::move(completion);
                ++stats_.coalescedCritical;
                lock.unlock();
                invokeCompletion(
                    supersededCompletion,
                    supersededGeneration,
                    CompletionDisposition::Superseded);
                return EnqueueResult::CoalescedCritical;
            }
        }

        const std::size_t queued = criticalQueue_.size() + ordinaryQueue_.size();
        if (priority == Priority::Ordinary) {
            const auto peerCount = ordinaryQueuedByPeer_.find(peerKey);
            const std::size_t peerQueued =
                peerCount == ordinaryQueuedByPeer_.end() ? 0 : peerCount->second;
            if (ordinaryQueue_.size() >= ordinaryCapacity_ ||
                queued >= maxQueued_ ||
                peerQueued >= perPeerOrdinaryLimit_) {
                ++stats_.droppedOrdinaryCapacity;
                lock.unlock();
                invokeCompletion(
                    completion,
                    generation,
                    CompletionDisposition::RejectedOrdinaryCapacity);
                return EnqueueResult::RejectedOrdinaryCapacity;
            }
        } else if (queued >= maxQueued_) {
            if (!ordinaryQueue_.empty()) {
                const std::string evictedPeer = ordinaryQueue_.front().peerKey;
                displaced.emplace(std::move(ordinaryQueue_.front()));
                ordinaryQueue_.pop_front();
                const auto peerCount = ordinaryQueuedByPeer_.find(evictedPeer);
                if (peerCount != ordinaryQueuedByPeer_.end()) {
                    if (peerCount->second > 1) {
                        --peerCount->second;
                    } else {
                        ordinaryQueuedByPeer_.erase(peerCount);
                    }
                }
                ++stats_.evictedOrdinaryForCritical;
                result = EnqueueResult::QueuedAfterEvictingOrdinary;
            } else {
                auto victim = criticalQueue_.end();
                for (auto it = criticalQueue_.begin();
                     it != criticalQueue_.end();
                     ++it) {
                    if (static_cast<uint8_t>(it->criticality) >
                        static_cast<uint8_t>(criticality)) {
                        continue;
                    }
                    if (victim == criticalQueue_.end() ||
                        static_cast<uint8_t>(it->criticality) <
                            static_cast<uint8_t>(victim->criticality)) {
                        victim = it;
                    }
                }
                if (victim == criticalQueue_.end()) {
                    ++stats_.rejectedCriticalCapacity;
                    lock.unlock();
                    invokeCompletion(
                        completion,
                        generation,
                        CompletionDisposition::RejectedCriticalCapacity);
                    return EnqueueResult::RejectedCriticalCapacity;
                }
                displaced.emplace(std::move(*victim));
                criticalQueue_.erase(victim);
                ++stats_.evictedCriticalForCritical;
                result = EnqueueResult::QueuedAfterEvictingCritical;
            }
        }

        Item item{
            generation,
            std::move(peerKey),
            std::move(coalesceKey),
            criticality,
            std::move(generationIsCurrent),
            std::move(operation),
            std::move(completion)};
        if (priority == Priority::Critical) {
            criticalQueue_.push_back(std::move(item));
            ++stats_.acceptedCritical;
        } else {
            ++ordinaryQueuedByPeer_[item.peerKey];
            ordinaryQueue_.push_back(std::move(item));
            ++stats_.acceptedOrdinary;
        }
    }
    if (displaced) {
        invokeCompletion(
            displaced->completion,
            displaced->generation,
            CompletionDisposition::Evicted);
    }
    workCv_.notify_one();
    return result;
}

void GenerationTaggedPeerOperationExecutor::invokeCompletion(
    Completion &completion,
    uint64_t generation,
    CompletionDisposition disposition) noexcept {
    if (!completion) {
        return;
    }
    try {
        completion(generation, disposition);
    } catch (const std::exception &e) {
        spdlog::warn(
            "[PeerOperations] Completion callback threw: {}",
            e.what());
    } catch (...) {
        spdlog::warn("[PeerOperations] Completion callback threw");
    }
}

bool GenerationTaggedPeerOperationExecutor::accepted(EnqueueResult result) {
    return result == EnqueueResult::Queued ||
        result == EnqueueResult::CoalescedCritical ||
        result == EnqueueResult::QueuedAfterEvictingOrdinary ||
        result == EnqueueResult::QueuedAfterEvictingCritical;
}

bool GenerationTaggedPeerOperationExecutor::waitUntilIdle(
    std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex_);
    return idleCv_.wait_for(lock, timeout, [this]() {
        return criticalQueue_.empty() && ordinaryQueue_.empty() &&
            droppedCompletionQueue_.empty() && inFlight_ == 0;
    });
}

std::size_t GenerationTaggedPeerOperationExecutor::pendingCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return criticalQueue_.size() + ordinaryQueue_.size() +
        droppedCompletionQueue_.size() + inFlight_;
}

uint64_t GenerationTaggedPeerOperationExecutor::droppedCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return stats_.droppedOrdinaryCapacity +
        stats_.evictedOrdinaryForCritical +
        stats_.evictedCriticalForCritical +
        stats_.rejectedCriticalCapacity +
        stats_.rejectedInvalid +
        stats_.rejectedStopped +
        stats_.staleGeneration +
        stats_.droppedOnStop;
}

GenerationTaggedPeerOperationExecutor::Stats
GenerationTaggedPeerOperationExecutor::stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    Stats result = stats_;
    result.queuedCritical = criticalQueue_.size();
    result.queuedOrdinary = ordinaryQueue_.size();
    result.inFlight = inFlight_;
    return result;
}

GenerationTaggedPeerOperationExecutor::Item
GenerationTaggedPeerOperationExecutor::popFairLocked(
    std::deque<Item> &queue,
    bool ordinary) {
    auto selected = queue.begin();
    if (!lastServedPeerKey_.empty() && queue.size() > 1) {
        const auto differentPeer = std::find_if(
            queue.begin(),
            queue.end(),
            [this](const Item &item) {
                return item.peerKey != lastServedPeerKey_;
            });
        if (differentPeer != queue.end()) {
            selected = differentPeer;
        }
    }

    Item item = std::move(*selected);
    queue.erase(selected);
    if (ordinary) {
        const auto peerCount = ordinaryQueuedByPeer_.find(item.peerKey);
        if (peerCount != ordinaryQueuedByPeer_.end()) {
            if (peerCount->second > 1) {
                --peerCount->second;
            } else {
                ordinaryQueuedByPeer_.erase(peerCount);
            }
        }
    }
    lastServedPeerKey_ = item.peerKey;
    return item;
}

void GenerationTaggedPeerOperationExecutor::workerLoop() {
    for (;;) {
        Item item;
        bool droppedOnStop = false;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            workCv_.wait(lock, [this]() {
                return stopRequested_ ||
                    !criticalQueue_.empty() ||
                    !ordinaryQueue_.empty();
            });
            if (stopRequested_) {
                if (droppedCompletionQueue_.empty()) {
                    workerExited_ = true;
                    idleCv_.notify_all();
                    return;
                }
                item = std::move(droppedCompletionQueue_.front());
                droppedCompletionQueue_.pop_front();
                droppedOnStop = true;
            } else {
                const bool takeCritical = !criticalQueue_.empty() &&
                    (ordinaryQueue_.empty() ||
                     consecutiveCritical_ < kMaxConsecutiveCritical);
                if (takeCritical) {
                    item = popFairLocked(criticalQueue_, false);
                    ++consecutiveCritical_;
                } else {
                    item = popFairLocked(ordinaryQueue_, true);
                    consecutiveCritical_ = 0;
                }
            }
            ++inFlight_;
        }

        CompletionDisposition disposition = droppedOnStop
            ? CompletionDisposition::DroppedOnStop
            : CompletionDisposition::Executed;
        if (!droppedOnStop) {
            try {
                if (item.generationIsCurrent(item.generation)) {
                    item.operation(item.generation);
                } else {
                    {
                        std::lock_guard<std::mutex> lock(mutex_);
                        ++stats_.staleGeneration;
                    }
                    disposition = CompletionDisposition::StaleGeneration;
                }
            } catch (const std::exception &e) {
                spdlog::warn("[PeerOperations] Serialized peer operation threw: {}", e.what());
                disposition = CompletionDisposition::OperationThrew;
            } catch (...) {
                spdlog::warn("[PeerOperations] Serialized peer operation threw");
                disposition = CompletionDisposition::OperationThrew;
            }
        }

        invokeCompletion(item.completion, item.generation, disposition);

        {
            std::lock_guard<std::mutex> lock(mutex_);
            --inFlight_;
            if (criticalQueue_.empty() && ordinaryQueue_.empty() && inFlight_ == 0) {
                idleCv_.notify_all();
            }
        }
    }
}

}  // namespace versus::app
