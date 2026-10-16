// Owned native transparent window; no camera, microphone, desktop or system settings.
#include <chrono>
#include <poll.h>
#include <QJsonDocument>
#include <QJsonObject>
#include <algorithm>
#include <cstdio>
#include <unistd.h>
#import <AppKit/AppKit.h>

@interface GCAlphaFixtureView : NSView
@property unsigned identity;
@property unsigned paintedIdentity;
@property unsigned paintCount;
@end
@implementation GCAlphaFixtureView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty; self.paintedIdentity=self.identity; ++_paintCount;
    const int width=self.bounds.size.width, height=self.bounds.size.height;
    // Copy straight sRGB colors into an alpha-bearing window surface. AppKit
    // owns the surface's premultiplication; capture must recover straight BGRA.
    for(int stripe=0;stripe<4;++stripe) {
        [[NSColor colorWithSRGBRed:240./255 green:60./255 blue:30./255 alpha:stripe/3.] setFill];
        NSRectFillUsingOperation(NSMakeRect(stripe*width/4,0,width/4,height),NSCompositingOperationCopy);
    }
    for(int bit=0;bit<16;++bit) {
        [((self.identity>>bit)&1 ? NSColor.whiteColor : NSColor.blackColor) setFill];
        NSRectFillUsingOperation(NSMakeRect(bit*width/16,0,width/16,height/8),NSCompositingOperationCopy);
    }
    const int left=(self.identity*9)%std::max(1,width-80);
    [[NSColor colorWithSRGBRed:30./255 green:90./255 blue:240./255 alpha:2./3] setFill];
    NSRectFillUsingOperation(NSMakeRect(left,height/2,80,height/2),NSCompositingOperationCopy);
}
@end

