#include "versus/video/window_capture.h"
#include "versus/app/frame_trace.h"
#include "versus/webrtc/media_clock.h"
#include <QCoreApplication>
#include <QDBusArgument>
#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusMessage>
#include <QDBusObjectPath>
#include <QDBusReply>
#include <QDBusUnixFileDescriptor>
#include <QEventLoop>
#include <QFile>
#include <QImage>
#include <QPointer>
#include <QTimer>
#include <QUuid>
#include <algorithm>
#include <charconv>
#include <cerrno>
#include <condition_variable>
#include <chrono>
#include <map>
#include <cstring>
#include <mutex>
#include <thread>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#if __has_include(<spa/param/buffers.h>)
#include <spa/param/buffers.h>
#else
// PipeWire 0.3.48 keeps buffer/metadata parameter IDs in the common header.
#include <spa/param/param.h>
#endif
#include <spa/buffer/meta.h>
#include <xcb/xcb.h>
#include <xcb/composite.h>
#include <xcb/damage.h>
#include <spdlog/spdlog.h>

namespace {
using namespace versus;
constexpr auto portalService = "org.freedesktop.portal.Desktop";
constexpr auto portalPath = "/org/freedesktop/portal/desktop";
constexpr auto portalInterface = "org.freedesktop.portal.ScreenCast";

// Each request has its own connection to the predicted response path, installed
// before the method call so even an immediate denial cannot race subscription.
class PortalRequest : public QObject {
    Q_OBJECT
public:
    uint code = 2;
    QVariantMap results;
    QEventLoop loop;
    bool complete = false;
public slots:
    void response(uint status, const QVariantMap &values) {
        code = status; results = values; complete = true; loop.quit();
    }
};

bool portalRequest(const QString &method, QVariantList arguments, QVariantMap options,
                   QVariantMap &results, const std::atomic<bool> &running, const std::atomic<bool> &cancelled) {
    if (cancelled.load()) return false;
    auto bus = QDBusConnection::sessionBus();
    const auto token = "gc_" + QUuid::createUuid().toString(QUuid::Id128);
    auto sender = bus.baseService().mid(1); sender.replace('.', '_');
    const auto path = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token;
    PortalRequest request;
    if (!bus.connect(portalService, path, "org.freedesktop.portal.Request", "Response",
                     &request, SLOT(response(uint,QVariantMap)))) return false;
    options.insert("handle_token", token); arguments.append(options);
    auto call = QDBusMessage::createMethodCall(portalService, portalPath, portalInterface, method);
    call.setArguments(arguments);
    const auto reply = bus.call(call, QDBus::Block, 5000);
    if (reply.type() == QDBusMessage::ErrorMessage) {
        spdlog::warn("[Portal] {}: {}", method.toStdString(), reply.errorMessage().toStdString());
        return false;
    }
    QTimer timeout, cancellation;
    timeout.setSingleShot(true);
    QObject::connect(&timeout, &QTimer::timeout, &request.loop, &QEventLoop::quit);
    QObject::connect(&cancellation, &QTimer::timeout, &request.loop, [&] {
        if (!running.load() || cancelled.load()) request.loop.quit();
    });
    timeout.start(60000); cancellation.start(50);
    if (!request.complete && running.load() && !cancelled.load()) request.loop.exec();
    if (!request.complete || request.code != 0 || !running.load() || cancelled.load()) {
        auto close = QDBusMessage::createMethodCall(portalService, path, "org.freedesktop.portal.Request", "Close");
        bus.asyncCall(close);
        spdlog::info("[Portal] {} cancelled, denied, or timed out (response {})", method.toStdString(), request.code);
        return false;
    }
    results = request.results;
    return true;
}

struct XConnection {
    xcb_connection_t *connection = nullptr;
    xcb_screen_t *screen = nullptr;
    XConnection() {
        int number = 0; connection = xcb_connect(nullptr, &number);
        if (xcb_connection_has_error(connection)) { xcb_disconnect(connection); connection = nullptr; return; }
        auto screens = xcb_setup_roots_iterator(xcb_get_setup(connection));
        while (number-- && screens.rem) xcb_screen_next(&screens);
        screen = screens.data;
    }
    ~XConnection() { if (connection) xcb_disconnect(connection); }
    xcb_atom_t atom(const char *name) {
        auto *reply = xcb_intern_atom_reply(connection, xcb_intern_atom(connection, 0, std::strlen(name), name), nullptr);
        const auto value = reply ? reply->atom : XCB_ATOM_NONE; std::free(reply); return value;
    }
    QByteArray property(xcb_window_t window, const char *name, xcb_atom_t type = XCB_GET_PROPERTY_TYPE_ANY) {
        auto *reply = xcb_get_property_reply(connection, xcb_get_property(connection, 0, window, atom(name), type, 0, 16384), nullptr);
        if (!reply) return {};
        QByteArray value(static_cast<char *>(xcb_get_property_value(reply)), xcb_get_property_value_length(reply));
        std::free(reply); return value;
    }
};
bool xWindowId(const std::string &id, xcb_window_t &window) {
    if (!id.starts_with("x11:")) return false;
    const auto [end, error] = std::from_chars(id.data() + 4, id.data() + id.size(), window);
    return error == std::errc{} && end == id.data() + id.size() && window != 0;
}

std::vector<video::WindowInfo> xWindows() {
    XConnection x;
    std::vector<video::WindowInfo> windows;
    if (!x.connection || !x.screen) return windows;
    auto ids = x.property(x.screen->root, "_NET_CLIENT_LIST", XCB_ATOM_WINDOW);
    // Minimal window managers used by packaged fixtures may not implement EWMH.
    if (ids.isEmpty()) {
        auto *tree = xcb_query_tree_reply(x.connection, xcb_query_tree(x.connection, x.screen->root), nullptr);
        if (tree) {
            ids = QByteArray(reinterpret_cast<const char *>(xcb_query_tree_children(tree)), xcb_query_tree_children_length(tree) * sizeof(xcb_window_t));
            std::free(tree);
        }
    }
    for (qsizetype i = 0; i + qsizetype(sizeof(xcb_window_t)) <= ids.size(); i += sizeof(xcb_window_t)) {
        xcb_window_t id; std::memcpy(&id, ids.constData() + i, sizeof(id));
        auto title = x.property(id, "_NET_WM_NAME");
        if (title.isEmpty()) title = x.property(id, "WM_NAME");
        if (title.isEmpty()) continue;
        auto *geometry = xcb_get_geometry_reply(x.connection, xcb_get_geometry(x.connection, id), nullptr);
        if (!geometry) continue;
        auto *attributes = xcb_get_window_attributes_reply(x.connection, xcb_get_window_attributes(x.connection, id), nullptr);
        const bool visible = attributes && attributes->map_state == XCB_MAP_STATE_VIEWABLE;
        std::free(attributes);
        if (!visible) { std::free(geometry); continue; }
        video::WindowInfo info;
        info.id = "x11:" + std::to_string(id); info.name = title.toStdString();
        info.width = geometry->width; info.height = geometry->height;
        const auto pid = x.property(id, "_NET_WM_PID", XCB_ATOM_CARDINAL);
        if (pid.size() == 4) std::memcpy(&info.processId, pid.constData(), 4);
        QFile executable(QString("/proc/%1/comm").arg(info.processId));
        if (executable.open(QIODevice::ReadOnly)) info.executableName = executable.readAll().trimmed().toStdString();
        windows.push_back(std::move(info)); std::free(geometry);
    }
    return windows;
}

QImage readXImage(XConnection &x, xcb_drawable_t drawable) {
    auto *geometry = xcb_get_geometry_reply(x.connection, xcb_get_geometry(x.connection, drawable), nullptr);
    if (!geometry) return {};
    const int width = geometry->width, height = geometry->height, depth = geometry->depth;
    std::free(geometry);
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || (depth != 24 && depth != 32)) return {};
    auto *reply = xcb_get_image_reply(x.connection, xcb_get_image(x.connection, XCB_IMAGE_FORMAT_Z_PIXMAP,
        drawable, 0, 0, width, height, ~0u), nullptr);
    if (!reply) return {};
    // Ubuntu x86-64 Xorg/XWayland 24/32-bit visuals use little-endian BGRX.
    // Reject other storage rather than reinterpret unqualified pixel layouts.
    QImage image;
    if (xcb_get_setup(x.connection)->image_byte_order == XCB_IMAGE_ORDER_LSB_FIRST &&
        xcb_get_image_data_length(reply) == width * height * 4) {
        image = QImage(xcb_get_image_data(reply), width, height, width * 4, QImage::Format_RGB32).copy();
        for (int y = 0; y < height; ++y)
            for (int x = 0; x < width; ++x) image.scanLine(y)[x * 4 + 3] = 255;
    }
    std::free(reply); return image;
}

