// Include GLib before Qt's signals macro.
#include <libsecret/secret.h>
#include "versus/platform/output_profiles.h"
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUuid>
#include <spdlog/spdlog.h>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace versus::platform {
namespace {
// Autosave must never open an unlock/create-collection dialog. Reject prompts
// too, covering a collection which locks between inspection and mutation.
struct ProfileSecretService { SecretService parent; };
struct ProfileSecretServiceClass { SecretServiceClass parent; };
G_DEFINE_TYPE(ProfileSecretService, profile_secret_service, SECRET_TYPE_SERVICE)
void profile_secret_service_init(ProfileSecretService *) {}
void profile_secret_service_class_init(ProfileSecretServiceClass *type) {
    auto *service = SECRET_SERVICE_CLASS(type);
    service->prompt_sync = [](SecretService *, SecretPrompt *, GCancellable *, const GVariantType *, GError **error) -> GVariant * {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "Interactive secret-store access is disabled");
        return nullptr;
    };
    service->prompt_async = [](SecretService *self, SecretPrompt *, const GVariantType *, GCancellable *cancel, GAsyncReadyCallback callback, gpointer data) {
        auto *task = g_task_new(self, cancel, callback, data);
        g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "Interactive secret-store access is disabled");
        g_object_unref(task);
    };
    service->prompt_finish = [](SecretService *, GAsyncResult *result, GError **error) -> GVariant * {
        return static_cast<GVariant *>(g_task_propagate_pointer(G_TASK(result), error));
    };
}

