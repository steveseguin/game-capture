# Isolated Syphon framework for the Apple Silicon shared-texture input.
# Requires Xcode and its Metal compiler component. No installed framework is modified.
cmake_minimum_required(VERSION 3.24)
if(NOT CMAKE_HOST_APPLE)
    message(FATAL_ERROR "Build Syphon on macOS")
endif()
if(NOT DEFINED SYPHON_WORK_DIR)
    get_filename_component(SYPHON_WORK_DIR "${CMAKE_CURRENT_LIST_DIR}/../build-macos-deps" ABSOLUTE)
endif()
if(NOT DEFINED SYPHON_SDK)
    execute_process(COMMAND xcrun --sdk macosx --show-sdk-path
        OUTPUT_VARIABLE SYPHON_SDK OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
endif()
set(revision f4761677a45b8034a3c2069ec0f3d2553da81fba)
set(sha256 a3766088c46588c42b087f4e5ff7ae7bb0f83292af59a0aeb8bba69eba5311c5)
set(url "https://codeload.github.com/Syphon/Syphon-Framework/tar.gz/${revision}")
set(archive "${SYPHON_WORK_DIR}/syphon-${revision}.tar.gz")
set(source "${SYPHON_WORK_DIR}/Syphon-Framework-${revision}")
set(build "${SYPHON_WORK_DIR}/syphon-build-${revision}")
set(prefix "${SYPHON_WORK_DIR}/syphon-${revision}")
file(MAKE_DIRECTORY "${SYPHON_WORK_DIR}")
if(NOT EXISTS "${archive}")
    file(DOWNLOAD "${url}" "${archive}" EXPECTED_HASH "SHA256=${sha256}" TLS_VERIFY ON SHOW_PROGRESS)
endif()
file(SHA256 "${archive}" actual_sha256)
if(NOT actual_sha256 STREQUAL sha256)
    message(FATAL_ERROR "Unexpected Syphon source archive hash")
endif()
file(ARCHIVE_EXTRACT INPUT "${archive}" DESTINATION "${SYPHON_WORK_DIR}")
execute_process(COMMAND xcrun metal --version RESULT_VARIABLE metal_status OUTPUT_QUIET ERROR_QUIET)
if(NOT metal_status EQUAL 0)
    message(FATAL_ERROR "The Xcode Metal compiler is required; install it with xcodebuild -downloadComponent MetalToolchain")
endif()
execute_process(COMMAND xcodebuild -project "${source}/Syphon.xcodeproj" -scheme Syphon
    -configuration Release -sdk "${SYPHON_SDK}" -arch arm64 -jobs 2
    -derivedDataPath "${build}" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
    MACOSX_DEPLOYMENT_TARGET=14.2 ONLY_ACTIVE_ARCH=NO
    "DYLIB_INSTALL_NAME_BASE=@rpath" build
    COMMAND_ERROR_IS_FATAL ANY)
file(MAKE_DIRECTORY "${prefix}/Frameworks")
execute_process(COMMAND /usr/bin/ditto "${build}/Build/Products/Release/Syphon.framework"
    "${prefix}/Frameworks/Syphon.framework" COMMAND_ERROR_IS_FATAL ANY)
set(provenance "${prefix}/share/game-capture-syphon")
file(MAKE_DIRECTORY "${provenance}")
file(COPY "${archive}" DESTINATION "${provenance}")
configure_file("${CMAKE_CURRENT_LIST_FILE}" "${provenance}/build-syphon-macos.cmake" COPYONLY)
# Upstream keeps copyright/license notices in individual source headers rather
# than a root LICENSE file. Preserve those headers and the full pinned archive.
file(GLOB headers "${source}/*.h")
file(COPY ${headers} DESTINATION "${provenance}/source-headers")
file(WRITE "${provenance}/source.txt"
    "Syphon framework\nRevision: ${revision}\nSource: ${url}\nSHA-256: ${sha256}\nArchitecture: arm64\nMinimum macOS: 14.2\nSDK: ${SYPHON_SDK}\nSource notices are retained in source-headers and the matching source archive.\n")
message(STATUS "Syphon framework built at ${prefix}")
