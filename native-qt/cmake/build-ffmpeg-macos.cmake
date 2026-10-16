# Isolated arm64 mux/codec helper; never changes the Windows dependency bundle.
# Requires CMake, Ninja, pkg-config and Meson (e.g. an isolated build-tools venv).
cmake_minimum_required(VERSION 3.24)
if(NOT CMAKE_HOST_APPLE)
    message(FATAL_ERROR "Build this dependency on macOS")
endif()
if(NOT DEFINED FFMPEG_WORK_DIR)
    get_filename_component(FFMPEG_WORK_DIR "${CMAKE_CURRENT_LIST_DIR}/../build-macos-deps" ABSOLUTE)
endif()
if(NOT DEFINED FFMPEG_SDK)
    execute_process(COMMAND xcrun --sdk macosx --show-sdk-path OUTPUT_VARIABLE FFMPEG_SDK
        OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
endif()
if(NOT DEFINED FFMPEG_BUILD_JOBS)
    set(FFMPEG_BUILD_JOBS 4)
endif()
find_program(ffmpeg_ninja ninja REQUIRED)
find_program(ffmpeg_pkgconfig pkg-config REQUIRED)
find_program(ffmpeg_meson meson HINTS "${FFMPEG_WORK_DIR}/build-tools/bin" REQUIRED)
set(deps "${FFMPEG_WORK_DIR}/ffmpeg-deps")
set(prefix "${FFMPEG_WORK_DIR}/ffmpeg-9.0.2-install")
set(sources "")
function(source name url sha directory)
    set(archive "${FFMPEG_WORK_DIR}/downloads/${name}")
    if(EXISTS "${archive}")
        file(SHA256 "${archive}" actual)
        if(NOT actual STREQUAL sha)
            message(FATAL_ERROR "Unexpected cached source hash: ${name}")
        endif()
    else()
        file(DOWNLOAD "${url}" "${archive}" EXPECTED_HASH "SHA256=${sha}" TLS_VERIFY ON SHOW_PROGRESS)
    endif()
    if(NOT IS_DIRECTORY "${FFMPEG_WORK_DIR}/${directory}")
        file(ARCHIVE_EXTRACT INPUT "${archive}" DESTINATION "${FFMPEG_WORK_DIR}")
    endif()
    set(sources "${sources}${name}\nURL: ${url}\nSHA-256: ${sha}\n\n" PARENT_SCOPE)
endfunction()
file(MAKE_DIRECTORY "${FFMPEG_WORK_DIR}/downloads" "${deps}" "${prefix}")
source(ffmpeg-9.0.2.tar.xz https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
    8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e ffmpeg-9.0.2)
source(openssl-3.5.9.tar.gz https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz
    603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a openssl-3.5.9)
source(srt-1.5.4.tar.gz https://codeload.github.com/Haivision/srt/tar.gz/refs/tags/v1.5.4
    d0a8b600fe1b4eaaf6277530e3cfc8f15b8ce4035f16af4a5eb5d4b123640cdd srt-1.5.4)
source(librist-0.2.20.tar.gz https://code.videolan.org/rist/librist/-/archive/v0.2.20/librist-v0.2.20.tar.gz
    9e40eeb87f014790531ad41326cc271b930a65962e4b15231b301fc59b29fe31 librist-v0.2.20)
source(libvpx-1.17.0.tar.gz https://codeload.github.com/webmproject/libvpx/tar.gz/refs/tags/v1.17.0
    1020f184046187baa2985dbde38e0691f49c44088bca7a1842b0236c6081dc0a libvpx-1.17.0)
source(libaom-3.13.3.tar.gz https://storage.googleapis.com/aom-releases/libaom-3.13.3.tar.gz
    446a4ae9741cb8f3eeb98c949d25f91b48cb2b8569cae975c4b737392e9024fc libaom-3.13.3)
set(flags "-arch arm64 -isysroot ${FFMPEG_SDK} -mmacosx-version-min=14.2")
set(env "CC=/usr/bin/clang" "CXX=/usr/bin/clang++" "CFLAGS=${flags}" "CXXFLAGS=${flags}"
    "LDFLAGS=${flags}" "MACOSX_DEPLOYMENT_TARGET=14.2" "PKG_CONFIG_LIBDIR=${deps}/lib/pkgconfig" "PKG_CONFIG_PATH=")
execute_process(COMMAND "${CMAKE_COMMAND}"
    -S "${FFMPEG_WORK_DIR}/libaom-3.13.3" -B "${FFMPEG_WORK_DIR}/libaom-build-3.13.3" -G Ninja
    "-DCMAKE_MAKE_PROGRAM=${ffmpeg_ninja}" -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=${deps}"
    -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.2 "-DCMAKE_OSX_SYSROOT=${FFMPEG_SDK}"
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF
    -DENABLE_TESTS=OFF -DENABLE_EXAMPLES=OFF -DENABLE_TOOLS=OFF -DENABLE_DOCS=OFF
    COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --build "${FFMPEG_WORK_DIR}/libaom-build-3.13.3"
    --parallel "${FFMPEG_BUILD_JOBS}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --install "${FFMPEG_WORK_DIR}/libaom-build-3.13.3" COMMAND_ERROR_IS_FATAL ANY)
set(vpx_build "${FFMPEG_WORK_DIR}/libvpx-build-1.17.0")
file(MAKE_DIRECTORY "${vpx_build}")
execute_process(COMMAND "${CMAKE_COMMAND}" -E env ${env}
    "${FFMPEG_WORK_DIR}/libvpx-1.17.0/configure" "--prefix=${deps}" --target=arm64-darwin23-gcc
    --disable-shared --enable-static --enable-pic --disable-examples --disable-tools
    --disable-docs --disable-unit-tests --disable-vp8 --disable-vp9-highbitdepth
    WORKING_DIRECTORY "${vpx_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/make "-j${FFMPEG_BUILD_JOBS}"
    WORKING_DIRECTORY "${vpx_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/make install
    WORKING_DIRECTORY "${vpx_build}" COMMAND_ERROR_IS_FATAL ANY)
set(ssl_build "${FFMPEG_WORK_DIR}/openssl-build-3.5.9")
file(MAKE_DIRECTORY "${ssl_build}")
execute_process(COMMAND "${CMAKE_COMMAND}" -E env ${env}
    "${FFMPEG_WORK_DIR}/openssl-3.5.9/Configure" darwin64-arm64-cc no-shared no-tests no-apps no-module no-docs
    "--prefix=${deps}" "--openssldir=${deps}/ssl" --libdir=lib
    WORKING_DIRECTORY "${ssl_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/make "-j${FFMPEG_BUILD_JOBS}" build_libs
    WORKING_DIRECTORY "${ssl_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/make install_dev
    WORKING_DIRECTORY "${ssl_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" -E env ${env} "${CMAKE_COMMAND}"
    -S "${FFMPEG_WORK_DIR}/srt-1.5.4" -B "${FFMPEG_WORK_DIR}/srt-build-1.5.4" -G Ninja
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    "-DCMAKE_MAKE_PROGRAM=${ffmpeg_ninja}" -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=${deps}"
    -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.2 "-DCMAKE_OSX_SYSROOT=${FFMPEG_SDK}"
    "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local" "-DOPENSSL_ROOT_DIR=${deps}" -DOPENSSL_USE_STATIC_LIBS=ON
    -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DENABLE_APPS=OFF -DENABLE_TESTING=OFF
    -DENABLE_ENCRYPTION=ON -DUSE_ENCLIB=openssl-evp -DENABLE_CXX_DEPS=ON
    COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --build "${FFMPEG_WORK_DIR}/srt-build-1.5.4" --parallel "${FFMPEG_BUILD_JOBS}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --install "${FFMPEG_WORK_DIR}/srt-build-1.5.4" COMMAND_ERROR_IS_FATAL ANY)
set(native_file "${FFMPEG_WORK_DIR}/ffmpeg-meson-native.ini")
file(WRITE "${native_file}" "[binaries]\nc = '/usr/bin/clang'\ncpp = '/usr/bin/clang++'\nar = '/usr/bin/ar'\npkg-config = '${ffmpeg_pkgconfig}'\n[built-in options]\nc_args = ['-arch', 'arm64', '-isysroot', '${FFMPEG_SDK}', '-mmacosx-version-min=14.2']\nc_link_args = ['-arch', 'arm64', '-isysroot', '${FFMPEG_SDK}', '-mmacosx-version-min=14.2']\npkg_config_path = []\n[properties]\npkg_config_libdir = ['${deps}/lib/pkgconfig']\n")
set(rist_build "${FFMPEG_WORK_DIR}/librist-build-0.2.20")
set(reconfigure "")
if(EXISTS "${rist_build}/meson-private/coredata.dat")
    set(reconfigure --reconfigure)
endif()
execute_process(COMMAND "${CMAKE_COMMAND}" -E env ${env} "${ffmpeg_meson}" setup ${reconfigure}
    "${rist_build}" "${FFMPEG_WORK_DIR}/librist-v0.2.20" "--native-file=${native_file}" "--prefix=${deps}"
    --buildtype=release --default-library=static -Dtest=false -Dbuilt_tools=false
    -Dbuiltin_lz4=true -Dbuiltin_cjson=true -Dbuiltin_mbedtls=true -Duse_mbedtls=true
    COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${ffmpeg_meson}" compile -C "${rist_build}" "-j${FFMPEG_BUILD_JOBS}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${ffmpeg_meson}" install -C "${rist_build}" COMMAND_ERROR_IS_FATAL ANY)
set(ff_build "${FFMPEG_WORK_DIR}/ffmpeg-build-9.0.2")
file(MAKE_DIRECTORY "${ff_build}")
execute_process(COMMAND "${CMAKE_COMMAND}" -E env ${env}
    "${FFMPEG_WORK_DIR}/ffmpeg-9.0.2/configure" "--prefix=${prefix}" --arch=aarch64 --target-os=darwin
    --cc=/usr/bin/clang --cxx=/usr/bin/clang++ "--sysroot=${FFMPEG_SDK}"
    "--extra-cflags=${flags}" "--extra-cxxflags=${flags}" "--extra-ldflags=${flags}" --extra-libs=-lc++
    "--pkg-config=${ffmpeg_pkgconfig}" --pkg-config-flags=--static
    --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay
    --enable-version3 --enable-securetransport --enable-libsrt --enable-librist --enable-libvpx --enable-libaom
    WORKING_DIRECTORY "${ff_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/make "-j${FFMPEG_BUILD_JOBS}"
    WORKING_DIRECTORY "${ff_build}" COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/make install
    WORKING_DIRECTORY "${ff_build}" COMMAND_ERROR_IS_FATAL ANY)
set(provenance "${prefix}/share/game-capture-ffmpeg")
file(MAKE_DIRECTORY "${provenance}")
configure_file("${CMAKE_CURRENT_LIST_FILE}" "${provenance}/build-ffmpeg-macos.cmake" COPYONLY)
file(WRITE "${provenance}/sources.txt" "${sources}Architecture: arm64\nMinimum macOS: 14.2\nSDK: ${FFMPEG_SDK}\nlibrist uses its bundled cJSON, LZ4 and Mbed TLS sources.\nTLS uses Apple's Secure Transport; OpenSSL is linked for SRT encryption.\nThis development provenance is not a complete release corresponding-source distribution.\n")
file(COPY "${FFMPEG_WORK_DIR}/ffmpeg-9.0.2/LICENSE.md" "${FFMPEG_WORK_DIR}/ffmpeg-9.0.2/COPYING.LGPLv3"
    "${FFMPEG_WORK_DIR}/ffmpeg-9.0.2/COPYING.GPLv3" DESTINATION "${provenance}/FFmpeg")
file(COPY "${FFMPEG_WORK_DIR}/openssl-3.5.9/LICENSE.txt" DESTINATION "${provenance}/OpenSSL")
file(COPY "${FFMPEG_WORK_DIR}/srt-1.5.4/LICENSE" DESTINATION "${provenance}/SRT")
file(COPY "${FFMPEG_WORK_DIR}/libvpx-1.17.0/LICENSE" "${FFMPEG_WORK_DIR}/libvpx-1.17.0/PATENTS"
    "${FFMPEG_WORK_DIR}/libvpx-1.17.0/AUTHORS" DESTINATION "${provenance}/libvpx")
file(COPY "${FFMPEG_WORK_DIR}/libaom-3.13.3/LICENSE" "${FFMPEG_WORK_DIR}/libaom-3.13.3/PATENTS"
    "${FFMPEG_WORK_DIR}/libaom-3.13.3/AUTHORS" DESTINATION "${provenance}/libaom")
file(COPY "${FFMPEG_WORK_DIR}/librist-v0.2.20/COPYING" DESTINATION "${provenance}/librist")
# Preserve the component notices embedded in librist's bundled source files.
file(COPY "${FFMPEG_WORK_DIR}/librist-v0.2.20/contrib/mbedtls/LICENSE" DESTINATION "${provenance}/librist/MbedTLS")
file(COPY "${FFMPEG_WORK_DIR}/librist-v0.2.20/contrib/contrib_cJSON/"
    DESTINATION "${provenance}/librist/cJSON" FILES_MATCHING PATTERN "*.h" PATTERN "*.c")
file(COPY "${FFMPEG_WORK_DIR}/librist-v0.2.20/contrib/lz4/"
    DESTINATION "${provenance}/librist/LZ4" FILES_MATCHING PATTERN "*.h" PATTERN "*.c")
file(GLOB contrib_notices "${FFMPEG_WORK_DIR}/librist-v0.2.20/contrib/*.c" "${FFMPEG_WORK_DIR}/librist-v0.2.20/contrib/*.h")
file(COPY ${contrib_notices} DESTINATION "${provenance}/librist/contrib")
message(STATUS "Mac FFmpeg helper installed at ${prefix}")