int main(int argc,char **argv) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
    }
    if(argc<2||argc>4) { fprintf(stderr,"Usage: macos-alpha-fixture UNIQUE_WINDOW_TITLE [INITIAL_ID [FPS]]\n"); return 2; }
    bool validInitial=true;
    const unsigned initial=argc>=3?QByteArray(argv[2]).toUInt(&validInitial):0;
    if(!validInitial||initial>50000) { fprintf(stderr,"INITIAL_ID must be 0..50000\n"); return 2; }
    bool validFps=true;
    const unsigned fps=argc==4?QByteArray(argv[3]).toUInt(&validFps):0;
    if(argc==4&&(!validFps||fps<1||fps>120)) { fprintf(stderr,"FPS must be 1..120\n"); return 2; }
    const auto frameInterval=std::chrono::nanoseconds(fps?1000000000LL/fps:33000000LL);
    NSWindow *window = nil;
    NSWindow *cover = nil;
    GCAlphaFixtureView *view = nil;
    @autoreleasepool {
        window=[[NSWindow alloc] initWithContentRect:NSMakeRect(80,80,640,360)
            styleMask:NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed=NO;
        window.opaque=NO; window.hasShadow=NO; window.backgroundColor=NSColor.clearColor;
        window.colorSpace=NSColorSpace.sRGBColorSpace;
        window.title=[NSString stringWithUTF8String:argv[1]];
        view=[[GCAlphaFixtureView alloc] initWithFrame:NSMakeRect(0,0,640,360)];
        view.identity=initial;
        window.contentView=view; [window orderFrontRegardless];
        const auto ready=QJsonDocument(QJsonObject{{"windowId",int(window.windowNumber)},
            {"pid",int(getpid())},{"width",640},{"height",360}}).toJson(QJsonDocument::Compact);
        printf("%s\n",ready.constData());fflush(stdout);
    }
    bool paused=false, destroyed=false, running=true;
    auto nextFrame=std::chrono::steady_clock::now();
    QByteArray pending;
    while(running) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.005]];
            while(NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
                inMode:NSDefaultRunLoopMode dequeue:YES]) [NSApp sendEvent:event];
            const auto now=std::chrono::steady_clock::now();
            if(now>=nextFrame) {
                // Keep the existing fixture cadence unless FPS was explicitly
                // requested. Advance a deadline without drawing catch-up bursts.
                if(fps) { do { nextFrame+=frameInterval; } while(nextFrame<=now); }
                else nextFrame=now+frameInterval;
                if(window&&!paused){++view.identity;[view setNeedsDisplay:YES];}
            }
            [NSApp updateWindows];
            if(window.visible&&!window.miniaturized) [view displayIfNeeded];
            pollfd input{STDIN_FILENO,POLLIN,0};
            if(poll(&input,1,0)<=0) continue;
            char buffer[512];const auto count=::read(STDIN_FILENO,buffer,sizeof(buffer));
            if(count<=0){running=false;continue;}pending.append(buffer,count);
            for(qsizetype end;(end=pending.indexOf('\n'))>=0;) {
                const auto line=pending.first(end).trimmed();pending.remove(0,end+1);
                if(line=="quit") running=false;
                else if(line=="pause") paused=true;
                else if(line=="resume") paused=false;
                else if(line=="raise") [window orderFrontRegardless];
                else if(line=="minimize") [window miniaturize:nil];
                else if(line=="hide") [window orderOut:nil];
                else if(line=="cover"&&window) {
                    if(!cover) {
                        cover=[[NSWindow alloc] initWithContentRect:window.frame
                            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
                        cover.releasedWhenClosed=NO;cover.opaque=YES;cover.hasShadow=NO;
                        cover.backgroundColor=NSColor.magentaColor;
                        cover.title=[window.title stringByAppendingString:@" cover"];
                        cover.level=window.level+1;
                    }
                    [cover setFrame:window.frame display:YES];[cover orderFrontRegardless];
                }
                else if(line=="uncover") [cover orderOut:nil];
                else if(line=="destroy-window") {
                    [cover orderOut:nil];
                    window.contentView=nil; [window close]; window=nil;
                    destroyed=true;
                }
                else if(line=="restore") {
                    [window deminiaturize:nil]; [window orderFrontRegardless]; [view setNeedsDisplay:YES];
                }
                else if(line=="state") {
                    // Record only our two windows, never other applications'
                    // window names or pixels. Quartz's list is front-to-back.
                    int sourceOrder=-1,coverOrder=-1,index=0;
                    NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly,kCGNullWindowID));
                    for(NSDictionary *entry in windows) {
                        if([entry[(id)kCGWindowOwnerPID] intValue]==getpid()) {
                            const auto number=[entry[(id)kCGWindowNumber] integerValue];
                            if(window&&number==window.windowNumber)sourceOrder=index;
                            if(cover&&number==cover.windowNumber)coverOrder=index;
                        }
                        ++index;
                    }
                    const double sampledAt=std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
                    const auto state=QJsonDocument(QJsonObject{{"state",true},{"destroyed",destroyed},{"monotonicSeconds",sampledAt},
                        {"miniaturized",bool(window.miniaturized)},{"visible",bool(window.visible)},
                        {"occlusionVisible",bool(window.occlusionState&NSWindowOcclusionStateVisible)},
                        {"coverVisible",bool(cover.visible)},{"coverWindowId",int(cover.windowNumber)},
                        {"coverOpaque",bool(cover.opaque&&cover.alphaValue==1)},
                        {"coverContainsSource",bool(window&&cover&&NSContainsRect(cover.frame,window.frame))},
                        {"coverAboveSource",coverOrder>=0&&sourceOrder>=0&&coverOrder<sourceOrder},
                        {"windowId",int(window.windowNumber)},{"identity",int(view.identity)},
                        {"paintedIdentity",int(view.paintedIdentity)},{"paintCount",int(view.paintCount)}}).toJson(QJsonDocument::Compact);
                    printf("%s\n",state.constData());fflush(stdout);
                }
                else if(line.startsWith("resize ")&&window) {
                    const auto fields=line.split(' ');
                    if(fields.size()==3) {const int w=fields[1].toInt(),h=fields[2].toInt();
                        if(w>=320&&w<=1920&&h>=180&&h<=1080&&!(w%16)&&!(h%8)) {
                            [window setContentSize:NSMakeSize(w,h)];[view setNeedsDisplay:YES];
                        }
                    }
                }
            }
        }
    }
    const auto final=QJsonDocument(QJsonObject{{"identity",int(view.identity)},
        {"paintedIdentity",int(view.paintedIdentity)},{"paintCount",int(view.paintCount)}}).toJson(QJsonDocument::Compact);
    printf("%s\n",final.constData());fflush(stdout);
    @autoreleasepool { [cover close];cover=nil;window.contentView=nil;[window close];window=nil;view=nil; }
    return 0;
}