// Keep automatic redirection alive between UI thumbnail refreshes. Reading an
// obscured window directly returns undefined/black pixels without a compositor.
// The stream owns its own X connection and redirection independently.
class ThumbnailCapture : public QObject {
    using Clock = std::chrono::steady_clock;
    XConnection x;
    std::map<xcb_window_t, Clock::time_point> windows;
    QTimer expiry;
    void release(xcb_window_t window) {
        auto *error = xcb_request_check(x.connection,
            xcb_composite_unredirect_window_checked(x.connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC));
        std::free(error); // The window may already have been destroyed.
        windows.erase(window);
    }
public:
    explicit ThumbnailCapture(QObject *parent) : QObject(parent) {
        expiry.setInterval(5000);
        QObject::connect(&expiry, &QTimer::timeout, this, [this] {
            const auto now = Clock::now();
            for (auto it = windows.begin(); it != windows.end();) {
                const auto entry = it++;
                if (now - entry->second > std::chrono::seconds(10)) release(entry->first);
            }
            if (x.connection) xcb_flush(x.connection);
        });
        expiry.start();
    }
    QImage read(xcb_window_t window) {
        if (!x.connection) return {};
        const auto *extension = xcb_get_extension_data(x.connection, &xcb_composite_id);
        if (!extension || !extension->present) return readXImage(x, window);
        if (!windows.contains(window)) {
            if (windows.size() >= 64) {
                const auto oldest = std::min_element(windows.begin(), windows.end(),
                    [](const auto &a, const auto &b) { return a.second < b.second; });
                release(oldest->first);
            }
            auto *error = xcb_request_check(x.connection,
                xcb_composite_redirect_window_checked(x.connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC));
            if (error) { std::free(error); return {}; }
        }
        windows[window] = Clock::now();
        const auto pixmap = xcb_generate_id(x.connection);
        auto *error = xcb_request_check(x.connection,
            xcb_composite_name_window_pixmap_checked(x.connection, window, pixmap));
        if (error) { std::free(error); release(window); return {}; }
        auto image = readXImage(x, pixmap);
        xcb_free_pixmap(x.connection, pixmap);
        if (image.isNull()) release(window);
        xcb_flush(x.connection);
        return image;
    }
};

}

