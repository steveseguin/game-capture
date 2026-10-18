// Native deterministic picture/timing experiment, not packaged application testing.
// All modes encode identical pixels; source identities advance on a 60 fps clock.
// The Qt-drawn fixture approximates the live layout, not a replay of its pixels.
#include "versus/platform/macos_fitted_rows.h"
#include "versus/platform/macos_i420.h"
#include <QColor>
#include <cstdint>
extern "C" {
#include <x264.h>
}
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

int main(int argc, char **argv) try {
    if (argc != 3 || (std::string(argv[1]) != "cfr60" && std::string(argv[1]) != "vfr60" && std::string(argv[1]) != "cfr20"))
        throw std::runtime_error("Use cfr60|vfr60|cfr20 NEW_OUTPUT_DIRECTORY");
    const bool vfr = std::string(argv[1]) == "vfr60";
    const std::filesystem::path directory(argv[2]);
    if (!std::filesystem::create_directory(directory)) throw std::runtime_error("Use a new directory");
    constexpr int width=3840, height=2160, count=420;
    x264_param_t p;
    if (x264_param_default_preset(&p,"veryfast","zerolatency") < 0) throw std::runtime_error("Preset");
    p.i_width=width; p.i_height=height; p.i_csp=X264_CSP_I420;
    p.i_fps_num=std::string(argv[1])=="cfr20"?20:60; p.i_fps_den=1; p.i_timebase_num=1; p.i_timebase_den=10000000;
    p.b_vfr_input=vfr; p.i_bframe=0;
    p.i_threads=static_cast<int>(std::clamp(std::thread::hardware_concurrency()/2,1u,4u));
    p.i_keyint_max=60; p.i_keyint_min=1; p.b_repeat_headers=1; p.b_annexb=1;
    p.rc.i_rc_method=X264_RC_ABR; p.rc.i_bitrate=4000;
    p.rc.i_vbv_max_bitrate=4000; p.rc.i_vbv_buffer_size=2000;
    p.analyse.b_psnr=1; p.analyse.b_ssim=1; p.b_full_recon=1;
    p.vui.b_fullrange=0; p.vui.i_colorprim=1; p.vui.i_transfer=13; p.vui.i_colmatrix=6;
    p.i_log_level=X264_LOG_INFO; // x264 disables PSNR/SSIM below INFO
    if (x264_param_apply_profile(&p,"baseline") < 0) throw std::runtime_error("Profile");
    x264_t *encoder=x264_encoder_open(&p);
    if (!encoder) throw std::runtime_error("Encoder initialization");
    x264_param_t actual; x264_encoder_parameters(encoder,&actual);
    if(!actual.analyse.b_psnr||!actual.analyse.b_ssim)throw std::runtime_error("Quality metrics disabled");
    const int maximumDelay=x264_encoder_maximum_delayed_frames(encoder);
    std::vector<int64_t> clock(count),pts(count);
    std::vector<int> identities(count);
    int64_t now=1000000000;
    for (int i=0;i<count;++i) {
        clock[i]=now; pts[i]=vfr?now:i;
        identities[i]=(4400+(now-1000000000)*60/10000000)%65536;
        now += i>=120 && i<300 ? 500000 : 166667;
    }
    std::ofstream csv(directory/"packets.csv"),bitstream(directory/"video.h264",std::ios::binary);
    csv << "submitted,source_index,source_time_100ns,encoder_pts,bytes,keyframe,qp,slices,identity,psnr_avg,psnr_y,ssim\n";
    std::vector<uint8_t> pixels(width*height*3/2);
    std::fill(pixels.begin()+width*height,pixels.begin()+width*height*5/4,96);
    std::fill(pixels.begin()+width*height*5/4,pixels.end(),160);
    int packets=0,warmup=0;
    auto encode=[&](x264_picture_t *input,int submitted) {
        x264_nal_t *nals=nullptr;int n=0;x264_picture_t output;x264_picture_init(&output);
        const int bytes=x264_encoder_encode(encoder,&nals,&n,input,&output);
        if(bytes<0)throw std::runtime_error("Encode failure");
        if(!bytes) {++warmup;return;}
        auto it=std::lower_bound(pts.begin(),pts.end(),output.i_pts);
        if(it==pts.end()||*it!=output.i_pts||it-pts.begin()!=packets)
            throw std::runtime_error("Output identity/order mismatch");
        if(output.i_type==X264_TYPE_B||output.i_type==X264_TYPE_BREF)
            throw std::runtime_error("Unexpected B-frame");
        if(!(output.prop.f_psnr[0]>0)||!(output.prop.f_ssim>0))throw std::runtime_error("Missing reconstruction metrics");
        const auto index=it-pts.begin();int slices=0;
        for(int j=0;j<n;++j) {
            bitstream.write(reinterpret_cast<const char *>(nals[j].p_payload),nals[j].i_payload);
            slices+=nals[j].i_type==NAL_SLICE||nals[j].i_type==NAL_SLICE_IDR;
        }
        csv << submitted << ',' << index << ',' << clock[index] << ',' << output.i_pts << ','
            << bytes << ',' << output.b_keyframe << ',' << output.i_qpplus1-1 << ',' << slices << ','
            << identities[index] << ',' << output.prop.f_psnr_avg << ',' << output.prop.f_psnr[0] << ',' << output.prop.f_ssim << '\n';
        ++packets;
    };
    for(int i=0;i<count;++i) {
        versus::video::CapturedFrame frame;
        frame.width=1280;frame.height=800;frame.stride=frame.width*4;
        frame.data.resize(static_cast<size_t>(frame.stride)*frame.height);
        QImage image(frame.data.data(),frame.width,frame.height,frame.stride,QImage::Format_RGB32);
        image.fill(QColor(24,48,66));
        {
            QPainter painter(&image);
            painter.translate(0,80); // fixed synthetic browser header
            constexpr int w=1280,h=720;
            const int id=identities[i],shift=id*3%64;
            for(int y=-32;y<h+32;y+=32)for(int x=-64;x<w+64;x+=32) {
                const bool light=((x/32+y/32)%2+2)%2;
                painter.fillRect(x+shift,y+(id%32),30,30,light?QColor(144,128,96):QColor(48,64,80));
            }
            painter.fillRect(QRectF(.1*w,.25*h,.05*w,.5*h),Qt::cyan);
            painter.fillRect(QRectF(.85*w,.25*h,.05*w,.5*h),Qt::magenta);
            for(int bit=0;bit<16;++bit)
                painter.fillRect(QRectF((.2+bit*.6/16)*w,.25*h,.6/16*w,.5*h),
                    (id&(1<<bit))?Qt::white:Qt::black);
        }
        if(!versus::platform::detail::withFittedBgraRows(frame,width,height,
            [&](const uint8_t *a,const uint8_t *b,int y) {
                versus::platform::detail::bgraRowsToI420(a,b,width,
                    pixels.data()+y*width,pixels.data()+(y+1)*width,
                    pixels.data()+width*height+y*width/4,
                    pixels.data()+width*height*5/4+y*width/4);
            }))throw std::runtime_error("Fixture conversion");
        x264_picture_t input;x264_picture_init(&input);
        input.img.i_csp=X264_CSP_I420;input.img.i_plane=3;
        input.img.plane[0]=pixels.data();input.img.plane[1]=pixels.data()+width*height;
        input.img.plane[2]=pixels.data()+width*height*5/4;
        input.img.i_stride[0]=width;input.img.i_stride[1]=input.img.i_stride[2]=width/2;
        input.i_pts=pts[i];input.i_type=i==0?X264_TYPE_IDR:X264_TYPE_AUTO;
        encode(&input,i);
    }
    int drained=0;
    while(x264_encoder_delayed_frames(encoder)) {
        if(++drained>2)throw std::runtime_error("Unbounded output drain");
        encode(nullptr,count);
    }
    x264_encoder_close(encoder);
    if(packets!=count)throw std::runtime_error("Missing packets");
    if(!csv||!bitstream)throw std::runtime_error("Evidence write failed");
    std::cout << "{\"mode\":\"" << argv[1] << "\",\"packets\":" << packets
        << ",\"warmupWithoutOutput\":" << warmup << ",\"maximumDelayFrames\":" << maximumDelay
        << ",\"drainedFrames\":" << drained << ",\"threads\":" << p.i_threads << "}\n";
    return 0;
} catch(const std::exception &e) {std::cerr << e.what() << '\n';return 1;}
