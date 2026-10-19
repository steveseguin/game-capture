// Owned window and controlled system-pointer positions for capture qualification.
// Only explicit stdin commands move the pointer, within this fixture's window.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <poll.h>
#include <unistd.h>

@interface GCCursorWindow : NSWindow
@end
@implementation GCCursorWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end

@interface GCCursorView : NSView
@property unsigned identity;
@end
@implementation GCCursorView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [NSColor.clearColor setFill];
    NSRectFillUsingOperation(self.bounds, NSCompositingOperationCopy);
    [[NSColor colorWithSRGBRed:240./255 green:60./255 blue:30./255 alpha:1] setFill];
    NSRectFillUsingOperation(NSMakeRect(320,0,320,360), NSCompositingOperationCopy);
    for (unsigned bit=0; bit<16; ++bit) {
        [((self.identity>>bit)&1 ? NSColor.whiteColor : NSColor.blackColor) setFill];
        NSRectFillUsingOperation(NSMakeRect(bit*40,0,40,40), NSCompositingOperationCopy);
    }
    [NSColor.blueColor setFill];
    NSRectFillUsingOperation(NSMakeRect((self.identity*9)%560,240,80,100), NSCompositingOperationCopy);
    // Probe regions contain only clear or solid red pixels.
}
@end

static CGPoint pointerLocation() {
    CGEventRef event=CGEventCreate(nullptr);
    const CGPoint point=CGEventGetLocation(event);
    CFRelease(event);
    return point;
}

static void emit(NSDictionary *object) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    fwrite(data.bytes,1,data.length,stdout);puts("");fflush(stdout);
}

int main(int argc, char **argv) {
    if(argc!=2) {fprintf(stderr,"Usage: macos-cursor-fixture UNIQUE_WINDOW_TITLE\n");return 2;}
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        GCCursorWindow *window=[[GCCursorWindow alloc] initWithContentRect:NSMakeRect(80,80,640,360)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed=NO;window.opaque=NO;window.hasShadow=NO;
        window.backgroundColor=NSColor.clearColor;window.colorSpace=NSColorSpace.sRGBColorSpace;
        window.title=[NSString stringWithUTF8String:argv[1]];
        GCCursorView *view=[[GCCursorView alloc] initWithFrame:NSMakeRect(0,0,640,360)];
        window.contentView=view;
        CGPoint original=pointerLocation();
        CGPoint controlled=original;
        bool moved=false,running=true;
        NSString *mode=@"uncontrolled";
        [window orderFrontRegardless];
        emit(@{@"ready":@YES,@"windowId":@(window.windowNumber),@"pid":@(getpid()),@"width":@640,@"height":@360});
        const auto start=std::chrono::steady_clock::now();
        auto next=start;
        NSMutableData *pending=[NSMutableData data];
        while(running && std::chrono::steady_clock::now()-start<std::chrono::seconds(100)) {
            @autoreleasepool {
                [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.003]];
                while(NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
                    inMode:NSDefaultRunLoopMode dequeue:YES]) [NSApp sendEvent:event];
                const auto now=std::chrono::steady_clock::now();
                if(now>=next) {next=now+std::chrono::milliseconds(33);view.identity=(view.identity+1)&65535;[view setNeedsDisplay:YES];}
                [NSApp updateWindows];[view displayIfNeeded];
                pollfd input{STDIN_FILENO,POLLIN,0};
                if(poll(&input,1,0)<=0)continue;
                char buffer[256];const auto count=read(STDIN_FILENO,buffer,sizeof(buffer));
                if(count<=0)break;
                [pending appendBytes:buffer length:count];
                while(true) {
                    if(!pending.length)break;
                    const auto bytes=static_cast<const char *>(pending.bytes);
                    const auto end=static_cast<const char *>(memchr(bytes,'\n',pending.length));
                    if(!end)break;
                    const NSUInteger length=end-bytes;
                    NSString *command=[[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
                    [pending replaceBytesInRange:NSMakeRange(0,length+1) withBytes:nullptr length:0];
                    if([command isEqualToString:@"quit"]) {running=false;break;}
                    if([@[@"park",@"transparent",@"opaque"] containsObject:command]) {
                        const CGPoint current=pointerLocation();
                        if(!moved)original=current;
                        if(moved && hypot(current.x-controlled.x,current.y-controlled.y)>2) {
                            emit(@{@"error":@"Pointer moved independently; refusing another warp"});running=false;break;
                        }
                        [window orderFrontRegardless];
                        const NSPoint local=[command isEqualToString:@"transparent"]?NSMakePoint(80,90):NSMakePoint(480,90);
                        const NSPoint screen=[window convertPointToScreen:[view convertPoint:local toView:nil]];
                        const NSPoint cocoa=NSEvent.mouseLocation;
                        controlled=CGPointMake(screen.x,current.y+cocoa.y-screen.y);
                        const CGError error=CGWarpMouseCursorPosition(controlled);
                        moved=true;mode=command;
                        emit(@{@"command":command,@"warpError":@(error),@"localX":@(local.x),@"localY":@(local.y)});
                    } else if([command isEqualToString:@"state"]) {
                        const NSPoint local=[view convertPoint:[window convertPointFromScreen:NSEvent.mouseLocation] fromView:nil];
                        const CGPoint current=pointerLocation();
                        emit(@{@"state":@YES,@"mode":mode,@"windowId":@(window.windowNumber),
                            @"localX":@(local.x),@"localY":@(local.y),@"visible":@(window.visible),
                            @"frontmostPid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
                            @"inside":@(NSPointInRect(local,view.bounds)),@"identity":@(view.identity),
                            @"atControlledPoint":@(moved && hypot(current.x-controlled.x,current.y-controlled.y)<=2)});
                    } else {emit(@{@"error":@"Unknown fixture command"});running=false;}
                }
            }
        }
        const CGPoint current=pointerLocation();
        const bool restore=moved && hypot(current.x-controlled.x,current.y-controlled.y)<=2;
        CGError restoreError=kCGErrorSuccess;
        if(restore)restoreError=CGWarpMouseCursorPosition(original);
        const CGPoint restored=pointerLocation();
        emit(@{@"cleanup":@YES,@"pointerRestored":@(restore && restoreError==kCGErrorSuccess &&
            hypot(restored.x-original.x,restored.y-original.y)<=2),@"restoreWarpError":@(restoreError),
            @"independentPointerMovement":@(moved&&!restore)});
        [window close];
    }
    return 0;
}
