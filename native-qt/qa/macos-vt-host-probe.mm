// Host capability diagnostic, not packaged application testing.
#import <Foundation/Foundation.h>
#import <VideoToolbox/VideoToolbox.h>

static void output(void *, void *, OSStatus, VTEncodeInfoFlags, CMSampleBufferRef) {}
int main() { @autoreleasepool {
    CFArrayRef encoders = nullptr;
    const OSStatus listStatus = VTCopyVideoEncoderList(nullptr, &encoders);
    NSMutableArray *inventory = [NSMutableArray new];
    if (encoders) {
        for (NSDictionary *encoder in (__bridge NSArray *)encoders) {
            NSMutableDictionary *item = [NSMutableDictionary new];
            for (NSString *key in @[(__bridge NSString *)kVTVideoEncoderList_CodecType,
                    (__bridge NSString *)kVTVideoEncoderList_EncoderID,
                    (__bridge NSString *)kVTVideoEncoderList_EncoderName,
                    (__bridge NSString *)kVTVideoEncoderList_IsHardwareAccelerated]) {
                if (id value = encoder[key]) item[key] = value;
            }
            [inventory addObject:item];
        }
        CFRelease(encoders);
    }
    NSMutableArray *sessions = [NSMutableArray new];
    for (NSNumber *requireHardware in @[@YES, @NO]) {
        NSDictionary *specification = @{
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: requireHardware};
        VTCompressionSessionRef session = nullptr;
        const OSStatus status = VTCompressionSessionCreate(nullptr, 640, 360, kCMVideoCodecType_H264,
            (__bridge CFDictionaryRef)specification, nullptr, nullptr, output, nullptr, &session);
        NSMutableDictionary *item = [@{@"requireHardware": requireHardware, @"createStatus": @(status)} mutableCopy];
        if (session) {
            item[@"prepareStatus"] = @(VTCompressionSessionPrepareToEncodeFrames(session));
            CFTypeRef actual = nullptr;
            item[@"hardwarePropertyStatus"] = @(VTSessionCopyProperty(session,
                kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, nullptr, &actual));
            if (actual) { item[@"actualHardware"] = @(CFEqual(actual, kCFBooleanTrue)); CFRelease(actual); }
            VTCompressionSessionInvalidate(session);
            CFRelease(session);
        }
        [sessions addObject:item];
    }
    NSDictionary *result = @{@"scope": @"Native VideoToolbox host capability gate; no application pass implied",
        @"listStatus": @(listStatus), @"encoders": inventory, @"sessions": sessions};
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:&error];
    if (!data) return 1;
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout);
    return 0;
} }
