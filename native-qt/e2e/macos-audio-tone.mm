// Controlled fixture: sends generated tones ONLY to the explicitly named
// existing BlackHole device. Never changes system defaults or opens an input.
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioUnit/AudioUnit.h>
#include <atomic>
#include <cmath>
#include <iostream>
#include <vector>
#include <memory>
int main(int argc, char **argv) { @autoreleasepool {
    if (argc != 4) { std::cerr << "Usage: macos-audio-tone BLACKHOLE_UID LEFT_HZ RIGHT_HZ\n"; return 2; }
    AudioObjectPropertyAddress key{kAudioHardwarePropertyDevices,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    UInt32 bytes = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&key,0,nullptr,&bytes)) return 3;
    std::vector<AudioDeviceID> ids(bytes/sizeof(AudioDeviceID));
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject,&key,0,nullptr,&bytes,ids.data())) return 3;
    AudioDeviceID selected = 0;
    for (auto id : ids) {
        CFStringRef uid = nullptr, name = nullptr;
        key.mSelector = kAudioDevicePropertyDeviceUID; UInt32 size = sizeof(uid);
        AudioObjectGetPropertyData(id,&key,0,nullptr,&size,&uid);
        key.mSelector = kAudioObjectPropertyName; size = sizeof(name);
        AudioObjectGetPropertyData(id,&key,0,nullptr,&size,&name);
        if (uid && name && std::string([(__bridge NSString *)uid UTF8String]) == argv[1] &&
            [(__bridge NSString *)name containsString:@"BlackHole"]) selected = id;
        if (uid) CFRelease(uid); if (name) CFRelease(name);
    }
    if (!selected) { std::cerr << "Explicit BlackHole output not found\n"; return 4; }
    const double left = std::stod(argv[2]), right = std::stod(argv[3]);
    if (left < 100 || left > 5000 || right < 100 || right > 5000) return 2;
    auto engine = [AVAudioEngine new];
    if (AudioUnitSetProperty(engine.outputNode.audioUnit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&selected,sizeof(selected))) return 5;
    auto format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:2];
    auto audible = std::make_shared<std::atomic<bool>>(true);
    __block uint64_t frameIndex = 0;
    auto tone = [[AVAudioSourceNode alloc] initWithFormat:format renderBlock:
        ^OSStatus(BOOL *,const AudioTimeStamp *,AVAudioFrameCount frames,AudioBufferList *output) {
            for (unsigned frame = 0; frame < frames; ++frame,++frameIndex)
                for (unsigned channel = 0; channel < output->mNumberBuffers; ++channel)
                    static_cast<float *>(output->mBuffers[channel].mData)[frame] = audible->load()
                        ? .04 * std::sin(frameIndex * 2 * M_PI * (channel ? right : left) / 48000) : 0;
            return noErr;
        }];
    [engine attachNode:tone]; [engine connect:tone to:engine.mainMixerNode format:format];
    NSError *error = nil;
    if (![engine startAndReturnError:&error]) { std::cerr << error.localizedDescription.UTF8String; return 6; }
    std::cout << "READY " << argv[1] << std::endl;
    std::string command;
    while (std::getline(std::cin,command)) {
        if (command == "silence") audible->store(false);
        else if (command == "sound") audible->store(true);
        else if (command == "quit") break;
    }
    [engine stop];
} }
