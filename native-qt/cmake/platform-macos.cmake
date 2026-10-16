# Included after the application target is defined. Native media frameworks
# will be linked alongside their backends rather than added to Windows targets.
set_target_properties(game-capture PROPERTIES
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/resources/macos/Info.plist.in"
    MACOSX_BUNDLE_BUNDLE_NAME "Game Capture"
    MACOSX_BUNDLE_GUI_IDENTIFIER "ninja.vdo.game-capture"
    MACOSX_BUNDLE_ICON_FILE "GameCapture.icns"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}")

# The Qt window icon is set after launch; Finder also needs a bundle resource.
# Generate it from the existing artwork with Apple's tools, only on macOS.
set(VERSUS_MAC_ICON "${CMAKE_CURRENT_BINARY_DIR}/macos-icon/GameCapture.icns")
add_custom_command(OUTPUT "${VERSUS_MAC_ICON}"
    COMMAND "${CMAKE_COMMAND}"
        "-DICON_SOURCE=${CMAKE_CURRENT_SOURCE_DIR}/resources/vdoninja.png"
        "-DICON_OUTPUT=${VERSUS_MAC_ICON}"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/build-macos-icon.cmake"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/resources/vdoninja.png"
        "${CMAKE_CURRENT_SOURCE_DIR}/cmake/build-macos-icon.cmake"
    COMMENT "Preparing the macOS application icon"
    VERBATIM)
set_source_files_properties("${VERSUS_MAC_ICON}" PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
target_sources(game-capture PRIVATE "${VERSUS_MAC_ICON}")

set(VERSUS_MAC_FFMPEG_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/build-macos-deps/ffmpeg-9.0.2-install"
    CACHE PATH "Pinned arm64 FFmpeg helper prefix built by build-ffmpeg-macos.cmake")
set(VERSUS_MAC_QT_SOURCE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/build-macos-deps/qtbase-everywhere-src-6.9.3"
    CACHE PATH "Source matching the linked Qt Base version, for bundled notices")
set(VERSUS_MAC_NOTICE_COMPONENTS "MbedTLS=${mbedtls_SOURCE_DIR}" "libdatachannel=${libdatachannel_SOURCE_DIR}"
    "Opus=${opus_SOURCE_DIR}" "spdlog=${spdlog_SOURCE_DIR}" "cxxopts=${cxxopts_SOURCE_DIR}")

# Packaging copies the build product so deployment never mutates the executable
# or Qt frameworks used by subsequent incremental builds and gates.
get_target_property(VERSUS_QMAKE_EXECUTABLE Qt6::qmake IMPORTED_LOCATION)
get_filename_component(VERSUS_QT_BIN_DIR "${VERSUS_QMAKE_EXECUTABLE}" DIRECTORY)
find_program(VERSUS_MACDEPLOYQT macdeployqt HINTS "${VERSUS_QT_BIN_DIR}")
if(VERSUS_MACDEPLOYQT)
    find_package(Python3 3.9 REQUIRED COMPONENTS Interpreter)
    execute_process(COMMAND "${VERSUS_QMAKE_EXECUTABLE}" -query QT_INSTALL_LIBS
        OUTPUT_VARIABLE VERSUS_QT_LIB_DIR OUTPUT_STRIP_TRAILING_WHITESPACE
        COMMAND_ERROR_IS_FATAL ANY)
    execute_process(COMMAND "${VERSUS_QMAKE_EXECUTABLE}" -query QT_INSTALL_PREFIX
        OUTPUT_VARIABLE VERSUS_QT_PREFIX OUTPUT_STRIP_TRAILING_WHITESPACE
        COMMAND_ERROR_IS_FATAL ANY)
    add_custom_target(macos-dev-bundle
        COMMAND "${CMAKE_COMMAND}"
            "-DAPP_BUNDLE=$<TARGET_BUNDLE_DIR:game-capture>"
            "-DPACKAGE_DIR=${CMAKE_BINARY_DIR}/package"
            "-DMACDEPLOYQT=${VERSUS_MACDEPLOYQT}"
            "-DQT_LIB_DIR=${VERSUS_QT_LIB_DIR}"
            "-DQT_PROVENANCE_DIR=${VERSUS_QT_PREFIX}/share/game-capture-qt"
            "-DFFMPEG_PREFIX=${VERSUS_MAC_FFMPEG_ROOT}"
            "-DSYPHON_PREFIX=${VERSUS_MAC_SYPHON_ROOT}"
            "-DX264_SOURCE_DIR=${VERSUS_X264_SOURCE_DIR}"
            "-DREPOSITORY_DIR=${CMAKE_CURRENT_SOURCE_DIR}/.."
            "-DPYTHON_EXECUTABLE=${Python3_EXECUTABLE}"
            "-DNOTICE_COMPONENTS=${VERSUS_MAC_NOTICE_COMPONENTS}"
            "-DQT_SOURCE_DIR=${VERSUS_MAC_QT_SOURCE_ROOT}"
            "-DQT_VERSION=${Qt6_VERSION}"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/package-macos-dev.cmake"
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/qa/audit-macos-bundle.py"
            --app "${CMAKE_BINARY_DIR}/package/Game Capture.app"
            --report "${CMAKE_BINARY_DIR}/package/bundle-audit.json"
        DEPENDS game-capture
        COMMENT "Deploying the Mac development bundle"
        VERBATIM)
else()
    message(WARNING "macdeployqt was not found; macos-dev-bundle target is unavailable")
endif()
