#include "versus/platform/macos_output_profiles.h"
#include <QRegularExpression>
#include <QUuid>
#include <QJsonDocument>
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

namespace versus::platform {
namespace {
constexpr auto prefix = "mac-keychain-v1:";
bool validReference(const QByteArray &reference) {
    static const QRegularExpression pattern(QStringLiteral("^mac-keychain-v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"));
    return pattern.match(QString::fromLatin1(reference)).hasMatch();
}
NSMutableDictionary *query(const QByteArray &reference) {
    // Use the login/file Keychain: this desktop application is not provisioned
    // with a shared access group. Keep the item local, with the app's default
    // access policy; never grant access to all applications or enable sync.
    LAContext *context = [LAContext new];
    context.interactionNotAllowed = YES;
    return [@{(id)kSecClass:(id)kSecClassGenericPassword,
        (id)kSecAttrService:@"ninja.vdo.game-capture.output-profiles",
        (id)kSecAttrAccount:[[NSString alloc] initWithBytes:reference.constData() length:reference.size() encoding:NSUTF8StringEncoding],
        (id)kSecUseAuthenticationContext:context} mutableCopy];
}
OutputProfileResult failure(OSStatus status) {
    // Do not expose item attributes or profile data in errors/logs.
    return {{}, QStringLiteral("macOS Keychain could not access output settings (error %1). Unlock the login Keychain and restart Game Capture; existing saved profiles are preserved.").arg(status)};
}
OutputProfileResult invalidReference() {
    return {{}, QStringLiteral("Saved output settings have an unsupported Keychain reference. Existing settings were preserved.")};
}
}
OutputProfileResult loadOutputProfiles(const QByteArray &reference) { @autoreleasepool {
    if (reference.isEmpty()) return {};
    if (!validReference(reference)) return invalidReference();
    auto attributes = query(reference);
    attributes[(id)kSecReturnData] = @YES;
    attributes[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
    CFTypeRef value = nullptr;
    const OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)attributes, &value);
    if (status != errSecSuccess) { if (value) CFRelease(value); return failure(status); }
    if (!value || CFGetTypeID(value) != CFDataGetTypeID()) { if (value) CFRelease(value); return failure(errSecDecode); }
    auto data = static_cast<CFDataRef>(value);
    if (CFDataGetLength(data) > 1024 * 1024) { CFRelease(value); return failure(errSecDecode); }
    QByteArray result(reinterpret_cast<const char *>(CFDataGetBytePtr(data)), CFDataGetLength(data));
    CFRelease(value);
    if (!QJsonDocument::fromJson(result).isObject()) return failure(errSecDecode);
    return {result, {}};
} }
OutputProfileResult saveOutputProfiles(const QByteArray &data, const QByteArray &existing) { @autoreleasepool {
    if (!existing.isEmpty() && !validReference(existing)) return invalidReference();
    if (data.isEmpty() || data.size() > 1024 * 1024 || !QJsonDocument::fromJson(data).isObject()) return failure(errSecParam);
    const QByteArray reference = existing.isEmpty() ? QByteArray(prefix) + QUuid::createUuid().toString(QUuid::WithoutBraces).toLatin1() : existing;
    auto attributes = query(reference);
    NSData *value = [NSData dataWithBytes:data.constData() length:data.size()];
    OSStatus status;
    if (existing.isEmpty()) {
        attributes[(id)kSecValueData] = value;
        attributes[(id)kSecAttrLabel] = @"Game Capture output destinations";
        status = SecItemAdd((__bridge CFDictionaryRef)attributes, nullptr);
    } else {
        // An unreadable/missing existing entry is never replaced implicitly.
        status = SecItemUpdate((__bridge CFDictionaryRef)attributes,
            (__bridge CFDictionaryRef)@{(id)kSecValueData:value});
    }
    return status == errSecSuccess ? OutputProfileResult{reference, {}} : failure(status);
} }
OutputProfileResult deleteOutputProfiles(const QByteArray &reference) { @autoreleasepool {
    if (reference.isEmpty()) return {};
    if (!validReference(reference)) return invalidReference();
    const OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query(reference));
    return status == errSecSuccess || status == errSecItemNotFound ? OutputProfileResult{} : failure(status);
} }
}
