cmake_minimum_required(VERSION 3.24)
project(game-capture-native-qt VERSION 0.2.23 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

if(WIN32)
    add_definitions(-DUNICODE -D_UNICODE -DWIN32_LEAN_AND_MEAN -DNOMINMAX -D_COROUTINE_ABI=1)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

option(VERSUS_USE_NVENC "Enable NVIDIA NVENC hardware encoding" ON)
option(VERSUS_USE_WHIP "Enable WHIP publishing support" OFF)
option(VERSUS_USE_GRAPHICS_CAPTURE "Enable Windows Graphics Capture API (requires WinRT)" ON)

find_package(Threads REQUIRED)
find_package(Qt6 REQUIRED COMPONENTS Widgets)

include(FetchContent)

FetchContent_Declare(
    mbedtls
    GIT_REPOSITORY https://github.com/Mbed-TLS/mbedtls.git
    GIT_TAG v3.5.0
)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON CACHE BOOL "" FORCE)
add_compile_definitions(MBEDTLS_SSL_DTLS_SRTP)
FetchContent_MakeAvailable(mbedtls)

set(MbedTLS_INCLUDE_DIR "${mbedtls_SOURCE_DIR}/include" CACHE PATH "" FORCE)
set(MbedTLS_LIBRARY mbedtls CACHE STRING "" FORCE)
set(MbedX509_LIBRARY mbedx509 CACHE STRING "" FORCE)
set(MbedCrypto_LIBRARY mbedcrypto CACHE STRING "" FORCE)
set(MBEDTLS_INCLUDE_DIRS "${mbedtls_SOURCE_DIR}/include" CACHE PATH "" FORCE)
set(MBEDTLS_LIBRARIES mbedtls mbedx509 mbedcrypto CACHE STRING "" FORCE)
set(MbedTLS_FOUND TRUE CACHE BOOL "" FORCE)
set(MBEDTLS_FOUND TRUE CACHE BOOL "" FORCE)
if(NOT TARGET MbedTLS::mbedtls)
    add_library(MbedTLS::mbedtls ALIAS mbedtls)
endif()
if(NOT TARGET MbedTLS::mbedx509)
    add_library(MbedTLS::mbedx509 ALIAS mbedx509)
endif()
if(NOT TARGET MbedTLS::mbedcrypto)
    add_library(MbedTLS::mbedcrypto ALIAS mbedcrypto)
endif()

FetchContent_Declare(
    libdatachannel
    GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
    GIT_TAG v0.24.0
)
set(NO_MEDIA OFF CACHE BOOL "" FORCE)
set(USE_MBEDTLS ON CACHE BOOL "" FORCE)
set(NO_WEBSOCKET OFF CACHE BOOL "" FORCE)
set(PREFER_SYSTEM_LIB OFF CACHE BOOL "" FORCE)
set(USE_SYSTEM_SRTP OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_INSTALL OFF CACHE BOOL "" FORCE)
set(LIBSRTP_INSTALL_CMAKE OFF CACHE BOOL "" FORCE)
set(CMAKE_SKIP_INSTALL_RULES ON CACHE BOOL "" FORCE)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(libdatachannel)

# Exclude shared library target from default build
if(TARGET datachannel)
    set_target_properties(datachannel PROPERTIES EXCLUDE_FROM_ALL TRUE)
endif()

# Fix mbedtls library search path for datachannel-static
if(TARGET datachannel-static)
    target_link_directories(datachannel-static PUBLIC ${CMAKE_BINARY_DIR}/lib)
endif()
if(TARGET juice-static)
    target_link_directories(juice-static PUBLIC ${CMAKE_BINARY_DIR}/lib)
endif()

FetchContent_Declare(
    spdlog
    GIT_REPOSITORY https://github.com/gabime/spdlog.git
    GIT_TAG v1.13.0
)
FetchContent_MakeAvailable(spdlog)

FetchContent_Declare(
    cxxopts
    GIT_REPOSITORY https://github.com/jarro2783/cxxopts.git
    GIT_TAG v3.1.1
)
FetchContent_MakeAvailable(cxxopts)

