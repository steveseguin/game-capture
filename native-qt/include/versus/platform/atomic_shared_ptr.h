#pragma once

#include <atomic>
#include <memory>
#include <utility>

namespace versus::platform {

#if defined(__cpp_lib_atomic_shared_ptr) && __cpp_lib_atomic_shared_ptr >= 201711L
template <class T>
using AtomicSharedPtr = std::atomic<std::shared_ptr<T>>;
#else
// Apple's libc++ does not yet provide atomic<shared_ptr<T>>. Its standard
// shared_ptr atomic operations provide the same sequentially consistent
// load/store/exchange and retain a reader's ownership through concurrent stop.
template <class T>
class AtomicSharedPtr {
  public:
    AtomicSharedPtr() = default;
    AtomicSharedPtr(const AtomicSharedPtr &) = delete;
    AtomicSharedPtr &operator=(const AtomicSharedPtr &) = delete;

    std::shared_ptr<T> load() const { return std::atomic_load(&value_); }
    void store(std::shared_ptr<T> value) { std::atomic_store(&value_, std::move(value)); }
    std::shared_ptr<T> exchange(std::shared_ptr<T> value) {
        return std::atomic_exchange(&value_, std::move(value));
    }

  private:
    std::shared_ptr<T> value_;
};
#endif

} // namespace versus::platform
