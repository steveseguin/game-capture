#include <QtTest>
#include <QProcess>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QFile>
#include <QUuid>
#include <QElapsedTimer>
#include <algorithm>
#include <array>
#include <mutex>
#include <set>
#include "versus/platform/macos_syphon_capture.h"
#include "../src/platform/macos/alpha_conversion.h"
using versus::platform::MacSyphonCapture;
struct Sender {
    QProcess process;
    QByteArray output;
    QString uuid;
    ~Sender() {
        if (process.state()!=QProcess::NotRunning) {
            process.write("quit\n");
            if (!process.waitForFinished(3000)) { process.kill(); process.waitForFinished(3000); }
        }
    }
    void read() {
        output+=process.readAllStandardOutput();
        for (qsizetype end;(end=output.indexOf('\n'))>=0;) {
            const auto object=QJsonDocument::fromJson(output.first(end)).object();output.remove(0,end+1);
            if(object.contains("uuid"))uuid=object["uuid"].toString();
        }
    }
};
struct Observation {
    std::mutex mutex;
    int count=0,width=0,height=0;
    int64_t timestamp=0;
    bool bad=false;
    std::set<unsigned> identities;
    void accept(versus::video::CapturedFrame frame,bool premultiplied) {
        std::lock_guard lock(mutex);
        ++count;width=frame.width;height=frame.height;
        bad|=frame.timestamp<=timestamp||frame.stride!=width*4||frame.data.size()!=size_t(width)*height*4;
        timestamp=frame.timestamp;
        if(bad)return;
        for(int stripe=0;stripe<4;++stripe) {
            const auto *pixel=frame.data.data()+(height/3)*frame.stride+(stripe*width/4+width/8)*4;
            const bool zero=premultiplied&&stripe==0;
            bad|=pixel[0]!=(zero?0:30)||pixel[1]!=(zero?0:60)||pixel[2]!=(zero?0:240)||pixel[3]!=stripe*85;
        }
        unsigned identity=0;
        for(int bit=0;bit<16;++bit) {
            const auto *pixel=frame.data.data()+(height/16)*frame.stride+(bit*width/16+width/32)*4;
            bad|=pixel[3]!=255||pixel[0]!=pixel[1]||pixel[1]!=pixel[2]||(pixel[0]!=0&&pixel[0]!=255);
            if(pixel[0]>127)identity|=1u<<bit;
        }
        identities.insert(identity);
        const int left=int(identity*9)%std::max(1,width-80);
        for(int x=8;x<width;x+=16) {
            const auto *pixel=frame.data.data()+(height*3/4)*frame.stride+x*4;
            const bool moving=x>=left&&x<left+80;
            const int a=moving?170:x/(width/4)*85;
            const bool zero=premultiplied&&!a;
            bad|=pixel[0]!=(zero?0:moving?240:30)||pixel[1]!=(zero?0:moving?90:60)||
                pixel[2]!=(zero?0:moving?30:240)||pixel[3]!=a;
        }
    }
    int frames() { std::lock_guard lock(mutex);return count; }
    bool valid(int w,int h) { std::lock_guard lock(mutex);return !bad&&width==w&&height==h; }
    int distinct() { std::lock_guard lock(mutex);return int(identities.size()); }
};
class MacSyphonGate : public QObject {
    Q_OBJECT
private slots:
    void alphaNormalization() {
        // Every byte/alpha pair in each channel, with alpha retained exactly.
        std::vector<uint8_t> pixels;
        for (unsigned a=0;a<256;++a)for (unsigned c=0;c<256;++c)
            pixels.insert(pixels.end(),{uint8_t(c),uint8_t(255-c),uint8_t(c^0x5a),uint8_t(a)});
        const auto original=pixels;
        versus::platform::detail::unpremultiplyBgra(pixels.data(),pixels.size());
        for (size_t i=0;i<pixels.size();i+=4) {
            const unsigned a=original[i+3];QCOMPARE(pixels[i+3],original[i+3]);
            for (size_t c=0;c<3;++c)
                QCOMPARE(pixels[i+c],uint8_t(a?std::min(255u,(unsigned(original[i+c])*255+a/2)/a):0));
        }
    }
    void coherence() {
        const int seconds=qEnvironmentVariableIntValue("VERSUS_SYPHON_COHERENCE_SECONDS");
        if(!seconds)QSKIP("Set VERSUS_SYPHON_COHERENCE_SECONDS for the owned raw-capture diagnostic gate");
        QVERIFY(seconds>=10&&seconds<=90);
        Sender sender;const auto name="Owned Syphon coherence "+QUuid::createUuid().toString(QUuid::WithoutBraces);
        sender.process.start(QCoreApplication::applicationDirPath()+"/macos-syphon-fixture",{name,"straight","normal"});
        QVERIFY(sender.process.waitForStarted());
        QTRY_VERIFY_WITH_TIMEOUT(([&]{sender.read();return !sender.uuid.isEmpty();})(),10000);
        MacSyphonCapture capture;std::mutex mutex;int count=0,bad=0;QJsonArray failures;std::set<unsigned> identities;
        capture.setFrameCallback([&](auto frame){
            unsigned identity=0;
            for(int bit=0;bit<16;++bit)if(frame.data[(frame.height/16)*frame.stride+(bit*frame.width/16+frame.width/32)*4]>127)identity|=1u<<bit;
            const int left=int(identity*9)%(frame.width-80);QJsonArray mismatches;
            for(int y:{frame.height/2+4,frame.height*3/4,frame.height-4})for(int x=4;x<frame.width;x+=8){
                const auto *p=frame.data.data()+y*frame.stride+x*4;const bool moving=x>=left&&x<left+80;
                const std::array<int,4> expected=moving?std::array<int,4>{240,90,30,170}:std::array<int,4>{30,60,240,x/(frame.width/4)*85};
                bool match=true;for(int c=0;c<4;++c)match&=p[c]==expected[c];
                if(!match&&mismatches.size()<12)mismatches.append(QJsonObject{{"x",x},{"y",y},{"actualBGRA",QJsonArray{p[0],p[1],p[2],p[3]}},
                    {"expectedBGRA",QJsonArray{expected[0],expected[1],expected[2],expected[3]}}});
            }
            std::lock_guard lock(mutex);++count;identities.insert(identity);
            if(!mismatches.isEmpty()){++bad;if(failures.size()<20)failures.append(QJsonObject{{"identity",int(identity)},{"timestamp",QString::number(frame.timestamp)},{"pixels",mismatches}});}
        });
        QTRY_VERIFY_WITH_TIMEOUT(([&]{const auto sources=capture.getServers();return std::any_of(sources.begin(),sources.end(),[&](const auto &s){return s.id==sender.uuid.toStdString();});})(),10000);
        QVERIFY(capture.startCapture(sender.uuid.toStdString(),60));QTest::qWait(seconds*1000);capture.stopCapture();
        const auto readback=capture.readbackStats();
        const QJsonObject result{{"scope","Raw Syphon capture coherence diagnostic gate; no encoder or packaged application workflow"},
            {"readback",QJsonObject{{"gpuCopies",qint64(readback.gpuCopies)},{"verifiedFrames",qint64(readback.verifiedFrames)},
                {"mismatchedCopies",qint64(readback.mismatchedCopies)},{"deferredFrames",qint64(readback.deferredFrames)}}},
            {"seconds",seconds},{"frames",count},{"distinctIdentities",int(identities.size())},{"mismatchedFrames",bad},{"failures",failures}};
        const auto report=qEnvironmentVariable("VERSUS_SYPHON_COHERENCE_REPORT");
        if(!report.isEmpty()){QFile file(report);QVERIFY(file.open(QIODevice::WriteOnly));QVERIFY(file.write(QJsonDocument(result).toJson())>0);}
        qInfo()<<"Raw capture coherence frames"<<count<<"mismatched"<<bad;
        QVERIFY(count>=seconds*45);QVERIFY(int(identities.size())>=seconds*20);QCOMPARE(bad,0);
    }
    void transfer_data() {
        QTest::addColumn<bool>("premultiplied");QTest::addColumn<bool>("flipped");
        QTest::newRow("straight")<<false<<false;
        QTest::newRow("premultiplied")<<true<<false;
        QTest::newRow("straight-flipped")<<false<<true;
    }
    void transfer() {
        QFETCH(bool,premultiplied);QFETCH(bool,flipped);
        Sender sender;const auto name="Game Capture owned Syphon "+QUuid::createUuid().toString(QUuid::WithoutBraces);
        sender.process.start(QCoreApplication::applicationDirPath()+"/macos-syphon-fixture",
            {name,premultiplied?"premultiplied":"straight",flipped?"flipped":"normal"});
        QVERIFY(sender.process.waitForStarted());
        QTRY_VERIFY_WITH_TIMEOUT(([&]{sender.read();return !sender.uuid.isEmpty();})(),10000);
        MacSyphonCapture capture;Observation observed;
        capture.setFrameCallback([&](auto frame){observed.accept(std::move(frame),premultiplied);});
        QTRY_VERIFY_WITH_TIMEOUT(([&]{const auto sources=capture.getServers();return std::any_of(sources.begin(),sources.end(),[&](const auto &s){return s.id==sender.uuid.toStdString()&&s.name==name.toStdString();});})(),10000);
        QVERIFY(!capture.startCapture("not-a-syphon-uuid",30));QVERIFY(!capture.isCapturing());QVERIFY(!capture.lastError().empty());
        for(int generation=0;generation<3;++generation) {
            const auto start=observed.frames();
            QVERIFY(capture.startCapture(sender.uuid.toStdString(),30,premultiplied?MacSyphonCapture::Alpha::Premultiplied:MacSyphonCapture::Alpha::Straight));
            QTRY_VERIFY_WITH_TIMEOUT(observed.frames()>=start+15,3000);QVERIFY(observed.valid(640,360));
            QElapsedTimer timer;timer.start();capture.stopCapture();QVERIFY(timer.elapsed()<750);
            QVERIFY(!capture.isCapturing());const int stopped=observed.frames();QTest::qWait(200);QCOMPARE(observed.frames(),stopped);
        }
        QVERIFY(observed.distinct()>30);
        QVERIFY(capture.startCapture(sender.uuid.toStdString(),30,premultiplied?MacSyphonCapture::Alpha::Premultiplied:MacSyphonCapture::Alpha::Straight));
        sender.process.write("pause\n");QTest::qWait(200);
        const int beforeStatic=observed.frames(),beforeIdentities=observed.distinct();QTest::qWait(600);
        QVERIFY(observed.frames()>=beforeStatic+12);QCOMPARE(observed.distinct(),beforeIdentities);QVERIFY(capture.isCapturing());
        capture.setFrameRate(10);QTest::qWait(200);const int low=observed.frames();QTest::qWait(600);
        QVERIFY(observed.frames()-low>=4&&observed.frames()-low<=9);
        capture.setFrameRate(60);const int high=observed.frames();QTest::qWait(600);QVERIFY(observed.frames()-high>=25);
        sender.process.write("resume\nresize 320 240\n");
        QTRY_VERIFY_WITH_TIMEOUT(observed.valid(320,240),3000);
        sender.process.write("retire\n");
        QTRY_VERIFY_WITH_TIMEOUT(!capture.isCapturing(),5000);QVERIFY(sender.process.state()==QProcess::Running);
        QVERIFY(!capture.lastError().empty());capture.stopCapture();
        const auto oldUuid=sender.uuid;sender.process.write("restart\n");
        QTRY_VERIFY_WITH_TIMEOUT(([&]{sender.read();return sender.uuid!=oldUuid;})(),5000);
        QVERIFY(!capture.startCapture(oldUuid.toStdString(),30));
        QTRY_VERIFY_WITH_TIMEOUT(([&]{const auto sources=capture.getServers();return std::any_of(sources.begin(),sources.end(),[&](const auto &s){return s.id==sender.uuid.toStdString();});})(),5000);
        QVERIFY(capture.startCapture(sender.uuid.toStdString(),30,premultiplied?MacSyphonCapture::Alpha::Premultiplied:MacSyphonCapture::Alpha::Straight));
        const auto reconnected=observed.frames();QTRY_VERIFY_WITH_TIMEOUT(observed.frames()>reconnected+10,3000);
        sender.process.kill();QVERIFY(sender.process.waitForFinished(3000));
        QTRY_VERIFY_WITH_TIMEOUT(!capture.isCapturing(),5000);capture.stopCapture();QVERIFY(observed.valid(320,240));
    }
};
// Match the application's Cocoa event dispatcher: Syphon's distributed server
// announcements are delivered through the native application run loop.
QTEST_MAIN(MacSyphonGate)
#include "test_macos_syphon.moc"
