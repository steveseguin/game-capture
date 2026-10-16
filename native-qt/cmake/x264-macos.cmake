# Direct GPL x264 dependency for the Mac encoder; Windows FFmpeg policy is unchanged.
include(ExternalProject)
find_program(VERSUS_MAKE_EXECUTABLE make REQUIRED)
set(VERSUS_X264_PREFIX "${CMAKE_BINARY_DIR}/x264-install")
file(MAKE_DIRECTORY "${VERSUS_X264_PREFIX}/include")
set(VERSUS_MAC_X264_SOURCE_ROOT "" CACHE PATH "Optional local x264 source from the matching Mac source bundle")
if(VERSUS_MAC_X264_SOURCE_ROOT)
    if(NOT EXISTS "${VERSUS_MAC_X264_SOURCE_ROOT}/configure" OR NOT EXISTS "${VERSUS_MAC_X264_SOURCE_ROOT}/x264.h")
        message(FATAL_ERROR "The supplied x264 source tree is incomplete")
    endif()
    set(x264_download SOURCE_DIR "${VERSUS_MAC_X264_SOURCE_ROOT}" DOWNLOAD_COMMAND "" UPDATE_COMMAND "")
else()
    set(x264_download GIT_REPOSITORY https://code.videolan.org/videolan/x264.git
        GIT_TAG b35605ace3ddf7c1a5d67a2eb553f034aef41d55 UPDATE_DISCONNECTED TRUE)
endif()
ExternalProject_Add(versus-x264-build
    ${x264_download}
    CONFIGURE_COMMAND "${CMAKE_COMMAND}" -E env "CC=${CMAKE_C_COMPILER}" "AR=${CMAKE_AR}"
        <SOURCE_DIR>/configure "--prefix=${VERSUS_X264_PREFIX}"
        --host=aarch64-apple-darwin --enable-static --enable-pic --disable-cli --disable-opencl --bit-depth=8
        "--sysroot=${CMAKE_OSX_SYSROOT}"
        "--extra-cflags=-arch arm64 -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}"
        "--extra-asflags=-arch arm64 -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET} -isysroot ${CMAKE_OSX_SYSROOT}"
        "--extra-ldflags=-arch arm64 -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}"
    BUILD_COMMAND "${VERSUS_MAKE_EXECUTABLE}" -j4
    INSTALL_COMMAND "${VERSUS_MAKE_EXECUTABLE}" install
    BUILD_BYPRODUCTS "${VERSUS_X264_PREFIX}/lib/libx264.a")
# x264's makefile does not track compiler/assembler flag changes as object
# dependencies. A changed configure step must discard the previous objects.
ExternalProject_Add_Step(versus-x264-build clean-configured
    COMMAND "${VERSUS_MAKE_EXECUTABLE}" clean
    WORKING_DIRECTORY <BINARY_DIR>
    DEPENDEES configure DEPENDERS build)
ExternalProject_Get_Property(versus-x264-build SOURCE_DIR)
set(VERSUS_X264_SOURCE_DIR "${SOURCE_DIR}")
add_library(versus-x264 STATIC IMPORTED GLOBAL)
set_target_properties(versus-x264 PROPERTIES
    IMPORTED_LOCATION "${VERSUS_X264_PREFIX}/lib/libx264.a"
    INTERFACE_INCLUDE_DIRECTORIES "${VERSUS_X264_PREFIX}/include")
add_dependencies(versus-x264 versus-x264-build)