FetchContent_Declare(
    opus
    GIT_REPOSITORY https://github.com/xiph/opus.git
    GIT_TAG v1.4
)
set(OPUS_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(opus)

set(VERSUS_SOURCES
    src/main.cpp
    src/app/versus_app.cpp
    src/app/dual_stream_policy.cpp
    src/ui/main_window.cpp
    src/ui/window_list_widget.cpp
    src/ui/stats_panel.cpp
    src/signaling/vdo_signaling.cpp
    src/webrtc/webrtc_client.cpp
    src/video/window_capture.cpp
    src/video/video_encoder.cpp
    src/audio/opus_encoder.cpp
    src/audio/window_audio_capture_core.cpp
)

set(VERSUS_HEADERS
    include/versus/app/versus_app.h
    include/versus/app/dual_stream_policy.h
    include/versus/ui/main_window.h
    include/versus/ui/window_list_widget.h
    include/versus/ui/stats_panel.h
    include/versus/signaling/vdo_signaling.h
    include/versus/webrtc/webrtc_client.h
    include/versus/video/window_capture.h
    include/versus/video/video_encoder.h
    include/versus/audio/opus_encoder.h
    include/versus/audio/window_audio_capture_core.h
)

# Qt resource files
qt6_add_resources(VERSUS_RESOURCES resources/resources.qrc)

# Windows resource file for application icon
if(WIN32)
    set(APP_ICON_RC ${CMAKE_CURRENT_SOURCE_DIR}/resources/app.rc)
endif()

add_executable(game-capture WIN32 ${VERSUS_SOURCES} ${VERSUS_HEADERS} ${VERSUS_RESOURCES} ${APP_ICON_RC})

set_target_properties(game-capture PROPERTIES AUTOMOC ON)

target_include_directories(game-capture PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(game-capture PRIVATE
    Threads::Threads
    Qt6::Widgets
    spdlog::spdlog
    cxxopts::cxxopts
    datachannel-static
    mbedtls
    mbedx509
    mbedcrypto
    opus
)

target_include_directories(game-capture PRIVATE
    ${opus_SOURCE_DIR}/include
    ${libdatachannel_SOURCE_DIR}/deps/json/include
)

if(WIN32)
    target_link_libraries(game-capture PRIVATE
        ole32
        oleaut32
        uuid
        user32
        gdi32
        shlwapi
        winmm
        dwmapi
        d3d11
        dxgi
    )
endif()

if(VERSUS_USE_NVENC)
    target_compile_definitions(game-capture PRIVATE VERSUS_USE_NVENC)
endif()

if(VERSUS_USE_GRAPHICS_CAPTURE)
    target_compile_definitions(game-capture PRIVATE VERSUS_USE_GRAPHICS_CAPTURE)
endif()

# WebSocket test executable
add_executable(test-websocket src/test_websocket.cpp)
target_link_libraries(test-websocket PRIVATE
    Threads::Threads
    datachannel-static
    mbedtls
    mbedx509
    mbedcrypto
)
if(WIN32)
    target_link_libraries(test-websocket PRIVATE ws2_32 bcrypt)
endif()

# Stream test executable (minimal WebRTC signaling test)
add_executable(test-stream src/test_stream.cpp)
target_link_libraries(test-stream PRIVATE
    Threads::Threads
    datachannel-static
    mbedtls
    mbedx509
    mbedcrypto
)
target_include_directories(test-stream PRIVATE
    ${libdatachannel_SOURCE_DIR}/deps/json/include
)
if(WIN32)
    target_link_libraries(test-stream PRIVATE ws2_32 bcrypt)
endif()

# Testing
option(VERSUS_BUILD_TESTS "Build tests" OFF)

if(VERSUS_BUILD_TESTS)
    enable_testing()
    find_package(Qt6 REQUIRED COMPONENTS Test)

    # Ensure Qt platform plugins are found when running tests via ctest.
    set(QT_PLUGIN_PATH_FOR_TESTS "")
    foreach(QT6_ROOT_CANDIDATE "${Qt6_DIR}/../.." "${Qt6_DIR}/../../..")
        get_filename_component(QT6_PACKAGE_ROOT "${QT6_ROOT_CANDIDATE}" ABSOLUTE)
        if(EXISTS "${QT6_PACKAGE_ROOT}/Qt6/plugins")
            set(QT_PLUGIN_PATH_FOR_TESTS "${QT6_PACKAGE_ROOT}/Qt6/plugins")
            break()
        endif()
        if(EXISTS "${QT6_PACKAGE_ROOT}/plugins")
            set(QT_PLUGIN_PATH_FOR_TESTS "${QT6_PACKAGE_ROOT}/plugins")
            break()
        endif()
    endforeach()
    if(QT_PLUGIN_PATH_FOR_TESTS STREQUAL "")
        set(QT_PLUGIN_PATH_FOR_TESTS "${Qt6_DIR}")
    endif()

    # Library target for testable code (without main.cpp)
    set(VERSUS_LIB_SOURCES
        src/app/versus_app.cpp
        src/app/dual_stream_policy.cpp
        src/ui/main_window.cpp
        src/ui/window_list_widget.cpp
        src/ui/stats_panel.cpp
        src/signaling/vdo_signaling.cpp
        src/webrtc/webrtc_client.cpp
        src/video/window_capture.cpp
        src/video/video_encoder.cpp
        src/audio/opus_encoder.cpp
        src/audio/window_audio_capture_core.cpp
    )

    add_library(versus-lib STATIC ${VERSUS_LIB_SOURCES} ${VERSUS_HEADERS} ${VERSUS_RESOURCES})
    set_target_properties(versus-lib PROPERTIES AUTOMOC ON)
    target_include_directories(versus-lib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
    target_link_libraries(versus-lib PUBLIC
        Threads::Threads
        Qt6::Widgets
        spdlog::spdlog
        datachannel-static
        mbedtls
        mbedx509
        mbedcrypto
        opus
    )
    target_include_directories(versus-lib PUBLIC
        ${opus_SOURCE_DIR}/include
        ${libdatachannel_SOURCE_DIR}/deps/json/include
    )
    if(WIN32)
        target_link_libraries(versus-lib PUBLIC
            ole32 oleaut32 uuid user32 gdi32 shlwapi winmm dwmapi d3d11 dxgi
        )
    endif()
    if(VERSUS_USE_NVENC)
        target_compile_definitions(versus-lib PUBLIC VERSUS_USE_NVENC)
    endif()
    if(VERSUS_USE_GRAPHICS_CAPTURE)
        target_compile_definitions(versus-lib PUBLIC VERSUS_USE_GRAPHICS_CAPTURE)
    endif()

    # Test: WindowListWidget
    add_executable(test_window_list_widget tests/test_window_list_widget.cpp)
    set_target_properties(test_window_list_widget PROPERTIES AUTOMOC ON)
    target_link_libraries(test_window_list_widget PRIVATE versus-lib Qt6::Test)
    add_test(NAME WindowListWidgetTest COMMAND test_window_list_widget)
    set_tests_properties(WindowListWidgetTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")

    # Test: WindowCapture
    add_executable(test_window_capture tests/test_window_capture.cpp)
    set_target_properties(test_window_capture PROPERTIES AUTOMOC ON)
    target_link_libraries(test_window_capture PRIVATE versus-lib Qt6::Test)
    add_test(NAME WindowCaptureTest COMMAND test_window_capture)
    set_tests_properties(WindowCaptureTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")

    # Test: OpusEncoder
    add_executable(test_opus_encoder tests/test_opus_encoder.cpp)
    set_target_properties(test_opus_encoder PROPERTIES AUTOMOC ON)
    target_link_libraries(test_opus_encoder PRIVATE versus-lib Qt6::Test)
    add_test(NAME OpusEncoderTest COMMAND test_opus_encoder)
    set_tests_properties(OpusEncoderTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")

    # Test: Dual-stream policy
    add_executable(test_dual_stream_policy tests/test_dual_stream_policy.cpp)
    set_target_properties(test_dual_stream_policy PROPERTIES AUTOMOC ON)
    target_link_libraries(test_dual_stream_policy PRIVATE versus-lib Qt6::Test)
    add_test(NAME DualStreamPolicyTest COMMAND test_dual_stream_policy)
    set_tests_properties(DualStreamPolicyTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")

    # Test: StatsPanel
    add_executable(test_stats_panel tests/test_stats_panel.cpp)
    set_target_properties(test_stats_panel PROPERTIES AUTOMOC ON)
    target_link_libraries(test_stats_panel PRIVATE versus-lib Qt6::Test)
    add_test(NAME StatsPanelTest COMMAND test_stats_panel)
    set_tests_properties(StatsPanelTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")

    # Test: MainWindow
    add_executable(test_main_window tests/test_main_window.cpp)
    set_target_properties(test_main_window PROPERTIES AUTOMOC ON)
    target_link_libraries(test_main_window PRIVATE versus-lib Qt6::Test)
    add_test(NAME MainWindowTest COMMAND test_main_window)
    set_tests_properties(MainWindowTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")

    # Test: VdoSignaling lifecycle
    add_executable(test_vdo_signaling tests/test_vdo_signaling.cpp)
    set_target_properties(test_vdo_signaling PROPERTIES AUTOMOC ON)
    target_link_libraries(test_vdo_signaling PRIVATE versus-lib Qt6::Test)
    add_test(NAME VdoSignalingTest COMMAND test_vdo_signaling)
    set_tests_properties(VdoSignalingTest PROPERTIES
        ENVIRONMENT "QT_PLUGIN_PATH=${QT_PLUGIN_PATH_FOR_TESTS};QT_QPA_PLATFORM=offscreen")
endif()