namespace versus::video {
struct WindowCapture::Impl {
    std::atomic<bool> running{false};
    std::atomic<bool> startCancelled{false};
    std::atomic<int> fps{60};
    std::atomic<uint64_t> skipped{0};
    FrameCallback callback;
    FrameAdmissionCallback admission;
    std::thread worker;
    std::mutex readyMutex;
    std::condition_variable ready;
    bool firstFrame = false;
    QString session;
    pw_thread_loop *loop = nullptr;
    pw_context *context = nullptr;
    pw_core *core = nullptr;
    pw_stream *stream = nullptr;
    spa_hook listener{};
    spa_video_info_raw format{};
    detail::CaptureFramePacer pacer;
    int pacingFps = 60;
    int64_t timestampOffset = 0;
    bool haveTimestampOffset = false;

    ~Impl() { stop(); }
    void deliver(CapturedFrame frame) {
        if (!running.load()) return;
        if (callback) callback(std::move(frame));
        { std::lock_guard lock(readyMutex); firstFrame = true; }
        ready.notify_all();
    }
    bool admit() {
        const int target = fps.load();
        if (target != pacingFps) { pacer.reset(target); pacingFps = target; }
        if (!pacer.shouldAdmit(std::chrono::steady_clock::now()) || !detail::frameAdmissionAllowed(admission)) {
            ++skipped; return false;
        }
        return true;
    }
    static void stateChanged(void *data, pw_stream_state, pw_stream_state state, const char *error) {
        auto &self = *static_cast<Impl *>(data);
        if (state == PW_STREAM_STATE_ERROR || state == PW_STREAM_STATE_UNCONNECTED) {
            if (error) spdlog::warn("[PipeWire] {}", error);
            self.running = false; self.ready.notify_all();
        }
    }
    static void parameterChanged(void *data, uint32_t id, const spa_pod *pod) {
        auto &self = *static_cast<Impl *>(data);
        if (id != SPA_PARAM_Format || !pod) return;
        spa_video_info_raw format{};
        if (spa_format_video_raw_parse(pod, &format) < 0 ||
            format.size.width < 1 || format.size.height < 1 || format.size.width > 8192 || format.size.height > 8192 ||
            (format.format != SPA_VIDEO_FORMAT_BGRA && format.format != SPA_VIDEO_FORMAT_BGRx &&
             format.format != SPA_VIDEO_FORMAT_RGBA && format.format != SPA_VIDEO_FORMAT_RGBx)) {
            self.running = false; self.ready.notify_all(); return;
        }
        self.format = format;
        uint8_t storage[512];
        spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
        const spa_pod *metadata[] = {
            static_cast<const spa_pod *>(spa_pod_builder_add_object(&builder,
                SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
                SPA_PARAM_META_type, SPA_POD_Id(SPA_META_Header),
                SPA_PARAM_META_size, SPA_POD_Int(sizeof(spa_meta_header)))),
            static_cast<const spa_pod *>(spa_pod_builder_add_object(&builder,
                SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
                SPA_PARAM_META_type, SPA_POD_Id(SPA_META_VideoCrop),
                SPA_PARAM_META_size, SPA_POD_Int(sizeof(spa_meta_region))))};
        pw_stream_update_params(self.stream, metadata, 2);
        spdlog::info("[PipeWire] Capture format {}x{}, rate {}/{}, maximum {}/{}",
            format.size.width, format.size.height, format.framerate.num, format.framerate.denom,
            format.max_framerate.num, format.max_framerate.denom);
    }
    static void process(void *data) {
        auto &self = *static_cast<Impl *>(data);
        auto *buffer = pw_stream_dequeue_buffer(self.stream);
        if (!buffer) return;
        const auto *header = static_cast<spa_meta_header *>(spa_buffer_find_meta_data(buffer->buffer, SPA_META_Header, sizeof(spa_meta_header)));
        // Reuse the bounded, opt-in trace. These stages carry the producer's
        // raw PTS (100 ns) in output100ns, not the application's mapped clock.
        const int64_t producerPts = header && header->pts >= 0 ? header->pts / 100 : -1;
        auto &trace = app::detail::FrameTrace::instance();
        trace.record("pipewire-arrival", nullptr, producerPts);
        struct ReturnBuffer {
            pw_stream *stream; pw_buffer *buffer; int64_t pts;
            ~ReturnBuffer() {
                pw_stream_queue_buffer(stream, buffer);
                app::detail::FrameTrace::instance().record("pipewire-return", nullptr, pts);
            }
        } release{self.stream, buffer, producerPts};
        const auto *spa = buffer->buffer;
        if (!self.running || !self.format.size.width || spa->n_datas < 1) return;
        if (!self.admit()) {
            trace.record("pipewire-rejected", nullptr, producerPts);
            return;
        }
        const auto &pixels = spa->datas[0];
        const auto *chunk = pixels.chunk;
        auto width = self.format.size.width, height = self.format.size.height;
        uint32_t left = 0, top = 0;
        const auto *crop = static_cast<spa_meta_region *>(spa_buffer_find_meta_data(buffer->buffer, SPA_META_VideoCrop, sizeof(spa_meta_region)));
        if (crop && spa_meta_region_is_valid(crop)) {
            const auto &region = crop->region;
            if (region.position.x < 0 || region.position.y < 0 ||
                uint64_t(region.position.x) + region.size.width > width ||
                uint64_t(region.position.y) + region.size.height > height) return;
            left = region.position.x; top = region.position.y;
            width = region.size.width; height = region.size.height;
        }
        if (!pixels.data || !chunk || (chunk->flags & SPA_CHUNK_FLAG_CORRUPTED) ||
            chunk->stride < int32_t(self.format.size.width * 4) || chunk->offset > pixels.maxsize) return;
        const uint64_t end = uint64_t(chunk->stride) * (top + height - 1) + (left + width) * 4;
        if (end > pixels.maxsize - chunk->offset || end > chunk->size) return;
        CapturedFrame frame;
        frame.width = width; frame.height = height; frame.stride = width * 4;
        frame.format = CapturedFrame::Format::BGRA;
        frame.data.resize(size_t(frame.stride) * height);
        const auto *source = static_cast<const uint8_t *>(pixels.data) + chunk->offset +
            uint64_t(top) * chunk->stride + left * 4;
        const bool rgb = self.format.format == SPA_VIDEO_FORMAT_RGBA || self.format.format == SPA_VIDEO_FORMAT_RGBx;
        // ScreenCast does not promise meaningful alpha. Treat its pixels as
        // opaque; transparent producer support is a separate parity workflow.
        for (unsigned y = 0; y < height; ++y) {
            auto *destination = frame.data.data() + y * frame.stride;
            std::memcpy(destination, source + size_t(y) * chunk->stride, frame.stride);
            for (unsigned x = 0; x < width; ++x) {
                if (rgb) std::swap(destination[x * 4], destination[x * 4 + 2]);
                destination[x * 4 + 3] = 255;
            }
        }
        trace.record("pipewire-copied", nullptr, producerPts);
        frame.timestamp = webrtc::mediaTime100ns();
        if (header && header->pts >= 0) {
            if (!self.haveTimestampOffset) {
                self.timestampOffset = frame.timestamp - header->pts / 100;
                self.haveTimestampOffset = true;
            }
            frame.timestamp = header->pts / 100 + self.timestampOffset;
        }
        self.deliver(std::move(frame));
    }
    bool startPortal() {
        QVariantMap result;
        const auto token = "gc_" + QUuid::createUuid().toString(QUuid::Id128);
        // Keep the documented session handle even if cancellation wins the
        // race with CreateSession's Response, so rollback can close it.
        // https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Session.html
        auto sender = QDBusConnection::sessionBus().baseService().mid(1);
        sender.replace('.', '_');
        session = "/org/freedesktop/portal/desktop/session/" + sender + "/" + token;
        if (!portalRequest("CreateSession", {}, {{"session_handle_token", token}}, result, running, startCancelled)) return false;
        const auto handle = result.value("session_handle");
        session = handle.canConvert<QDBusObjectPath>() ? qvariant_cast<QDBusObjectPath>(handle).path() : handle.toString();
        if (session.isEmpty()) return false;
        const auto object = QVariant::fromValue(QDBusObjectPath(session));
        if (!portalRequest("SelectSources", {object}, {{"types", uint(2)}, {"multiple", false}, {"cursor_mode", uint(2)}}, result, running, startCancelled)) return false;
        if (!portalRequest("Start", {object, QString()}, {}, result, running, startCancelled)) return false;
        const auto streams = qvariant_cast<QDBusArgument>(result.value("streams"));
        uint node = PW_ID_ANY;
        QVariantMap properties;
        streams.beginArray();
        if (!streams.atEnd()) { streams.beginStructure(); streams >> node >> properties; streams.endStructure(); }
        streams.endArray();
        if (node == PW_ID_ANY) return false;
        auto call = QDBusMessage::createMethodCall(portalService, portalPath, portalInterface, "OpenPipeWireRemote");
        call.setArguments({object, QVariantMap()});
        QDBusReply<QDBusUnixFileDescriptor> reply = QDBusConnection::sessionBus().call(call, QDBus::Block, 5000);
        if (!reply.isValid() || !reply.value().isValid()) return false;
        const int fd = fcntl(reply.value().fileDescriptor(), F_DUPFD_CLOEXEC, 3);
        if (fd < 0) return false;
        static std::once_flag initialized;
        std::call_once(initialized, [] { pw_init(nullptr, nullptr); });
        loop = pw_thread_loop_new("game-capture", nullptr);
        if (!loop) { ::close(fd); return false; }
        context = pw_context_new(pw_thread_loop_get_loop(loop), nullptr, 0);
        if (!context) { ::close(fd); return false; }
        core = pw_context_connect_fd(context, fd, nullptr, 0); // Takes ownership of fd.
        if (!core) return false;
        stream = pw_stream_new(core, "Game Capture", pw_properties_new(PW_KEY_MEDIA_TYPE, "Video",
            PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_MEDIA_ROLE, "Screen", nullptr));
        if (!stream) return false;
        static const pw_stream_events events = [] {
            pw_stream_events e{}; e.version = PW_VERSION_STREAM_EVENTS;
            e.state_changed = stateChanged; e.param_changed = parameterChanged; e.process = process; return e;
        }();
        pw_stream_add_listener(stream, &listener, &events, this);
        uint8_t storage[1024];
        spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
        const spa_pod *parameters[] = {static_cast<const spa_pod *>(spa_pod_builder_add_object(&builder,
            SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
            SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
            SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
            // An enum's first value is its default; allowed alternatives start
            // at the second value, so the preferred format must appear twice.
            SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRA,
                SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_RGBA)))};
        const int status = pw_stream_connect(stream, PW_DIRECTION_INPUT, node,
            static_cast<pw_stream_flags>(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS), parameters, 1);
        if (status < 0 || pw_thread_loop_start(loop) < 0) return false;
        std::unique_lock lock(readyMutex);
        return ready.wait_for(lock, std::chrono::seconds(8), [&] { return firstFrame || !running || startCancelled; }) && firstFrame && running && !startCancelled;
    }
    bool startX11(xcb_window_t window) {
        worker = std::thread([this, window] {
            XConnection x;
            if (!x.connection) { running = false; ready.notify_all(); return; }
            const auto *extension = xcb_get_extension_data(x.connection, &xcb_composite_id);
            bool redirected = false;
            if (extension && extension->present) {
                auto *error = xcb_request_check(x.connection, xcb_composite_redirect_window_checked(x.connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC));
                redirected = !error; std::free(error);
            }
            xcb_damage_damage_t damage = XCB_NONE;
            const auto *damageExtension = xcb_get_extension_data(x.connection, &xcb_damage_id);
            if (damageExtension && damageExtension->present) {
                auto *version = xcb_damage_query_version_reply(x.connection,
                    xcb_damage_query_version(x.connection, 1, 1), nullptr);
                if (version && version->major_version == 1) {
                    const auto candidate = xcb_generate_id(x.connection);
                    auto *error = xcb_request_check(x.connection, xcb_damage_create_checked(
                        x.connection, candidate, window, XCB_DAMAGE_REPORT_LEVEL_NON_EMPTY));
                    if (!error) damage = candidate;
                    std::free(error);
                }
                std::free(version);
            }
            // A static source still needs prompt destruction/resize detection.
            // This connection's event mask does not replace another client's.
            const uint32_t eventMask = XCB_EVENT_MASK_STRUCTURE_NOTIFY;
            auto *eventError = xcb_request_check(x.connection, xcb_change_window_attributes_checked(
                x.connection, window, XCB_CW_EVENT_MASK, &eventMask));
            if (eventError) { running = false; std::free(eventError); }
            spdlog::info("[X11] Window capture uses {}", damage ? "damage notifications" : "timed fallback (DAMAGE unavailable)");
            auto next = std::chrono::steady_clock::now();
            bool changed = true;
            while (running.load()) {
                while (auto *event = xcb_poll_for_event(x.connection)) {
                    const auto type = event->response_type & 0x7f;
                    if (damage && type == damageExtension->first_event + XCB_DAMAGE_NOTIFY) {
                        const auto *notification = reinterpret_cast<xcb_damage_notify_event_t *>(event);
                        if (notification->damage == damage) changed = true;
                    } else if (type == XCB_DESTROY_NOTIFY) {
                        if (reinterpret_cast<xcb_destroy_notify_event_t *>(event)->window == window) running = false;
                    } else if (type == XCB_CONFIGURE_NOTIFY) {
                        if (reinterpret_cast<xcb_configure_notify_event_t *>(event)->window == window) changed = true;
                    } else if (type == XCB_MAP_NOTIFY) {
                        if (reinterpret_cast<xcb_map_notify_event_t *>(event)->window == window) changed = true;
                    }
                    std::free(event);
                }
                if (!running || xcb_connection_has_error(x.connection)) { running = false; break; }
                const auto interval = std::chrono::nanoseconds(1000000000 / std::max(1, fps.load()));
                QImage image;
                if ((!damage || changed) && admit()) {
                    // Rearm before reading so a later drawing operation remains
                    // pending. Coalesce damage until admission allows readback;
                    // never lose a source's final update when it becomes idle.
                    if (damage) xcb_damage_subtract(x.connection, damage, XCB_NONE, XCB_NONE);
                    changed = false;
                    if (redirected) {
                        const auto pixmap = xcb_generate_id(x.connection);
                        auto *error = xcb_request_check(x.connection, xcb_composite_name_window_pixmap_checked(x.connection, window, pixmap));
                        if (!error) { image = readXImage(x, pixmap); xcb_free_pixmap(x.connection, pixmap); }
                        std::free(error);
                    } else image = readXImage(x, window);
                    if (image.isNull()) { running = false; break; }
                    CapturedFrame frame;
                    frame.width = image.width(); frame.height = image.height(); frame.stride = image.bytesPerLine();
                    frame.timestamp = webrtc::mediaTime100ns();
                    frame.data.assign(image.constBits(), image.constBits() + image.sizeInBytes());
                    deliver(std::move(frame));
                    // Synchronous X replies can queue a damage event inside
                    // XCB while draining the socket. Inspect that queue before
                    // polling the descriptor again.
                    if (damage) continue;
                } else if (damage && changed) {
                    // Keep the pending image, but allow a newer drawing event
                    // to wake admission earlier than the idle retry timeout.
                    xcb_damage_subtract(x.connection, damage, XCB_NONE, XCB_NONE);
                    xcb_flush(x.connection);
                }
                const auto now = std::chrono::steady_clock::now();
                if (damage) {
                    // No independent sampling clock: wake for the next changed
                    // image, an admission retry, or bounded stop polling.
                    const auto wait = changed ? interval : std::chrono::steady_clock::duration(std::chrono::milliseconds(100));
                    const int timeout = std::clamp<int>(std::chrono::duration_cast<std::chrono::milliseconds>(wait).count() + 1, 1, 100);
                    pollfd descriptor{xcb_get_file_descriptor(x.connection), POLLIN, 0};
                    const int status = poll(&descriptor, 1, timeout);
                    if ((status < 0 && errno != EINTR) || (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL))) running = false;
                } else {
                    next += interval;
                    if (next < now) next = now;
                    std::this_thread::sleep_until(next);
                }
            }
            if (damage) xcb_damage_destroy(x.connection, damage);
            if (redirected) xcb_composite_unredirect_window(x.connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC);
            ready.notify_all();
        });
        std::unique_lock lock(readyMutex);
        return ready.wait_for(lock, std::chrono::seconds(5), [&] { return firstFrame || !running || startCancelled; }) && firstFrame && running && !startCancelled;
    }
    void stop() {
        running = false;
        if (worker.joinable()) worker.join();
        if (loop) pw_thread_loop_stop(loop);
        if (stream) { pw_stream_destroy(stream); stream = nullptr; }
        if (core) { pw_core_disconnect(core); core = nullptr; }
        if (context) { pw_context_destroy(context); context = nullptr; }
        if (loop) { pw_thread_loop_destroy(loop); loop = nullptr; }
        if (!session.isEmpty()) {
            auto close = QDBusMessage::createMethodCall(portalService, session, "org.freedesktop.portal.Session", "Close");
            QDBusConnection::sessionBus().asyncCall(close); session.clear();
        }
        firstFrame = false; haveTimestampOffset = false; format = {}; skipped = 0;
    }
};

