// QA fixture: one owned public aggregate of an existing virtual BlackHole.
// No physical input, output IO or default-device setter is used.
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#include <array>
#include <csignal>
#include <poll.h>
#include <unistd.h>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
static volatile sig_atomic_t interrupted=0;
static void interruptedSignal(int) { interrupted=1; }
static void require(bool condition,const char *message) { if(!condition)throw std::runtime_error(message); }
static AudioObjectPropertyAddress key(AudioObjectPropertySelector selector) { return {selector,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain}; }
template<class T> T property(AudioObjectID object,AudioObjectPropertySelector selector) {
    T value{};UInt32 bytes=sizeof(value);auto address=key(selector);
    require(!AudioObjectGetPropertyData(object,&address,0,nullptr,&bytes,&value),"Core Audio property unavailable");return value;
}
static std::vector<AudioObjectID> devices() {
    auto address=key(kAudioHardwarePropertyDevices);UInt32 bytes=0;
    require(!AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&address,0,nullptr,&bytes),"Device list unavailable");
    std::vector<AudioObjectID> result(bytes/sizeof(AudioObjectID));
    require(!AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,0,nullptr,&bytes,result.data()),"Device list read failed");return result;
}
static NSString *uid(AudioObjectID device) {
    CFStringRef value=property<CFStringRef>(device,kAudioDevicePropertyDeviceUID);return CFBridgingRelease(value);
}
static std::array<AudioObjectID,3> defaults() {
    return {property<AudioObjectID>(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultInputDevice),
        property<AudioObjectID>(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultOutputDevice),
        property<AudioObjectID>(kAudioObjectSystemObject,kAudioHardwarePropertyDefaultSystemOutputDevice)};
}
static bool contains(NSString *name) { for(auto device:devices())if([uid(device) isEqualToString:name])return true;return false; }
struct OwnedAggregate {
    AudioObjectID device=0;
    bool stop() {
        if(!device)return true;
        auto status=AudioHardwareDestroyAggregateDevice(device);
        if(status)return false;
        device=0;return true;
    }
    ~OwnedAggregate() { if(!stop())std::cerr<<"Owned aggregate cleanup failed\n"; }
};
int main(int argc,char **argv) { @autoreleasepool {
    if(argc!=1)return 2;
    std::signal(SIGINT,interruptedSignal);std::signal(SIGTERM,interruptedSignal);
    OwnedAggregate owned;
    try {
        const auto originalDefaults=defaults();
        NSString *sourceUID=@"BlackHole2ch_UID";bool found=false;
        for(auto device:devices())if([uid(device) isEqualToString:sourceUID]) {
            NSString *name=CFBridgingRelease(property<CFStringRef>(device,kAudioObjectPropertyName));
            require([name containsString:@"BlackHole"],"Selected UID is not BlackHole");
            require(property<UInt32>(device,kAudioDevicePropertyTransportType)==kAudioDeviceTransportTypeVirtual,"BlackHole transport is not virtual");found=true;
        }
        require(found,"Explicit existing virtual BlackHole device unavailable");
        NSString *aggregateUID=[@"ninja.vdo.game-capture.qa-input." stringByAppendingString:NSUUID.UUID.UUIDString];
        NSString *name=[@"Game Capture QA Input " stringByAppendingString:NSUUID.UUID.UUIDString];
        require(!contains(aggregateUID),"Owned aggregate UID already exists");
        NSDictionary *description=@{@kAudioAggregateDeviceNameKey:name,@kAudioAggregateDeviceUIDKey:aggregateUID,
            @kAudioAggregateDeviceIsPrivateKey:@NO,@kAudioAggregateDeviceMainSubDeviceKey:sourceUID,
            @kAudioAggregateDeviceSubDeviceListKey:@[@{@kAudioSubDeviceUIDKey:sourceUID}]};
        auto announce=[&](const char *event) {
            require(defaults()==originalDefaults,"A system default changed during the fixture");
            NSDictionary *record=@{@"event":[NSString stringWithUTF8String:event],@"uid":aggregateUID,@"name":name,@"deviceId":@(owned.device),@"defaultsUnchanged":@YES};
            NSData *data=[NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
            std::cout.write(static_cast<const char *>(data.bytes),data.length);std::cout<<std::endl;
        };
        auto create=[&] {
            require(!owned.device&&!contains(aggregateUID),"Owned aggregate has not retired");
            require(!AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)description,&owned.device),"Aggregate creation failed");
            require(owned.device!=0,"Aggregate ID absent");announce("created");
        };
        auto retire=[&] {
            require(owned.stop(),"Owned aggregate destruction failed");
            const auto deadline=[NSDate dateWithTimeIntervalSinceNow:5];
            while(contains(aggregateUID)&&deadline.timeIntervalSinceNow>0)[NSThread sleepForTimeInterval:.05];
            require(!contains(aggregateUID),"Owned aggregate remained registered");announce("retired");
        };
        create();std::string pending;
        while(!interrupted) {
            pollfd input{STDIN_FILENO,POLLIN,0};const int ready=poll(&input,1,200);
            if(ready<0){if(interrupted)break;throw std::runtime_error("stdin poll failed");}
            if(!ready)continue;
            char buffer[128];auto count=read(STDIN_FILENO,buffer,sizeof(buffer));if(count<=0)break;
            pending.append(buffer,count);require(pending.size()<1024,"Command too long");
            size_t newline;
            while((newline=pending.find('\n'))!=std::string::npos) {
                auto command=pending.substr(0,newline);pending.erase(0,newline+1);
                if(command=="quit"){interrupted=1;break;}
                if(command=="retire")retire();
                else if(command=="restore")create();
                else if(command=="state")announce("state");
                else throw std::runtime_error("Unknown fixture command");
            }
        }
        retire();return 0;
    } catch(const std::exception &error) {
        std::cerr<<error.what()<<std::endl;return 1;
    }
} }
