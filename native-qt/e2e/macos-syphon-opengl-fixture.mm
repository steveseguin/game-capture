// Owned, windowless OpenGL rectangle-texture sender. No capture devices or desktop access.
// Uses the upstream OpenGL API through a separately built framework; the app receives with Metal.
// Same deterministic pixel contract as the Metal fixture, including paired row/flag reversal.
#define GL_SILENCE_DEPRECATION
#import <AppKit/AppKit.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl.h>
#import <Syphon/Syphon.h>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <poll.h>
#include <string>
#include <unistd.h>
#include <vector>

int main(int argc, char **argv) { @autoreleasepool {
    if (argc < 2 || argc > 4) return 2;
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    CGLPixelFormatAttribute attributes[] = {kCGLPFAAccelerated, CGLPixelFormatAttribute(0)};
    CGLPixelFormatObj format = nullptr; GLint count = 0;
    CGLContextObj context = nullptr;
    if (CGLChoosePixelFormat(attributes, &format, &count) != kCGLNoError || !format) return 3;
    const auto status = CGLCreateContext(format, nullptr, &context);
    CGLDestroyPixelFormat(format);
    if (status != kCGLNoError || !context || CGLSetCurrentContext(context) != kCGLNoError) return 3;
    const auto renderer = [NSString stringWithUTF8String:reinterpret_cast<const char *>(glGetString(GL_RENDERER))];
    NSString *name = [NSString stringWithUTF8String:argv[1]];
    SyphonOpenGLServer *server = nil;
    auto create = [&] {
        server = [[SyphonOpenGLServer alloc] initWithName:name context:context options:nil];
        if (!server) return false;
        NSDictionary *description = server.serverDescription;
        NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"uuid":description[SyphonServerDescriptionUUIDKey],
            @"name":name,@"pid":@(getpid()),@"api":@"SyphonOpenGLServer",
            @"textureTarget":@"GL_TEXTURE_RECTANGLE_ARB",@"renderer":renderer ?: @"unknown"} options:0 error:nil];
        fwrite(json.bytes,1,json.length,stdout);printf("\n");fflush(stdout);return true;
    };
    if (!create()) return 3;
    int width=640,height=360; unsigned identity=0; uint64_t publishedFrames=0;
    bool running=true,paused=false;
    const bool initialPremultiplied=argc>2&&std::string(argv[2])=="premultiplied";
    bool premultiplied=initialPremultiplied,flipped=argc>3&&std::string(argv[3])=="flipped";
    GLuint texture=0;
    std::vector<uint8_t> pixels;
    std::string pending;
    auto due=std::chrono::steady_clock::now();
    while (running) { @autoreleasepool {
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.002]];
        pollfd input{STDIN_FILENO,POLLIN,0};
        if (poll(&input,1,0)>0) {
            char bytes[512];const auto count=read(STDIN_FILENO,bytes,sizeof(bytes));
            if (count<=0) break;
            pending.append(bytes,size_t(count));
            for (size_t end;(end=pending.find('\n'))!=std::string::npos;) {
                const auto command=pending.substr(0,end);pending.erase(0,end+1);
                if(command=="quit")running=false;
                else if(command=="pause")paused=true;
                else if(command=="resume")paused=false;
                else if(command=="premultiplied")premultiplied=true;
                else if(command=="straight")premultiplied=false;
                else if(command=="flipped")flipped=true;
                else if(command=="normal")flipped=false;
                else if(command=="state") {
                    const auto time=std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
                    printf("{\"publishedFrames\":%llu,\"identity\":%u,\"time\":%.9f,\"width\":%d,\"height\":%d,\"paused\":%s}\n",
                        static_cast<unsigned long long>(publishedFrames),identity,time,width,height,paused?"true":"false");fflush(stdout);
                }
                else if(command=="retire"){[server stop];server=nil;}
                else if(command=="restart"){[server stop];server=nil;if(!create())return 3;}
                else if(command.starts_with("resize ")) {
                    int w=0,h=0;
                    if(sscanf(command.c_str(),"resize %d %d",&w,&h)==2&&w>=320&&w<=1920&&h>=180&&h<=1080&&w%16==0&&h%8==0){width=w;height=h;if(texture)glDeleteTextures(1,&texture);texture=0;}
                }
            }
        }
        const auto now=std::chrono::steady_clock::now();
        if(!server||paused||now<due)continue;
        // Keep the 60 Hz clock phase instead of accumulating Cocoa run-loop
        // wakeup lateness on every frame. Skip missed slots after a pause or
        // overload; never publish a backlog to compensate.
        const auto interval=std::chrono::nanoseconds(1000000000LL/60);
        due+=interval;if(due<=now)due=now+interval;
        identity=(identity+1)&65535;
        if(!texture){
            glGenTextures(1, &texture);
            glBindTexture(GL_TEXTURE_RECTANGLE_ARB, texture);
            glTexParameteri(GL_TEXTURE_RECTANGLE_ARB, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_RECTANGLE_ARB, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_RECTANGLE_ARB, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_RECTANGLE_ARB, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(GL_TEXTURE_RECTANGLE_ARB, 0, GL_RGBA8, width, height, 0, GL_BGRA, GL_UNSIGNED_BYTE, nullptr);
            if (!texture || glGetError() != GL_NO_ERROR) return 3;
            pixels.resize(size_t(width)*height*4);
        }
        const int left=identity*9%(width-80);
        for(int y=0;y<height;++y)for(int x=0;x<width;++x){
            unsigned r=240,g=60,b=30,a=(x/(width/4))*85;
            if(y<height/8){r=g=b=(identity>>(x/(width/16)))&1?255:0;a=255;}
            else if(y>=height/2&&x>=left&&x<left+80){r=30;g=90;b=240;a=170;}
            if(premultiplied){r=(r*a+127)/255;g=(g*a+127)/255;b=(b*a+127)/255;}
            const auto index=(size_t(flipped?height-y-1:y)*width+x)*4;
            pixels[index]=b;pixels[index+1]=g;pixels[index+2]=r;pixels[index+3]=a;
        }
        glBindTexture(GL_TEXTURE_RECTANGLE_ARB, texture);
        glTexSubImage2D(GL_TEXTURE_RECTANGLE_ARB, 0, 0, 0, width, height, GL_BGRA, GL_UNSIGNED_BYTE, pixels.data());
        [server publishFrameTexture:texture textureTarget:GL_TEXTURE_RECTANGLE_ARB
            imageRegion:NSMakeRect(0,0,width,height) textureDimensions:NSMakeSize(width,height) flipped:flipped];
        glFinish();
        if (glGetError() != GL_NO_ERROR) return 4;
        ++publishedFrames;
    }}
    [server stop];server=nil;
    if(texture)glDeleteTextures(1,&texture);
    CGLSetCurrentContext(nullptr);CGLDestroyContext(context);return 0;
}}