WindowCapture::WindowCapture() : impl_(std::make_unique<Impl>()) {}
WindowCapture::~WindowCapture() = default;
std::vector<WindowInfo> WindowCapture::getWindows() {
    if (!qEnvironmentVariableIsEmpty("WAYLAND_DISPLAY") || qEnvironmentVariable("XDG_SESSION_TYPE") == "wayland")
        return {{"portal:window", "Choose a window… (desktop permission dialog)", "Desktop portal", 0, 0, 0}};
    return xWindows();
}
WindowInfo *WindowCapture::findWindowByName(const std::string &filter) {
    static thread_local WindowInfo selected;
    const auto windows = getWindows();
    if (const auto *match = findBestWindowMatch(windows, filter)) { selected = *match; return &selected; }
    return nullptr;
}
bool WindowCapture::startCapture(const std::string &id, int, int, int fps, bool preserveAlpha) {
    stopCapture();
    if (impl_->startCancelled.load()) return false;
    if (preserveAlpha) spdlog::warn("[LinuxCapture] Desktop window capture currently supplies opaque pixels");
    impl_->callback = frameCallback_; impl_->admission = frameAdmissionCallback_;
    impl_->fps = std::clamp(fps, 1, 240); impl_->pacer.reset(impl_->fps); impl_->pacingFps = impl_->fps;
    impl_->running = true;
    xcb_window_t window = 0;
    const bool ok = id == "portal:window" ? impl_->startPortal() : xWindowId(id, window) && impl_->startX11(window);
    if (!ok) impl_->stop();
    return ok;
}
void WindowCapture::prepareCaptureStart() { impl_->startCancelled = false; }
void WindowCapture::cancelCaptureStart() {
    {
        std::lock_guard lock(impl_->readyMutex);
        impl_->startCancelled = true;
    }
    impl_->ready.notify_all();
}
bool WindowCapture::captureStartCancelled() const { return impl_->startCancelled.load(); }
void WindowCapture::stopCapture() { impl_->stop(); }
bool WindowCapture::isCapturing() const { return impl_->running; }
void WindowCapture::setFrameRate(int fps) { impl_->fps = std::clamp(fps, 1, 240); }
void WindowCapture::setFrameCallback(FrameCallback cb) { frameCallback_ = std::move(cb); }
void WindowCapture::setFrameAdmissionCallback(FrameAdmissionCallback cb) { frameAdmissionCallback_ = std::move(cb); }
uint64_t WindowCapture::framesSkippedBeforeReadback() const { return impl_->skipped; }
QPixmap WindowCapture::captureWindowThumbnail(const std::string &id, int width, int height) {
    xcb_window_t window;
    if (!xWindowId(id, window)) return {};
    // QPixmap callers are GUI-thread UI code. Parenting to the application
    // closes the X connection (and all its redirects) during application exit.
    static QPointer<ThumbnailCapture> thumbnails;
    if (!thumbnails) thumbnails = new ThumbnailCapture(QCoreApplication::instance());
    return QPixmap::fromImage(thumbnails->read(window).scaled(width, height, Qt::KeepAspectRatio, Qt::SmoothTransformation));
}
}
#include "window_capture.moc"
