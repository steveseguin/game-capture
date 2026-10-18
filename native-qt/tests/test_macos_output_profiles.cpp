#include <QtTest>
#include "versus/platform/macos_output_profiles.h"
using namespace versus::platform;
class MacOutputProfileGate : public QObject {
    Q_OBJECT
private slots:
    void opaqueReferenceRoundTripUpdateAndDelete() {
        const QByteArray first = "{\"whip\":{\"url\":\"https://fixture.invalid/private-path\",\"token\":\"synthetic-first\"}}";
        const auto saved = saveOutputProfiles(first, {});
        QVERIFY2(saved.ok(), qPrintable(saved.error));
        struct Cleanup { QByteArray reference; ~Cleanup() { deleteOutputProfiles(reference); } } cleanup{saved.value};
        QVERIFY(saved.value.startsWith("mac-keychain-v1:"));
        QVERIFY(!saved.value.contains("fixture.invalid"));
        QVERIFY(!saved.value.contains("synthetic"));
        const auto read = loadOutputProfiles(saved.value);
        QVERIFY2(read.ok(), qPrintable(read.error)); QCOMPARE(read.value, first);
        const QByteArray second = "{\"whip\":{\"token\":\"synthetic-second\"}}";
        const auto changed = saveOutputProfiles(second, saved.value);
        QVERIFY2(changed.ok(), qPrintable(changed.error)); QCOMPARE(changed.value, saved.value);
        QCOMPARE(loadOutputProfiles(saved.value).value, second);
        QVERIFY(!saveOutputProfiles(second, "untrusted-reference").ok());
        QVERIFY(!loadOutputProfiles("untrusted-reference").ok());
        QVERIFY(!deleteOutputProfiles("untrusted-reference").ok());
        QCOMPARE(loadOutputProfiles(saved.value).value, second);
        QVERIFY(deleteOutputProfiles(saved.value).ok());
        QVERIFY(!loadOutputProfiles(saved.value).ok());
        QVERIFY(!saveOutputProfiles(first, saved.value).ok());
        QVERIFY(deleteOutputProfiles(saved.value).ok());
    }
};
QTEST_GUILESS_MAIN(MacOutputProfileGate)
#include "test_macos_output_profiles.moc"
