// Isolated native receiver: loads the installed OBS engine and plugin without
// opening the OBS frontend, user profiles, or any capture/audio input device.
// Records paired BGRA and actual black/white scene composition. This is not
// a claim of complete OBS frontend qualification.
#include <arm_acle.h> // Qt headers used with Clang 21 need the __yield declaration.
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSettings>
#include <QSaveFile>
#include <QRegularExpression>
#include <QSocketNotifier>
#include <QTimer>
#include <obs.h>
#include <atomic>
#include <mutex>
#include <cstdio>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cmath>

// Sample each complete candidate geometry independently from the same frame.
// A transition must match an old or new aspect fit; never mix their pixels.
static QJsonArray geometrySamples(const uint8_t *data,uint32_t stride,int width,int height) {
    QJsonArray result;
    for(const auto size:std::array<std::array<int,2>,3>{{{640,360},{720,960},{960,480}}}) {
        const double scale=std::min(double(width)/size[0],double(height)/size[1]);
        const double w=size[0]*scale,h=size[1]*scale,left=(width-w)/2,top=(height-h)/2;
        auto pixel=[&](double x,double y) {
            const int ix=std::clamp(int(std::floor(x)),0,width-1),iy=std::clamp(int(std::floor(y)),0,height-1);
            const auto *p=data+iy*stride+ix*4;return QJsonArray{p[2],p[1],p[0],p[3]};
        };
        auto content=[&](double x,double y){return pixel(left+x*w/640,top+y*h/360);};
        int identity=0;QJsonArray bands,edge,padding;
        for(int bit=0;bit<16;++bit){const auto p=content(bit*40+20,22);if(p[0].toInt()+p[1].toInt()+p[2].toInt()>384)identity|=1<<bit;}
        for(int stripe=0;stripe<4;++stripe)bands.append(content(stripe*160+80,120));
        for(int x=4;x<640;x+=8)edge.append(content(x,270));
        for(double fraction:{.25,.5,.75}) {
            if(left>4){padding.append(pixel(left/2,height*fraction));padding.append(pixel(width-left/2,height*fraction));}
            if(top>4){padding.append(pixel(width*fraction,top/2));padding.append(pixel(width*fraction,height-top/2));}
        }
        result.append(QJsonObject{{"sourceWidth",size[0]},{"sourceHeight",size[1]},
            {"identity",identity},{"bands",bands},{"edge",edge},{"padding",padding}});
    }
    return result;
}

struct CompositionSamples {
    std::atomic<int> phase{0};
    std::mutex mutex;
    QJsonArray black, white;
    QString segment="warmup";
    int limit=600;
    bool edges=false;
    bool geometries=false;
};
static void composed(void *context, video_data *frame) {
    auto &record=*static_cast<CompositionSamples *>(context);
    const int phase=record.phase.load();if(!phase)return;
    QJsonArray bands;int identity=0;
    for(int bit=0;bit<16;++bit) {
        const auto *p=frame->data[0]+22*frame->linesize[0]+(bit*40+20)*4;
        if(int(p[0])+p[1]+p[2]>384)identity|=1<<bit;
    }
    for(int stripe=0;stripe<4;++stripe) {
        const auto *p=frame->data[0]+120*frame->linesize[0]+(stripe*160+80)*4;
        bands.append(QJsonArray{p[2],p[1],p[0],p[3]});
    }
    std::lock_guard lock(record.mutex);
    auto &samples=phase==1?record.black:record.white;
    QJsonObject sample{{"identity",identity},{"bands",bands},{"segment",record.segment},
        {"timestamp",QString::number(frame->timestamp)},{"width",640},{"height",360}};
    if(record.edges) {
        QJsonArray edge;
        for(int x=4;x<640;x+=8){const auto *p=frame->data[0]+270*frame->linesize[0]+x*4;
            edge.append(QJsonArray{p[2],p[1],p[0],p[3]});}
        sample["edge"]=edge;
    }
    if(record.geometries)sample["geometries"]=geometrySamples(frame->data[0],frame->linesize[0],640,360);
    if(samples.size()<record.limit)samples.append(sample);
}

