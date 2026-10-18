#include "versus/platform/macos_network.h"
#include <QSslCertificate>
#include <QSslConfiguration>
#import <Foundation/Foundation.h>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>

namespace versus::platform {
std::string macSystemCaCertificatesPem() {
    // libdatachannel's Mbed TLS transport requires an explicit CA chain. Qt
    // obtains the Mac system trust roots; no TLS verification bypass is used.
    static const std::string roots = [] {
        QByteArray pem;
        for (const auto &certificate : QSslConfiguration::systemCaCertificates()) pem += certificate.toPem();
        return pem.toStdString();
    }();
    return roots;
}

webrtc::TurnRegistryHttpResponse macFetchTurnRegistry(const webrtc::TurnRegistryRequest &request) {
    struct Result {
        std::mutex mutex;
        std::condition_variable ready;
        bool done = false;
        webrtc::TurnRegistryHttpResponse response;
    };
    const auto result = std::make_shared<Result>();
    @autoreleasepool {
        NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:request.url.c_str()]];
        if (![url.scheme isEqualToString:@"https"] || ![url.host isEqualToString:@"turnservers.vdo.ninja"]) return {};
        const int timeout = std::clamp(request.timeoutMs, 1, 10000);
        auto *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        config.timeoutIntervalForRequest = timeout / 1000.0;
        config.timeoutIntervalForResource = timeout / 1000.0;
        auto *session = [NSURLSession sessionWithConfiguration:config];
        auto *task = [session dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            std::lock_guard lock(result->mutex);
            if (!error && [response isKindOfClass:[NSHTTPURLResponse class]] &&
                [response.URL.scheme isEqualToString:@"https"] &&
                [response.URL.host isEqualToString:@"turnservers.vdo.ninja"] && data.length <= 1024 * 1024) {
                result->response.transportSucceeded = true;
                result->response.httpStatus = static_cast<int>(((NSHTTPURLResponse *)response).statusCode);
                if (data.length) result->response.body.assign(static_cast<const char *>(data.bytes), data.length);
            }
            result->done = true;
            result->ready.notify_all();
        }];
        [task resume];
        std::unique_lock lock(result->mutex);
        const bool completed = result->ready.wait_for(lock, std::chrono::milliseconds(timeout + 100), [&] { return result->done; });
        const auto response = completed ? result->response : webrtc::TurnRegistryHttpResponse{};
        lock.unlock();
        [session invalidateAndCancel];
        return response;
    }
}
} // namespace versus::platform
