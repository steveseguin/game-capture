// Controlled rate-control/packet-identity gate, not application testing or a
// cross-encoder quality benchmark. Link against the app's pinned x264 library.
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
    if (argc != 3 || (std::string(argv[1]) != "cfr" && std::string(argv[1]) != "vfr"))
        throw std::runtime_error("Use cfr|vfr NEW_OUTPUT_DIRECTORY");
    const bool vfr = std::string(argv[1]) == "vfr";
    const std::filesystem::path directory(argv[2]);
    if (!std::filesystem::create_directory(directory)) throw std::runtime_error("Use a new directory");
    constexpr int width=3840, height=2160, count=420;
    x264_param_t p;
    if (x264_param_default_preset(&p,"veryfast","zerolatency") < 0) throw std::runtime_error("Preset");
    p.i_width=width; p.i_height=height; p.i_csp=X264_CSP_I420;
    p.i_fps_num=60; p.i_fps_den=1; p.i_timebase_num=1; p.i_timebase_den=10000000;
    p.b_vfr_input=vfr; p.i_bframe=0;
    p.i_threads=static_cast<int>(std::clamp(std::thread::hardware_concurrency()/2,1u,4u));
    p.i_keyint_max=60; p.i_keyint_min=1; p.b_repeat_headers=1; p.b_annexb=1;
    p.rc.i_rc_method=X264_RC_ABR; p.rc.i_bitrate=4000;
    p.rc.i_vbv_max_bitrate=6000; p.rc.i_vbv_buffer_size=3000;
    p.vui.b_fullrange=0; p.vui.i_colorprim=1; p.vui.i_transfer=13; p.vui.i_colmatrix=6;
    p.i_log_level=X264_LOG_WARNING;
    if (x264_param_apply_profile(&p,"baseline") < 0) throw std::runtime_error("Profile");
    x264_t *encoder=x264_encoder_open(&p);
    if (!encoder) throw std::runtime_error("Encoder initialization");
    const int maximumDelay=x264_encoder_maximum_delayed_frames(encoder);
    std::vector<int64_t> clock(count),pts(count);
    int64_t now=1000000000;
    for (int i=0;i<count;++i) {
        clock[i]=now; pts[i]=vfr?now:i;
        now += i>=120 && i<300 ? 500000 : 166667;
    }
    std::ofstream csv(directory/"packets.csv"),bitstream(directory/"video.h264",std::ios::binary);
    csv << "submitted,source_index,source_time_100ns,encoder_pts,bytes,keyframe,qp,slices\n";
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
        const auto index=it-pts.begin();int slices=0;
        for(int j=0;j<n;++j) {
            bitstream.write(reinterpret_cast<const char *>(nals[j].p_payload),nals[j].i_payload);
            slices+=nals[j].i_type==NAL_SLICE||nals[j].i_type==NAL_SLICE_IDR;
        }
        csv << submitted << ',' << index << ',' << clock[index] << ',' << output.i_pts << ','
            << bytes << ',' << output.b_keyframe << ',' << output.i_qpplus1-1 << ',' << slices << '\n';
        ++packets;
    };
    for(int i=0;i<count;++i) {
        // Deterministic moving detail and large identity bars. Both modes use
        // exactly the same generated pixels and presentation timeline.
        for(int y=0;y<height;++y) {
            auto *row=pixels.data()+y*width;
            for(int x=0;x<width;x+=32) {
                const int cell=((x+i*3)/32+(y+i)/32)&1;
                std::fill_n(row+x,32,cell?165:65);
            }
            if(y>=height/4&&y<height*3/4)
                for(int bit=0;bit<16;++bit) {
                    const int left=width/5+bit*width*3/80,right=width/5+(bit+1)*width*3/80;
                    std::fill(row+left,row+right,(i&(1<<bit))?235:16);
                }
        }
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
