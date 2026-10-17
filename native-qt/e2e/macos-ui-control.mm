// Accessibility driver for the real packaged UI. Acts only on the supplied PID.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <cstdio>
#include <string>
id attribute(AXUIElementRef element, CFStringRef key) {
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(element,key,&value)) return nil;
    return CFBridgingRelease(value);
}
bool matches(AXUIElementRef element, NSString *query) {
    for (NSString *key in @[@"AXIdentifier",@"AXTitle",@"AXDescription",@"AXValue"])
        if (id value = attribute(element,(__bridge CFStringRef)key); [value isKindOfClass:NSString.class] &&
            (([key isEqualToString:@"AXIdentifier"] && [value hasSuffix:[@"." stringByAppendingString:query]]) || [value isEqualToString:query] || [value hasPrefix:[query stringByAppendingString:@" - "]] || [value hasPrefix:[query stringByAppendingString:@" ("]])) return true;
    return false;
}
AXUIElementRef find(AXUIElementRef element, NSString *query, int depth = 0) {
    if (depth > 24) return nullptr;
    if (matches(element,query)) return (AXUIElementRef)CFRetain(element);
    for (id child in attribute(element,kAXChildrenAttribute))
        if (auto found = find((__bridge AXUIElementRef)child,query,depth+1)) return found;
    return nullptr;
}
AXUIElementRef findPressable(AXUIElementRef element, NSString *query, int depth = 0) {
    if (depth > 24) return nullptr;
    if (matches(element,query)) {
        CFArrayRef actions = nullptr;
        if (AXUIElementCopyActionNames(element,&actions) == kAXErrorSuccess && actions) {
            const bool pressable = [(__bridge NSArray *)actions containsObject:(__bridge NSString *)kAXPressAction];
            CFRelease(actions);
            if (pressable) return (AXUIElementRef)CFRetain(element);
        }
    }
    // Qt's custom row label and the actionable list cell can share a title.
    // Search the actual row/cell interfaces instead of pressing the label.
    for (NSString *key in @[@"AXChildren",@"AXRows"])
        for (id child in attribute(element,(__bridge CFStringRef)key))
            if (auto found = findPressable((__bridge AXUIElementRef)child,query,depth+1)) return found;
    return nullptr;
}
AXUIElementRef findMenu(AXUIElementRef element, NSString *title, int depth = 0) {
    if (depth > 24) return nullptr;
    id role = attribute(element,kAXRoleAttribute);
    if (([role isEqualToString:@"AXMenuItem"] || [role isEqualToString:@"AXMenuBarItem"]) &&
        [attribute(element,kAXTitleAttribute) isEqualToString:title]) return (AXUIElementRef)CFRetain(element);
    for (id child in attribute(element,kAXChildrenAttribute))
        if (auto found = findMenu((__bridge AXUIElementRef)child,title,depth+1)) return found;
    return nullptr;
}
void dump(AXUIElementRef element, NSMutableArray *items, int depth = 0) {
    if (depth > 24 || items.count > 1200) return;
    auto row = [NSMutableDictionary new]; row[@"depth"] = @(depth);
    for (NSString *key in @[@"AXRole",@"AXSubrole",@"AXIdentifier",@"AXTitle",@"AXDescription",@"AXValue",@"AXEnabled",@"AXSelected",@"AXMinimized",@"AXFocused",@"AXMenuItemCmdChar",@"AXMenuItemCmdModifiers"])
        if (id value = attribute(element,(__bridge CFStringRef)key); [value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class]) row[key] = value;
    [items addObject:row];
    for (id child in attribute(element,kAXChildrenAttribute)) dump((__bridge AXUIElementRef)child,items,depth+1);
}
int main(int argc,char **argv) { @autoreleasepool {
    if (argc < 3 || !AXIsProcessTrusted()) return 2;
    const pid_t pid = atoi(argv[1]); if (pid <= 1) return 2;
    const std::string action = argv[2];
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    const bool screenLocked = [session[@"CGSSessionScreenIsLocked"] boolValue];
    if (action == "session-state") {
        printf("{\"screenLocked\":%s}\n",screenLocked ? "true" : "false");
        return 0;
    }
    // A locked session can return a visible native window but an AX tree that
    // loops through AXApplication. Do not mistake it for missing app controls.
    if (screenLocked) {
        fprintf(stderr,"Screen is locked; native GUI workflows require an unlocked session.\n");
        return 6;
    }
    auto app = AXUIElementCreateApplication(pid);
    if (action == "activate") {
        [[NSRunningApplication runningApplicationWithProcessIdentifier:pid]
            activateWithOptions:NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps];
        AXUIElementSetAttributeValue(app,kAXFrontmostAttribute,kCFBooleanTrue);
        for (id window in attribute(app,kAXWindowsAttribute))
            AXUIElementPerformAction((__bridge AXUIElementRef)window,kAXRaiseAction);
        const auto deadline = [NSDate dateWithTimeIntervalSinceNow:2];
        while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid && deadline.timeIntervalSinceNow > 0)
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        const bool active = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid;
        if (!active) fprintf(stderr,"Target PID %d did not become frontmost (current PID %d)\n",pid,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
        CFRelease(app); return active ? 0 : 5;
    }
    if (action == "window") {
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly,kCGNullWindowID));
        for (NSDictionary *window in windows) if ([window[(id)kCGWindowOwnerPID] intValue] == pid && [window[(id)kCGWindowLayer] intValue] == 0) {
            printf("%u\n",[window[(id)kCGWindowNumber] unsignedIntValue]); CFRelease(app); return 0;
        }
        CFRelease(app); return 3;
    }
    if (action == "dump") {
        auto items = [NSMutableArray new]; dump(app,items);
        auto data = [NSJSONSerialization dataWithJSONObject:items options:NSJSONWritingPrettyPrinted error:nil];
        fwrite(data.bytes,1,data.length,stdout); CFRelease(app); return 0;
    }
    if (action == "scroll-bottom") {
        // Use the target app's accessible scrollbar, without global mouse or
        // keyboard events. This also reveals footer controls on small screens.
        auto area = find(app,@"mainScrollArea");
        if (!area) { CFRelease(app); return 3; }
        id bar = attribute(area,kAXVerticalScrollBarAttribute);
        id maximum = bar ? attribute((__bridge AXUIElementRef)bar,kAXMaxValueAttribute) : nil;
        const AXError error = [maximum isKindOfClass:NSNumber.class]
            ? AXUIElementSetAttributeValue((__bridge AXUIElementRef)bar,kAXValueAttribute,(__bridge CFTypeRef)maximum)
            : kAXErrorAttributeUnsupported;
        if (error) fprintf(stderr,"Could not scroll target app to its footer: %d\n",error);
        CFRelease(area); CFRelease(app); return error ? 4 : 0;
    }
    if (argc < 4) { CFRelease(app); return 2; }
    if (action == "press-menu") {
        auto item = findMenu(app,[NSString stringWithUTF8String:argv[3]]);
        const auto error = item ? AXUIElementPerformAction(item,kAXPressAction) : kAXErrorNoValue;
        if (item) CFRelease(item);
        CFRelease(app); return error ? 4 : 0;
    }
    if (action == "key") {
        // Post only to this PID. Never inject keyboard events into whichever
        // application happens to be frontmost or change system keyboard policy.
        const std::string key = argv[3];
        CGKeyCode code = 0; CGEventFlags flags = 0;
        if (key == "tab" || key == "shift-tab") { code = 48; if (key == "shift-tab") flags = kCGEventFlagMaskShift; }
        else if (key == "space") code = 49;
        else if (key == "return") code = 36;
        else if (key == "escape") code = 53;
        else if (key == "backspace") code = 51;
        else if (key == "up") code = 126;
        else if (key == "down") code = 125;
        else if (key == "a") code = 0;
        else if (key.size() == 1 && key[0] >= '0' && key[0] <= '9') {
            constexpr CGKeyCode digits[] = {29,18,19,20,21,23,22,26,28,25};
            code = digits[key[0] - '0'];
        }
        else if (key == "command-a") { code = 0; flags = kCGEventFlagMaskCommand; }
        else if (key == "command-q") { code = 12; flags = kCGEventFlagMaskCommand; }
        else { CFRelease(app); return 2; }
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) {
            fprintf(stderr,"Keyboard workflow requires the target PID to be frontmost.\n");
            CFRelease(app); return 5;
        }
        const CGKeyCode modifier = flags == kCGEventFlagMaskCommand ? 55 : 56;
        AXError keyError = kAXErrorSuccess;
        if (flags) keyError = AXUIElementPostKeyboardEvent(app,0,modifier,true);
        if (!keyError) keyError = AXUIElementPostKeyboardEvent(app,0,code,true);
        const auto released = AXUIElementPostKeyboardEvent(app,0,code,false);
        if (!keyError) keyError = released;
        if (flags) {
            const auto releasedModifier = AXUIElementPostKeyboardEvent(app,0,modifier,false);
            if (!keyError) keyError = releasedModifier;
        }
        if (keyError) fprintf(stderr,"Targeted keyboard event failed: %d\n",keyError);
        CFRelease(app); return keyError ? 4 : 0;
    }
    if (action == "select-source" || action == "source-ready") {
        auto list = find(app,@"Available capture sources");
        auto row = list ? findPressable(list,[NSString stringWithUTF8String:argv[3]]) : nullptr;
        const auto error = row ? (action == "source-ready" ? kAXErrorSuccess : AXUIElementPerformAction(row,kAXPressAction)) : kAXErrorNoValue;
        if (row) CFRelease(row);
        if (list) CFRelease(list);
        CFRelease(app);
        if (error) fprintf(stderr,"Source accessibility action %s failed: %d\n",argv[2],error);
        return error ? 4 : 0;
    }
    auto element = find(app,[NSString stringWithUTF8String:argv[3]]);
    if (!element) { fprintf(stderr,"UI element not found: %s\n",argv[3]); CFRelease(app); return 3; }
    if (action == "actions") {
        CFArrayRef actions = nullptr;
        const auto error = AXUIElementCopyActionNames(element,&actions);
        if (!error && actions) {
            auto data = [NSJSONSerialization dataWithJSONObject:(__bridge NSArray *)actions options:0 error:nil];
            fwrite(data.bytes,1,data.length,stdout); CFRelease(actions);
        }
        CFRelease(element); CFRelease(app); return error ? 4 : 0;
    }
    AXError error = kAXErrorIllegalArgument;
    if (action == "close-window") {
        // Press only the named window's native close button in the supplied PID.
        // No global keyboard shortcut or arbitrary frontmost-window action.
        id button = [attribute(element,kAXRoleAttribute) isEqualToString:@"AXWindow"]
            ? attribute(element,kAXCloseButtonAttribute) : nil;
        error = button ? AXUIElementPerformAction((__bridge AXUIElementRef)button,kAXPressAction) : kAXErrorNoValue;
    } else if (action == "click" || action == "bounds") {
        CGPoint origin{}; CGSize size{};
        id position = attribute(element,kAXPositionAttribute), dimensions = attribute(element,kAXSizeAttribute);
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid || !position || !dimensions ||
            !AXValueGetValue((__bridge AXValueRef)position,kAXValueTypeCGPoint,&origin) ||
            !AXValueGetValue((__bridge AXValueRef)dimensions,kAXValueTypeCGSize,&size) ||
            size.width <= 0 || size.height <= 0) { CFRelease(element); CFRelease(app); return 5; }
        if (action == "bounds") {
            printf("{\"x\":%f,\"y\":%f,\"width\":%f,\"height\":%f}\n",origin.x,origin.y,size.width,size.height);
            CFRelease(element); CFRelease(app); return 0;
        }
        const CGPoint point{origin.x + size.width / 2, origin.y + size.height / 2};
        AXUIElementRef hit = nullptr;
        if (AXUIElementCopyElementAtPosition(app,point.x,point.y,&hit) || !hit) { CFRelease(element); CFRelease(app); return 5; }
        pid_t hitPid = 0;
        const bool belongsToApp = !AXUIElementGetPid(hit,&hitPid) && hitPid == pid;
        CFRelease(hit);
        if (!belongsToApp) { CFRelease(element); CFRelease(app); return 5; }
        for (auto type : {kCGEventLeftMouseDown,kCGEventLeftMouseUp}) {
            auto event = CGEventCreateMouseEvent(nullptr,type,point,kCGMouseButtonLeft);
            CGEventSetIntegerValueField(event,kCGMouseEventClickState,1);
            CGEventPost(kCGHIDEventTap,event); CFRelease(event);
        }
        error = kAXErrorSuccess;
    }
    if (action == "verify-selected") {
        // Mac source rows expose a single-choice radio action with an explicit
        // checked value. Prefer that row over the filter's matching text value.
        auto list = find(app,@"Available capture sources");
        auto row = list ? findPressable(list,[NSString stringWithUTF8String:argv[3]]) : nullptr;
        const bool checked = row && [attribute(row,kAXRoleAttribute) isEqualToString:@"AXRadioButton"]
            && [attribute(row,kAXValueAttribute) intValue] == 1;
        if(row)CFRelease(row);
        if(list)CFRelease(list);
        bool selected = [attribute(element,kAXSelectedAttribute) boolValue];
        selected = selected || checked;
        id parent = attribute(element,kAXParentAttribute);
        if (parent) selected = selected || [attribute((__bridge AXUIElementRef)parent,kAXSelectedAttribute) boolValue];
        if (!selected) {
            auto list = find(app,@"Available capture sources");
            if (list) {
                for (NSString *key in @[@"AXSelectedRows",@"AXSelectedChildren"])
                    for (id row in attribute(list,(__bridge CFStringRef)key))
                        if (auto match = find((__bridge AXUIElementRef)row,[NSString stringWithUTF8String:argv[3]])) { selected = true; CFRelease(match); }
                CFRelease(list);
            }
        }
        error = selected ? kAXErrorSuccess : kAXErrorFailure;
    }
    if (action == "press") error = AXUIElementPerformAction(element,kAXPressAction);
    if (action == "focus") error = AXUIElementSetAttributeValue(element,kAXFocusedAttribute,kCFBooleanTrue);
    if ((action == "increment" || action == "decrement") && argc == 5) {
        // Native spin-button actions commit numeric values. AXValue on a Qt
        // spin box can edit its text without committing the underlying value.
        int count = 0;
        NSScanner *scanner = [NSScanner scannerWithString:[NSString stringWithUTF8String:argv[4]]];
        if (![scanner scanInt:&count] || !scanner.isAtEnd || count < 1 || count > 200 ||
            ![attribute(element,kAXEnabledAttribute) boolValue]) {
            CFRelease(element); CFRelease(app); return 2;
        }
        const CFStringRef step = action == "increment" ? kAXIncrementAction : kAXDecrementAction;
        for (int i = 0; i < count; ++i) {
            error = AXUIElementPerformAction(element,step);
            if (error) break;
        }
    }
    if (action == "confirm") error = AXUIElementPerformAction(element,CFSTR("AXConfirm"));
    if (action == "set" && argc == 5) error = AXUIElementSetAttributeValue(element,kAXValueAttribute,(__bridge CFStringRef)[NSString stringWithUTF8String:argv[4]]);
    if (error) fprintf(stderr,"AX action %s failed: %d\n",argv[2],error);
    CFRelease(element); CFRelease(app); return error ? 4 : 0;
} }
