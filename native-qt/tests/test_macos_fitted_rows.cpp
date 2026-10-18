// Pixel/layout gate against the previous full-image Qt preparation path.
// Real packaged capture and playback workflows are required separately.
#include "versus/platform/macos_fitted_rows.h"
#include "versus/platform/macos_i420.h"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <random>

using versus::video::CapturedFrame;
namespace detail = versus::platform::detail;
static void require(bool condition) { if (!condition) std::abort(); }

int main() {
    std::mt19937 random(0x4e563132);
    std::vector<std::array<int,4>> cases={
        {1,2,2,2},{2,1,2,2},{38,24,38,24},{38,24,40,24},{38,24,38,26},
        {37,24,38,24},{38,23,38,24},{37,23,38,24},{128,72,64,64},
        {3462,2160,3840,2160},{1920,930,1920,1080},{1080,1920,1920,1080},
        {1280,720,3840,2160},{3840,2160,1280,720}};
    for(int i=0;i<200;++i)cases.push_back({1+int(random()%130),1+int(random()%130),
        2+2*int(random()%90),2+2*int(random()%90)});
    for(const auto &c:cases) {
        const int w=c[2],h=c[3];
        CapturedFrame input;input.width=c[0];input.height=c[1];input.stride=input.width*4+int(random()%17);
        input.format=CapturedFrame::Format::BGRA;input.data.resize(static_cast<size_t>(input.stride)*input.height);
        for(auto &b:input.data)b=random()&255;
        QImage source(input.data.data(),input.width,input.height,input.stride,QImage::Format_RGB32);
        QImage old(w,h,QImage::Format_RGB32);old.fill(Qt::black);
        const auto fit=versus::video::computeAspectFitRect(input.width,input.height,w,h);
        { QPainter painter(&old);painter.drawImage(QRect(fit.x,fit.y,fit.width,fit.height),source); }
        // Unequal native plane strides and guard regions expose row overflows.
        const int ys=w+17,uvs=w+23;
        std::vector<uint8_t> expectedY(ys*h+32,0xcd),actualY=expectedY;
        std::vector<uint8_t> expectedUV(uvs*h/2+32,0xcd),actualUV=expectedUV;
        std::vector<uint8_t> u(w/2),v(w/2);
        for(int y=0;y<h;y+=2) {
            detail::bgraRowsToI420(old.constScanLine(y),old.constScanLine(y+1),w,
                expectedY.data()+16+y*ys,expectedY.data()+16+(y+1)*ys,u.data(),v.data());
            for(int x=0;x<w/2;++x) {
                expectedUV[16+(y/2)*uvs+2*x]=u[x];expectedUV[17+(y/2)*uvs+2*x]=v[x];
            }
        }
        require(detail::withFittedBgraRows(input,w,h,[&](const uint8_t *a,const uint8_t *b,int y) {
            detail::bgraRowsToNV12(a,b,w,actualY.data()+16+y*ys,actualY.data()+16+(y+1)*ys,actualUV.data()+16+(y/2)*uvs);
        }));
        if(expectedY!=actualY||expectedUV!=actualUV) {
            std::fprintf(stderr,"Fitted NV12 mismatch: %dx%d -> %dx%d\n",c[0],c[1],w,h);return 1;
        }
        // The same row visitor also supplies the software I420 encoder.
        std::fill(actualY.begin(),actualY.end(),0xcd);
        std::vector<uint8_t> planar(static_cast<size_t>(w)*h/2);
        require(detail::withFittedBgraRows(input,w,h,[&](const uint8_t *a,const uint8_t *b,int y) {
            detail::bgraRowsToI420(a,b,w,actualY.data()+16+y*ys,actualY.data()+16+(y+1)*ys,
                planar.data()+y*w/4,planar.data()+w*h/4+y*w/4);
        }));
        require(actualY==expectedY);
        for(int y=0;y<h/2;++y)for(int x=0;x<w/2;++x) {
            require(planar[y*w/2+x]==expectedUV[16+y*uvs+2*x]);
            require(planar[w*h/4+y*w/2+x]==expectedUV[17+y*uvs+2*x]);
        }
    }
    CapturedFrame invalid;int visits=0;
    require(!detail::withFittedBgraRows(invalid,128,72,[&](auto,auto,int){++visits;}));
    require(visits==0);
    std::printf("{\"passed\":true,\"layouts\":%zu,\"scope\":\"pixel/layout gate, not application testing\"}\n",cases.size());
}
