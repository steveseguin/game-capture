#include "versus/platform/linux_shortcuts.h"
#include <QDBusArgument>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusMetaType>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusServiceWatcher>
#include <QSet>
#include <QSocketNotifier>
#include <QTimer>
#include <QUuid>
#include <xcb/xcb.h>
#include <array>
#include <cstdlib>

struct Shortcut { QString id; QVariantMap properties; };
Q_DECLARE_METATYPE(Shortcut)
using Shortcuts = QList<Shortcut>;
Q_DECLARE_METATYPE(Shortcuts)
QDBusArgument &operator<<(QDBusArgument &a, const Shortcut &s) { a.beginStructure(); a << s.id << s.properties; a.endStructure(); return a; }
const QDBusArgument &operator>>(const QDBusArgument &a, Shortcut &s) { a.beginStructure(); a >> s.id >> s.properties; a.endStructure(); return a; }

namespace versus::platform {
namespace {
constexpr auto service = "org.freedesktop.portal.Desktop";
constexpr auto path = "/org/freedesktop/portal/desktop";
constexpr auto interface = "org.freedesktop.portal.GlobalShortcuts";
const QStringList ids{"live", "mute", "talk"};
const QStringList descriptions{"Start or stop streaming", "Toggle microphone mute", "Hold to talk (release mutes microphone)"};
}
struct LinuxShortcuts::State {
    xcb_connection_t *connection = nullptr;
    QSocketNotifier *notifier = nullptr;
    QTimer timeout;
    QTimer health;
    QString session, requestPath, method;
    QSet<QString> bound;
    std::array<int, 3> codes{};
    std::array<bool, 3> pressed{};
    std::array<unsigned, 3> releases{};
    unsigned generation = 0;
};
LinuxShortcuts::LinuxShortcuts(QObject *parent) : QObject(parent), state_(std::make_unique<State>()) {
    qDBusRegisterMetaType<Shortcut>(); qDBusRegisterMetaType<Shortcuts>();
    state_->timeout.setSingleShot(true);
    connect(&state_->timeout, &QTimer::timeout, this, [this] { fail("Shortcut permission timed out. Disable and enable shortcuts to retry."); });
    auto bus = QDBusConnection::sessionBus();
    bus.connect(service, path, interface, "Activated", this, SLOT(portalPressed(QDBusObjectPath,QString,qulonglong,QVariantMap)));
    bus.connect(service, path, interface, "Deactivated", this, SLOT(portalReleased(QDBusObjectPath,QString,qulonglong,QVariantMap)));
    auto *watcher = new QDBusServiceWatcher(service, bus, QDBusServiceWatcher::WatchForUnregistration, this);
    connect(watcher, &QDBusServiceWatcher::serviceUnregistered, this, [this] {
        if (!state_->session.isEmpty()) fail("Desktop shortcut service disconnected. Disable and enable shortcuts to reconnect.");
    });
    connect(&state_->health, &QTimer::timeout, this, [this] {
        if (state_->connection && xcb_connection_has_error(state_->connection)) fail("X11 shortcut connection was lost.");
    });
}
LinuxShortcuts::~LinuxShortcuts() { blockSignals(true); close(); }
void LinuxShortcuts::close() {
    auto &s = *state_; ++s.generation; s.timeout.stop(); s.health.stop();
    for (int i = 0; i < 3; ++i) {
        ++s.releases[i];
        if (s.pressed[i]) { s.pressed[i] = false; emit activated(i, false); }
    }
    delete s.notifier; s.notifier = nullptr;
    if (s.connection) { xcb_disconnect(s.connection); s.connection = nullptr; }
    auto bus = QDBusConnection::sessionBus();
    if (!s.requestPath.isEmpty()) {
        bus.disconnect(service, s.requestPath, "org.freedesktop.portal.Request", "Response", this, SLOT(response(uint,QVariantMap)));
        bus.asyncCall(QDBusMessage::createMethodCall(service, s.requestPath, "org.freedesktop.portal.Request", "Close"));
        s.requestPath.clear();
    }
    if (!s.session.isEmpty()) {
        bus.disconnect(service, s.session, "org.freedesktop.portal.Session", "Closed", this, SLOT(sessionClosed()));
        bus.asyncCall(QDBusMessage::createMethodCall(service, s.session, "org.freedesktop.portal.Session", "Close"));
        s.session.clear();
    }
    s.bound.clear();
}
void LinuxShortcuts::fail(const QString &message) { close(); emit statusChanged(message); }
void LinuxShortcuts::setEnabled(bool enabled) {
    close();
    if (!enabled) { emit statusChanged("Global shortcuts off"); return; }
    auto &s = *state_;
    if (!qEnvironmentVariableIsEmpty("WAYLAND_DISPLAY") || qEnvironmentVariable("XDG_SESSION_TYPE") == "wayland") {
        const auto token = "gc_shortcuts_" + QUuid::createUuid().toString(QUuid::Id128);
        auto sender = QDBusConnection::sessionBus().baseService().mid(1); sender.replace('.', '_');
        s.session = "/org/freedesktop/portal/desktop/session/" + sender + "/" + token;
        emit statusChanged("Waiting for desktop shortcut permission…");
        request("CreateSession", {}, {{"session_handle_token", token}});
        return;
    }
    int number = 0;
    s.connection = xcb_connect(nullptr, &number);
    if (xcb_connection_has_error(s.connection)) { fail("Could not connect to X11 for global shortcuts."); return; }
    const auto *setup = xcb_get_setup(s.connection);
    auto screens = xcb_setup_roots_iterator(setup);
    while (number-- && screens.rem) xcb_screen_next(&screens);
    if (!screens.rem) { fail("X11 screen is unavailable."); return; }
    auto *mapping = xcb_get_keyboard_mapping_reply(s.connection,
        xcb_get_keyboard_mapping(s.connection, setup->min_keycode, setup->max_keycode - setup->min_keycode + 1), nullptr);
    if (!mapping) { fail("Could not read X11 keyboard mapping."); return; }
    const auto *symbols = xcb_get_keyboard_mapping_keysyms(mapping);
    s.codes.fill(0);
    int numLockCode = 0;
    for (int code = setup->min_keycode; code <= setup->max_keycode; ++code) {
        const auto symbol = symbols[(code - setup->min_keycode) * mapping->keysyms_per_keycode];
        for (int i = 0; i < 3; ++i) if (symbol == unsigned(0xffc5 + i)) s.codes[i] = code;
        if (symbol == 0xff7f) numLockCode = code;
    }
    std::free(mapping);
    unsigned numLock = 0;
    auto *mods = xcb_get_modifier_mapping_reply(s.connection, xcb_get_modifier_mapping(s.connection), nullptr);
    if (mods) {
        const auto *codes = xcb_get_modifier_mapping_keycodes(mods);
        for (int mod = 0; mod < 8; ++mod)
            for (int k = 0; k < mods->keycodes_per_modifier; ++k)
                if (numLockCode && codes[mod * mods->keycodes_per_modifier + k] == numLockCode) numLock |= 1u << mod;
        std::free(mods);
    }
    const QSet<unsigned> locks{0u, unsigned(XCB_MOD_MASK_LOCK), numLock, numLock | XCB_MOD_MASK_LOCK};
    for (int code : s.codes) {
        if (!code) { fail("F8–F10 are unavailable in this keyboard layout."); return; }
        for (unsigned lock : locks) {
            auto *error = xcb_request_check(s.connection, xcb_grab_key_checked(s.connection, 0, screens.data->root,
                XCB_MOD_MASK_CONTROL | XCB_MOD_MASK_SHIFT | lock, code, XCB_GRAB_MODE_ASYNC, XCB_GRAB_MODE_ASYNC));
            if (error) { std::free(error); fail("Ctrl+Shift+F8/F9/F10 is already in use. Free these shortcuts and enable again."); return; }
        }
    }
    s.notifier = new QSocketNotifier(xcb_get_file_descriptor(s.connection), QSocketNotifier::Read, this);
    connect(s.notifier, &QSocketNotifier::activated, this, [this] {
        auto &s = *state_;
        while (s.connection) {
            auto *event = xcb_poll_for_event(s.connection);
            if (!event) break;
            const int type = event->response_type & 0x7f;
            const int code = reinterpret_cast<xcb_key_press_event_t *>(event)->detail;
            std::free(event);
            if (type == XCB_MAPPING_NOTIFY) { fail("Keyboard layout changed. Disable and enable global shortcuts to rebind."); return; }
            for (int i = 0; i < 3; ++i) if (s.codes[i] == code) {
                if (type == XCB_KEY_PRESS) {
                    ++s.releases[i];
                    if (!s.pressed[i]) { s.pressed[i] = true; emit activated(i, true); }
                } else if (type == XCB_KEY_RELEASE) {
                    const auto serial = ++s.releases[i];
                    QTimer::singleShot(15, this, [this, i, serial] {
                        auto &s = *state_;
                        if (serial == s.releases[i] && s.pressed[i]) { s.pressed[i] = false; emit activated(i, false); }
                    });
                }
            }
        }
    });
    xcb_flush(s.connection); s.health.start(1000);
    emit statusChanged("Ctrl+Shift+F8: Start/Stop · F9: Mic mute · F10: Hold to talk (release mutes)");
}
void LinuxShortcuts::request(const QString &method, QVariantList arguments, QVariantMap options) {
    auto &s = *state_; auto bus = QDBusConnection::sessionBus();
    const auto token = "gc_keys_" + QUuid::createUuid().toString(QUuid::Id128);
    auto sender = bus.baseService().mid(1); sender.replace('.', '_');
    s.requestPath = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token; s.method = method;
    if (!bus.connect(service, s.requestPath, "org.freedesktop.portal.Request", "Response", this, SLOT(response(uint,QVariantMap)))) {
        fail("Could not listen for shortcut permission."); return;
    }
    options.insert("handle_token", token); arguments.append(options);
    auto message = QDBusMessage::createMethodCall(service, path, interface, method); message.setArguments(arguments);
    auto *pending = new QDBusPendingCallWatcher(bus.asyncCall(message, 5000), this);
    const auto generation = s.generation;
    connect(pending, &QDBusPendingCallWatcher::finished, this, [this, generation](QDBusPendingCallWatcher *watcher) {
        QDBusPendingReply<QDBusObjectPath> reply = *watcher; watcher->deleteLater();
        if (generation == state_->generation && reply.isError()) fail("Global shortcuts are unavailable or denied by this desktop. GUI controls remain available.");
    });
    s.timeout.start(60000);
}
void LinuxShortcuts::response(uint code, const QVariantMap &results) {
    auto &s = *state_; auto bus = QDBusConnection::sessionBus(); s.timeout.stop();
    bus.disconnect(service, s.requestPath, "org.freedesktop.portal.Request", "Response", this, SLOT(response(uint,QVariantMap)));
    s.requestPath.clear();
    if (code != 0) { fail("Global shortcuts were cancelled or denied. Disable and enable to retry."); return; }
    if (s.method == "CreateSession") {
        const auto value = results.value("session_handle");
        s.session = value.canConvert<QDBusObjectPath>() ? qvariant_cast<QDBusObjectPath>(value).path() : value.toString();
        if (s.session.isEmpty()) { fail("Desktop returned no shortcut session."); return; }
        bus.connect(service, s.session, "org.freedesktop.portal.Session", "Closed", this, SLOT(sessionClosed()));
        Shortcuts shortcuts;
        for (int i = 0; i < 3; ++i) shortcuts.append({ids[i], {{"description", descriptions[i]}, {"preferred_trigger", QString("CTRL+SHIFT+F%1").arg(8 + i)}}});
        request("BindShortcuts", {QVariant::fromValue(QDBusObjectPath(s.session)), QVariant::fromValue(shortcuts), QString()}, {});
    } else {
        const auto shortcuts = qdbus_cast<Shortcuts>(results.value("shortcuts"));
        QStringList labels;
        for (const auto &shortcut : shortcuts) if (ids.contains(shortcut.id)) {
            s.bound.insert(shortcut.id);
            labels << descriptions[ids.indexOf(shortcut.id)] + ": " + shortcut.properties.value("trigger_description").toString();
        }
        if (s.bound.isEmpty()) { fail("No global shortcuts were granted by the desktop."); return; }
        emit statusChanged(labels.join(" · "));
    }
}
void LinuxShortcuts::portalPressed(const QDBusObjectPath &session, const QString &id, qulonglong, const QVariantMap &) {
    auto &s = *state_; const int i = ids.indexOf(id);
    if (session.path() == s.session && s.bound.contains(id) && i >= 0 && !s.pressed[i]) { s.pressed[i] = true; emit activated(i, true); }
}
void LinuxShortcuts::portalReleased(const QDBusObjectPath &session, const QString &id, qulonglong, const QVariantMap &) {
    auto &s = *state_; const int i = ids.indexOf(id);
    if (session.path() == s.session && i >= 0 && s.pressed[i]) { s.pressed[i] = false; emit activated(i, false); }
}
void LinuxShortcuts::sessionClosed() { fail("Desktop closed the shortcut session. Disable and enable to reconnect."); }
}