int main(int argc,char **argv) {
    if(argc!=6 && !(argc==7 && (QByteArray(argv[6])=="--controlled"||QByteArray(argv[6])=="--geometry"))) { fprintf(stderr,"Usage: receiver OBS_APP PLUGIN_BINARY PLUGIN_DATA STREAM OUTPUT_DIR [--controlled|--geometry]\n"); return 2; }
    const bool controlled=argc==7;
    const bool geometries=controlled&&QByteArray(argv[6])=="--geometry";
    const QString obsApp=QString::fromUtf8(argv[1]),out=QString::fromUtf8(argv[5]);
    QCoreApplication::setLibraryPaths({obsApp+"/Contents/PlugIns"});
    QApplication app(argc,argv);app.setQuitOnLastWindowClosed(false);
    QSettings::setDefaultFormat(QSettings::IniFormat);
    QSettings::setPath(QSettings::IniFormat,QSettings::UserScope,out+"/settings");
    QSettings::setPath(QSettings::IniFormat,QSettings::SystemScope,out+"/settings");
    QDir().mkpath(out);
    const auto moduleConfig=(out+"/modules").toUtf8();
    if(!obs_startup("en-US",moduleConfig.constData(),nullptr))return 3;
    obs_add_data_path((obsApp+"/Contents/Frameworks/libobs.framework/Resources").toUtf8().constData());
    obs_video_info video{};
    const auto graphics=(obsApp+"/Contents/Frameworks/libobs-opengl.dylib").toUtf8();
    video.graphics_module=graphics.constData();video.fps_num=30;video.fps_den=1;
    video.base_width=video.output_width=640;video.base_height=video.output_height=360;
    video.output_format=VIDEO_FORMAT_BGRA;video.colorspace=VIDEO_CS_709;video.range=VIDEO_RANGE_FULL;
    video.scale_type=OBS_SCALE_BILINEAR;
    const int reset=obs_reset_video(&video);
    if(reset!=OBS_VIDEO_SUCCESS){fprintf(stderr,"OBS video init failed: %d\n",reset);obs_shutdown();return 3;}
    obs_module_t *module=nullptr;
    if(obs_open_module(&module,argv[2],argv[3])!=MODULE_SUCCESS||!obs_init_module(module)){
        fprintf(stderr,"OBS plugin load failed\n");obs_shutdown();return 3;
    }
    obs_post_load_modules();
    auto *settings=obs_data_create();
    obs_data_set_string(settings,"stream_id",argv[4]);obs_data_set_string(settings,"password","false");
    obs_data_set_bool(settings,"use_native_receiver",true);
    obs_data_set_bool(settings,"internal_native_receiver_source",true);
    obs_data_set_int(settings,"width",640);obs_data_set_int(settings,"height",360);
    auto *source=obs_source_create_private("vdoninja_native_source_internal","Owned native alpha receiver",settings);
    obs_data_release(settings);
    if(!source){obs_shutdown();return 3;}
    obs_source_inc_showing(source);obs_source_inc_active(source);
    QJsonArray samples;QJsonObject result{{"scope","Installed OBS/plugin native decoded BGRA and actual libobs scene composition; frontend excluded"},
        {"obsVersion",QString::fromUtf8(obs_get_version_string())},{"plugin",QString::fromUtf8(argv[2])}};
    uint64_t lastTimestamp=0;int saved=0;
    QString segment="warmup";
    QTimer poll;
    QObject::connect(&poll,&QTimer::timeout,&app,[&] {
        auto *frame=obs_source_get_frame(source);if(!frame)return;
        if(frame->format==VIDEO_FORMAT_BGRA&&((frame->width==640&&frame->height==360)||(controlled&&frame->width>=320&&frame->width<=1920&&frame->height>=180&&frame->height<=1080))&&frame->timestamp!=lastTimestamp&&samples.size()<(controlled?5400:1800)) {
            lastTimestamp=frame->timestamp;
            auto pixel=[&](int x,int y) { const auto *p=frame->data[0]+(y*frame->height/360)*frame->linesize[0]+(x*frame->width/640)*4;
                return QJsonArray{p[2],p[1],p[0],p[3]}; };
            int identity=0;
            for(int bit=0;bit<16;++bit) {
                const auto p=pixel(bit*40+20,22);
                if(p[0].toInt()+p[1].toInt()+p[2].toInt()>384)identity|=1<<bit;
            }
            QJsonArray bands,edge;
            for(int stripe=0;stripe<4;++stripe)bands.append(pixel(stripe*160+80,120));
            for(int x=4;x<640;x+=8)edge.append(pixel(x,270));
            QJsonObject sample{{"segment",segment},{"width",int(frame->width)},{"height",int(frame->height)},{"timestamp",QString::number(frame->timestamp)},{"identity",identity},{"bands",bands},{"edge",edge}};
            if(geometries)sample["geometries"]=geometrySamples(frame->data[0],frame->linesize[0],int(frame->width),int(frame->height));
            samples.append(sample);
            if(saved<12&&samples.size()%15==0) {
                QImage image(frame->data[0],frame->width,frame->height,frame->linesize[0],QImage::Format_ARGB32);
                image.save(out+QString("/paired-%1.png").arg(saved++,2,10,QChar('0')));
            }
        }
        obs_source_release_frame(source,frame);
    });poll.start(10);
    // After observing the native output directly, let the actual OBS renderer
    // consume it in a scene over black, then white. Only fixture sources exist.
    CompositionSamples composition;
    composition.edges=controlled;composition.limit=controlled?5400:600;
    composition.geometries=geometries;
    obs_scene_t *scene=nullptr;obs_source_t *background=nullptr;
    obs_source_info backgroundInfo{};
    backgroundInfo.id="owned_alpha_background";backgroundInfo.type=OBS_SOURCE_TYPE_INPUT;
    backgroundInfo.output_flags=OBS_SOURCE_VIDEO|OBS_SOURCE_CUSTOM_DRAW;
    backgroundInfo.get_name=[](void *){return "Owned alpha background";};
    backgroundInfo.create=[](obs_data_t *,obs_source_t *)->void *{return new std::atomic<bool>(false);};
    backgroundInfo.destroy=[](void *p){delete static_cast<std::atomic<bool> *>(p);};
    backgroundInfo.get_width=[](void *)->uint32_t{return 640;};
    backgroundInfo.get_height=[](void *)->uint32_t{return 360;};
    backgroundInfo.update=[](void *p,obs_data_t *s){*static_cast<std::atomic<bool> *>(p)=obs_data_get_bool(s,"white");};
    backgroundInfo.video_render=[](void *p,gs_effect_t *){
        const float c=static_cast<std::atomic<bool> *>(p)->load()?1.f:0.f;
        vec4 color;vec4_set(&color,c,c,c,1.f);gs_clear(GS_CLEAR_COLOR,&color,0.f,0);
    };
    obs_register_source(&backgroundInfo);
    auto beginComposition=[&]{
        poll.stop();background=obs_source_create_private("owned_alpha_background","Owned black/white background",nullptr);
        scene=obs_scene_create_private("Owned alpha composition");
        if(!background||!scene){app.exit(5);return;}
        obs_scene_add(scene,background);obs_scene_add(scene,source);
        video_scale_info conversion{};conversion.format=VIDEO_FORMAT_BGRA;conversion.width=640;conversion.height=360;
        conversion.colorspace=VIDEO_CS_709;conversion.range=VIDEO_RANGE_FULL;
        obs_add_raw_video_callback(&conversion,composed,&composition);
        obs_set_output_source(0,obs_scene_get_source(scene));
    };
    if(!controlled) {
    QTimer::singleShot(14000,&app,beginComposition);
    QTimer::singleShot(15000,&app,[&]{composition.phase=1;});
    QTimer::singleShot(19000,&app,[&]{
        composition.phase=0;if(!background)return;
        auto *settings=obs_data_create();obs_data_set_bool(settings,"white",true);obs_source_update(background,settings);obs_data_release(settings);
    });
    QTimer::singleShot(20000,&app,[&]{composition.phase=2;});
    }
    bool snapshotFailed=false;
    auto snapshot=[&](const QString &label) -> bool {
        result["samples"]=samples;result["sampleCount"]=samples.size();
        result["sourceCreations"]=1;result["controlled"]=controlled;
        {std::lock_guard lock(composition.mutex);result["blackComposition"]=composition.black;result["whiteComposition"]=composition.white;}
        const auto bytes=QJsonDocument(result).toJson(QJsonDocument::Compact);
        QSaveFile file(out+"/"+label+".json");
        const char *stage="open";
        bool ok=file.open(QIODevice::WriteOnly);
        if(ok){stage="write";ok=file.write(bytes)==bytes.size();}
        if(ok){stage="commit";ok=file.commit();}
        if(!ok){snapshotFailed=true;fprintf(stderr,"SNAPSHOT_ERROR %s stage=%s: %s\n",label.toUtf8().constData(),stage,file.errorString().toUtf8().constData());fflush(stderr);}
        return ok;
    };
    QByteArray pending;
    QSocketNotifier input(STDIN_FILENO,QSocketNotifier::Read);
    QObject::connect(&input,&QSocketNotifier::activated,&app,[&] {
        char buffer[512];const auto n=::read(STDIN_FILENO,buffer,sizeof(buffer));
        if(n<=0){app.quit();return;}pending.append(buffer,n);
        for(qsizetype end;(end=pending.indexOf('\n'))>=0;) {
            const auto command=QString::fromUtf8(pending.first(end)).trimmed();pending.remove(0,end+1);
            if(command=="quit"){app.quit();return;}
            if(!controlled)continue;
            const auto fields=command.split(' ');
            if(fields.size()!=2||!QRegularExpression("^[A-Za-z0-9_-]+$").match(fields[1]).hasMatch()){app.exit(6);return;}
            if(fields[0]=="mark"){segment=fields[1];std::lock_guard lock(composition.mutex);composition.segment=segment;}
            else if(fields[0]=="snapshot"){if(!snapshot(fields[1])){app.exit(4);return;}}
            else if(fields[0]=="compose"&&(fields[1]=="black"||fields[1]=="white")) {
                if(!scene)beginComposition();
                composition.phase=0;if(!background)return;
                auto *settings=obs_data_create();obs_data_set_bool(settings,"white",fields[1]=="white");
                obs_source_update(background,settings);obs_data_release(settings);
                const int phase=fields[1]=="black"?1:2;
                QTimer::singleShot(500,&app,[&,phase]{composition.phase=phase;});
            } else {app.exit(6);return;}
            printf("ACK %s\n",command.toUtf8().constData());fflush(stdout);
        }
    });
    QTimer::singleShot(controlled?180000:90000,&app,&QCoreApplication::quit);
    puts("RECEIVER_READY");fflush(stdout);
    const auto code=app.exec();poll.stop();
    composition.phase=0;
    if(scene) {
        obs_remove_raw_video_callback(composed,&composition);obs_set_output_source(0,nullptr);
        obs_scene_release(scene);
    }
    if(background)obs_source_release(background);
    obs_source_dec_active(source);obs_source_dec_showing(source);obs_source_release(source);
    obs_shutdown();
    if(!snapshot("received"))return 4;
    // EOF can queue quit() after an IO error queued exit(4). Preserve the error
    // independently of the event loop's final exit code.
    return snapshotFailed?4:code;
}
