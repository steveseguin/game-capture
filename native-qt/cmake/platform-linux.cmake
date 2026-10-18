find_package(PkgConfig REQUIRED)
find_package(Qt6 REQUIRED COMPONENTS DBus)
pkg_check_modules(LINUX_MEDIA REQUIRED IMPORTED_TARGET libavcodec libavutil libswscale)
pkg_check_modules(PIPEWIRE REQUIRED IMPORTED_TARGET libpipewire-0.3)
pkg_check_modules(PULSE REQUIRED IMPORTED_TARGET libpulse)
pkg_check_modules(SECRET REQUIRED IMPORTED_TARGET libsecret-1)
pkg_check_modules(XCB_CAPTURE REQUIRED IMPORTED_TARGET xcb xcb-composite)

list(REMOVE_ITEM VERSUS_PLATFORM_SOURCES src/video/window_capture.cpp src/video/camera_capture.cpp src/audio/window_audio_capture_core.cpp)
list(APPEND VERSUS_PLATFORM_SOURCES
    src/platform/posix/ffmpeg.cpp
    src/platform/posix/ffmpeg_encoder.cpp
    src/platform/linux/video_encoder.cpp
    src/platform/linux/network.cpp
    src/platform/linux/window_capture.cpp
    src/platform/linux/system_resources.cpp
    src/platform/linux/camera_capture.cpp
    src/platform/linux/audio_capture.cpp
    src/platform/linux/output_profiles.cpp
    src/platform/linux/app_paths.cpp)
list(APPEND VERSUS_PLATFORM_LIBRARIES
    Qt6::DBus PkgConfig::LINUX_MEDIA PkgConfig::PIPEWIRE PkgConfig::PULSE PkgConfig::SECRET PkgConfig::XCB_CAPTURE)
