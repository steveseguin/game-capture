#include "versus/app/peer_operation_executor.h"
#include "versus/app/video_control_snapshot.h"
#include <algorithm>
#include <future>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace versus::app;
using namespace std::chrono_literals;
static void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
int main() {
    try {
        auto message = nlohmann::json::parse(R"({"action":"requestResolution","remote":"stream","value":{"w":1280,"h":720,"f":60},"targetBitrate":8000})");
        const auto key = videoControlSnapshotKey(message);
        require(!key.empty(), "complete snapshot was not recognized");
        for (const char *field : {"w", "h", "f"}) {
            auto partial = message; partial["value"].erase(field);
            require(videoControlSnapshotKey(partial).empty(), "partial snapshot was replaceable");
        }
        for (const auto &invalid : {nlohmann::json(-1), nlohmann::json(1e20), nlohmann::json("60"), nlohmann::json(true)}) {
            auto bad = message; bad["value"]["f"] = invalid;
            require(videoControlSnapshotKey(bad).empty(), "invalid snapshot was replaceable");
        }
        auto extra = message; extra["request_id"] = 1;
        require(videoControlSnapshotKey(extra).empty(), "identified command was replaceable");
        extra = message; extra["value"]["extra"] = true;
        require(videoControlSnapshotKey(extra).empty(), "mixed command was replaceable");
        extra = message; extra["remote"] = "other";
        require(videoControlSnapshotKey(extra) != key, "remote scopes shared a key");
        extra = message; extra.erase("targetBitrate");
        require(videoControlSnapshotKey(extra).empty(), "missing bitrate was replaceable");

        using E = GenerationTaggedPeerOperationExecutor;
        std::promise<void> entered, release;
        auto released = release.get_future().share();
        auto enteredFuture = entered.get_future();
        std::vector<int> ran;
        int superseded = 0;
        // Captures outlive the executor even when an assertion throws.
        E executor(64); require(executor.start(), "executor start failed");
        executor.enqueue(1,"block",E::Priority::Ordinary,{},[](uint64_t){return true;},
            [&](uint64_t){entered.set_value();released.wait_for(5s);});
        require(enteredFuture.wait_for(2s)==std::future_status::ready,"worker did not enter");
        auto enqueue = [&](int id, std::string peer, uint64_t generation, std::string snapshot) {
            return executor.enqueue(generation,peer,E::Priority::Ordinary,snapshot,
                [](uint64_t){return true;},[&,id](uint64_t){ran.push_back(id);},E::Criticality::State,
                [&](uint64_t,E::CompletionDisposition disposition){if(disposition==E::CompletionDisposition::Superseded)++superseded;});
        };
        require(enqueue(1,"a",1,key)==E::EnqueueResult::Queued,"first queue failed");
        require(enqueue(2,"a",1,key)==E::EnqueueResult::CoalescedOrdinary,"snapshot did not supersede");
        require(enqueue(3,"a",1,{})==E::EnqueueResult::Queued,"partial queue failed");
        require(enqueue(4,"a",1,key)==E::EnqueueResult::Queued,"crossed a partial control");
        require(enqueue(5,"a",2,key)==E::EnqueueResult::Queued,"crossed a generation");
        require(enqueue(6,"b",2,key)==E::EnqueueResult::Queued,"crossed a peer");
        require(enqueue(7,"a",2,key)==E::EnqueueResult::Queued,"crossed intervening work");
        release.set_value(); require(executor.waitUntilIdle(3s),"executor did not drain");
        require(std::count(ran.begin(),ran.end(),6)==1,"other peer did not run");
        ran.erase(std::remove(ran.begin(),ran.end(),6),ran.end());
        require(ran==std::vector<int>({2,3,4,5,7}),"ordinary ordering changed");
        require(superseded==1&&executor.stats().coalescedOrdinary==1,"coalescing accounting failed");
        executor.stop(); std::cout << "Video snapshot gates passed\n";
    } catch(const std::exception &e) {std::cerr << e.what() << '\n';return 1;}
}