constexpr auto prefix = "linux-secret-service-v1:";
const SecretSchema schema = [] {
    SecretSchema value{};
    value.name = "ninja.vdo.game-capture.output-profiles";
    value.flags = SECRET_SCHEMA_NONE;
    value.attributes[0] = {"reference", SECRET_SCHEMA_ATTRIBUTE_STRING};
    return value;
}();
bool validReference(const QByteArray &reference) {
    static const QRegularExpression pattern(QStringLiteral("^linux-secret-service-v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"));
    return pattern.match(QString::fromLatin1(reference)).hasMatch();
}
bool validData(const QByteArray &data) {
    return !data.isEmpty() && data.size() <= 1024 * 1024 && QJsonDocument::fromJson(data).isObject();
}
OutputProfileResult failure() {
    // Never include server-provided messages, item attributes or profile data.
    return {{}, QStringLiteral("Output destinations could not be saved or restored. Unlock your desktop password store and restart Game Capture. If the store or saved entry is missing, restore it first. Existing saved settings have not been cleared.")};
}
OutputProfileResult invalidReference() {
    return {{}, QStringLiteral("Saved output settings have an unsupported secret-store reference. Existing settings were preserved.")};
}
struct Request {
    GCancellable *cancel = g_cancellable_new();
    GError *error = nullptr;
    std::mutex mutex;
    std::condition_variable wake;
    bool done = false;
    // A stalled D-Bus peer cannot hold the GUI indefinitely. This timer does
    // not depend on the blocked Qt/GLib event loop and is always joined.
    std::thread timer{[this] {
        std::unique_lock lock(mutex);
        if (!wake.wait_for(lock, std::chrono::seconds(3), [this] { return done; }))
            g_cancellable_cancel(cancel);
    }};
    ~Request() {
        { std::lock_guard lock(mutex); done = true; wake.notify_all(); }
        timer.join();
        g_clear_error(&error);
        g_object_unref(cancel);
    }
};
enum class Operation { Load, Save, Delete };
OutputProfileResult access(Operation operation, const QByteArray &existing, const QByteArray &data = {}) {
    if (!existing.isEmpty() && !validReference(existing)) return invalidReference();
    if (operation != Operation::Save && existing.isEmpty()) return {};
    if (operation == Operation::Save && !validData(data)) return failure();
    const QByteArray reference = existing.isEmpty()
        ? QByteArray(prefix) + QUuid::createUuid().toString(QUuid::WithoutBraces).toLatin1() : existing;
    Request request;
    auto fail = [&](const char *stage, const char *reason = nullptr) {
        // Log only our own fixed categories: server messages and attributes
        // may include credentials, item identifiers or destination URLs.
        if (!reason) {
            if (g_cancellable_is_cancelled(request.cancel) ||
                g_error_matches(request.error, G_IO_ERROR, G_IO_ERROR_TIMED_OUT) ||
                g_error_matches(request.error, G_DBUS_ERROR, G_DBUS_ERROR_NO_REPLY))
                reason = "timeout";
            else if (g_error_matches(request.error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED) ||
                     g_error_matches(request.error, G_DBUS_ERROR, G_DBUS_ERROR_ACCESS_DENIED))
                reason = "access-denied";
            else reason = "request-failed";
        }
        const char *name = operation == Operation::Load ? "load" : operation == Operation::Save ? "save" : "delete";
        spdlog::warn("[OutputProfiles] {} failed (stage={}, reason={})", name, stage, reason);
        return failure();
    };
    g_autoptr(SecretService) service = secret_service_open_sync(profile_secret_service_get_type(), nullptr,
        SECRET_SERVICE_OPEN_SESSION, request.cancel, &request.error);
    if (!service || request.error) return fail("open-session");
    g_autoptr(GHashTable) attributes = secret_attributes_build(&schema, "reference", reference.constData(), nullptr);
    if (existing.isEmpty()) {
        g_autoptr(SecretCollection) collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT,
            SECRET_COLLECTION_NONE, request.cancel, &request.error);
        if (request.error) return fail("default-collection");
        if (!collection) return fail("default-collection", "missing");
        if (secret_collection_get_locked(collection)) return fail("default-collection", "locked");
        g_autoptr(SecretValue) value = secret_value_new(data.constData(), data.size(), "application/json");
        g_autoptr(SecretItem) item = secret_item_create_sync(collection, &schema, attributes,
            "Game Capture output destinations", value, SECRET_ITEM_CREATE_NONE, request.cancel, &request.error);
        return item && !request.error ? OutputProfileResult{reference, {}} : fail("create-item");
    }
    // Search without SECRET_SEARCH_UNLOCK or automatic secret loading. A
    // missing or ambiguous existing entry is never silently recreated.
    GList *items = secret_service_search_sync(service, &schema, attributes, SECRET_SEARCH_ALL, request.cancel, &request.error);
    const unsigned count = g_list_length(items);
    g_autoptr(SecretItem) item = count == 1 ? SECRET_ITEM(g_object_ref(items->data)) : nullptr;
    g_list_free_full(items, g_object_unref);
    if (request.error) return fail("search-item");
    if (!count && operation == Operation::Delete) return {};
    if (!item) return fail("search-item", count ? "ambiguous" : "missing");
    if (secret_item_get_locked(item)) return fail("access-item", "locked");
    if (operation == Operation::Delete) {
        return secret_item_delete_sync(item, request.cancel, &request.error) && !request.error
            ? OutputProfileResult{} : fail("delete-item");
    }
    if (operation == Operation::Save) {
        g_autoptr(SecretValue) value = secret_value_new(data.constData(), data.size(), "application/json");
        return secret_item_set_secret_sync(item, value, request.cancel, &request.error) && !request.error
            ? OutputProfileResult{reference, {}} : fail("update-item");
    }
    if (!secret_item_load_secret_sync(item, request.cancel, &request.error) || request.error) return fail("load-item");
    g_autoptr(SecretValue) value = secret_item_get_secret(item);
    if (!value) return fail("read-item", "missing-value");
    gsize size = 0;
    const char *bytes = secret_value_get(value, &size);
    if (!bytes || size > 1024 * 1024) return fail("read-item", "invalid-data");
    QByteArray result(bytes, qsizetype(size));
    return validData(result) ? OutputProfileResult{result, {}} : fail("read-item", "invalid-data");
}
}
OutputProfileResult loadOutputProfiles(const QByteArray &reference) { return access(Operation::Load, reference); }
OutputProfileResult saveOutputProfiles(const QByteArray &data, const QByteArray &reference) { return access(Operation::Save, reference, data); }
OutputProfileResult deleteOutputProfiles(const QByteArray &reference) { return access(Operation::Delete, reference); }
}
