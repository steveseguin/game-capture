# Isolated, reproducible Qt dependency for the arm64 Mac application.
# cmake -DQT_SDK=/path/MacOSX.sdk -P native-qt/cmake/build-qt-macos.cmake
cmake_minimum_required(VERSION 3.24)
if(NOT CMAKE_HOST_APPLE)
    message(FATAL_ERROR "Build this dependency on macOS")
endif()
if(NOT DEFINED QT_WORK_DIR)
    get_filename_component(QT_WORK_DIR "${CMAKE_CURRENT_LIST_DIR}/../build-macos-deps" ABSOLUTE)
endif()
# Qt rejects source/build paths containing symlinks. macOS /tmp and /var are
# common aliases, including when rebuilding an extracted source distribution.
file(MAKE_DIRECTORY "${QT_WORK_DIR}")
file(REAL_PATH "${QT_WORK_DIR}" QT_WORK_DIR)
if(NOT DEFINED QT_SDK)
    execute_process(COMMAND xcrun --sdk macosx --show-sdk-path
        OUTPUT_VARIABLE QT_SDK OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
endif()
if(NOT DEFINED QT_BUILD_JOBS)
    set(QT_BUILD_JOBS 4)
endif()
set(qt_version 6.9.3)
set(qt_archive "qtbase-everywhere-src-${qt_version}.tar.xz")
set(qt_sha256 c5a1a2f660356ec081febfa782998ae5ddbc5925117e64f50e4be9cd45b8dc6e)
set(qt_source "${QT_WORK_DIR}/qtbase-everywhere-src-${qt_version}")
set(qt_build "${QT_WORK_DIR}/qtbase-build-${qt_version}")
set(qt_prefix "${QT_WORK_DIR}/qt-${qt_version}")
file(MAKE_DIRECTORY "${QT_WORK_DIR}/downloads")
if(EXISTS "${QT_WORK_DIR}/downloads/${qt_archive}")
    file(SHA256 "${QT_WORK_DIR}/downloads/${qt_archive}" cached_qt_sha256)
    if(NOT cached_qt_sha256 STREQUAL qt_sha256)
        message(FATAL_ERROR "Unexpected cached Qt source hash")
    endif()
else()
    file(DOWNLOAD "https://download.qt.io/archive/qt/6.9/${qt_version}/submodules/${qt_archive}"
        "${QT_WORK_DIR}/downloads/${qt_archive}"
        EXPECTED_HASH "SHA256=${qt_sha256}" TLS_VERIFY ON SHOW_PROGRESS)
endif()
if(NOT EXISTS "${qt_source}/CMakeLists.txt")
    file(ARCHIVE_EXTRACT INPUT "${QT_WORK_DIR}/downloads/${qt_archive}" DESTINATION "${QT_WORK_DIR}")
endif()
# Backport Qt's AppleClang 21 intrinsic-order fix (QTBUG-145239). Keep both
# hashes explicit so a rerun is safe and an unexpected source never gets patched.
set(yield_header "${qt_source}/src/corelib/thread/qyieldcpu.h")
set(yield_original 1e7e609f6e1b88051349c8aa804cc56cfcdaa7b6d07e4ce5755c316229e33412)
set(yield_patched 51ab9a7df6bb28bf7625774506697cc3503e7002b0b73cf638d18978ae84a920)
file(SHA256 "${yield_header}" yield_hash)
if(yield_hash STREQUAL yield_original)
    execute_process(COMMAND /usr/bin/patch -p1 -i "${CMAKE_CURRENT_LIST_DIR}/qt-macos-clang21.patch"
        WORKING_DIRECTORY "${qt_source}" COMMAND_ERROR_IS_FATAL ANY)
    file(SHA256 "${yield_header}" yield_hash)
endif()
if(NOT yield_hash STREQUAL yield_patched)
    message(FATAL_ERROR "Unexpected Qt qyieldcpu.h; refusing to continue")
endif()
# QListWidget items expose toggleAction as AXPress, but Qt 6.9.3 maps that
# action back to pressAction, which QAccessibleTableCell does not implement.
# Preserve the advertised list-item action for VoiceOver/AX source selection.
set(accessibility_source "${qt_source}/src/plugins/platforms/cocoa/qcocoaaccessibility.mm")
set(accessibility_original 53474d600ac222492d3d467e6ea24d157ebaf6f18ada9866f23ce06df602af9b)
set(accessibility_patched 2eb0a4ec4d02d57e555e42cd92bc2d31f4477a3862f99774b14bc33fd11bba4f)
file(SHA256 "${accessibility_source}" accessibility_hash)
if(accessibility_hash STREQUAL accessibility_original)
    execute_process(COMMAND /usr/bin/patch -p1 -i "${CMAKE_CURRENT_LIST_DIR}/qt-macos-accessibility.patch"
        WORKING_DIRECTORY "${qt_source}" COMMAND_ERROR_IS_FATAL ANY)
    file(SHA256 "${accessibility_source}" accessibility_hash)
endif()
if(NOT accessibility_hash STREQUAL accessibility_patched)
    message(FATAL_ERROR "Unexpected Qt qcocoaaccessibility.mm; refusing to continue")
endif()
# A combo popup's AXPress must commit the selected row and close the popup.
# Qt already implements this for Android; enable that same path only on macOS.
set(combo_items "${qt_source}/src/widgets/accessible/itemviews.cpp")
set(combo_widgets "${qt_source}/src/widgets/accessible/complexwidgets.cpp")
file(SHA256 "${combo_items}" combo_items_hash)
file(SHA256 "${combo_widgets}" combo_widgets_hash)
if(combo_items_hash STREQUAL "f576196ee5dcf82e5daf692edc04309043a9f39483aaff4f8aeda851007f3921" AND
   combo_widgets_hash STREQUAL "08757913e8dd5707fe4553c33a5b01a075ec38d5587be7be06138e3305e4e760")
    execute_process(COMMAND /usr/bin/patch -p1 -i "${CMAKE_CURRENT_LIST_DIR}/qt-macos-combobox-accessibility.patch"
        WORKING_DIRECTORY "${qt_source}" COMMAND_ERROR_IS_FATAL ANY)
    file(SHA256 "${combo_items}" combo_items_hash)
    file(SHA256 "${combo_widgets}" combo_widgets_hash)
endif()
if(NOT combo_items_hash STREQUAL "0fc009d6a703b65e16b39b1f919e510385012b19e6dce4b93b12614d9adc7596" OR
   NOT combo_widgets_hash STREQUAL "1cf6d9889b563b630ac7fba76222ff0a6c1eb4b3020ca06c7920668343705ff0")
    message(FATAL_ERROR "Unexpected Qt combo accessibility sources; refusing to continue")
endif()
# QSpinBox/QDoubleSpinBox expose singleStep, not stepSize. Without it Cocoa
# derives a coarse AX increment from the numeric range (51 for 6..510 kbps).
# Keep the correction local to this pinned Mac Qt dependency.
set(spin_accessibility "${qt_source}/src/widgets/accessible/rangecontrols.cpp")
file(SHA256 "${spin_accessibility}" spin_accessibility_hash)
if(spin_accessibility_hash STREQUAL "fa5f3fc2af5215df55074ea4cad6e18fa8101df7cbd64d15d7dd300b19c964ac")
    execute_process(COMMAND /usr/bin/patch -p1 -i "${CMAKE_CURRENT_LIST_DIR}/qt-macos-spinbox-accessibility.patch"
        WORKING_DIRECTORY "${qt_source}" COMMAND_ERROR_IS_FATAL ANY)
    file(SHA256 "${spin_accessibility}" spin_accessibility_hash)
endif()
if(NOT spin_accessibility_hash STREQUAL "06b1ed70ea74b7434be55748e71f03d397714a524bee328b50b894d66056c953")
    message(FATAL_ERROR "Unexpected Qt spin accessibility source; refusing to continue")
endif()
find_program(qt_ninja ninja REQUIRED)
# Build tools may come from Homebrew; runtime dependencies must not. Use Qt's
# bundled third-party code and Apple's frameworks, with no optional SQL/print
# plugins pulling in local libraries. These switches affect only this Qt build.
execute_process(COMMAND "${CMAKE_COMMAND}" -S "${qt_source}" -B "${qt_build}" -G Ninja
    "-DCMAKE_MAKE_PROGRAM=${qt_ninja}"
    -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=${qt_prefix}"
    -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.2
    "-DCMAKE_OSX_SYSROOT=${QT_SDK}"
    "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local"
    -DQT_BUILD_TESTS=OFF -DQT_BUILD_EXAMPLES=OFF
    -DFEATURE_sql=OFF -DFEATURE_printsupport=OFF -DFEATURE_dbus=OFF
    -DFEATURE_icu=OFF -DFEATURE_glib=OFF -DFEATURE_openssl=OFF
    -DFEATURE_securetransport=ON -DFEATURE_brotli=OFF -DFEATURE_zstd=OFF
    -DFEATURE_system_zlib=OFF -DFEATURE_system_png=OFF
    -DFEATURE_system_jpeg=OFF -DFEATURE_system_pcre2=OFF
    -DFEATURE_system_harfbuzz=OFF -DFEATURE_system_freetype=OFF
    -DFEATURE_system_doubleconversion=OFF
    COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --build "${qt_build}" --parallel "${QT_BUILD_JOBS}"
    COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --install "${qt_build}"
    COMMAND_ERROR_IS_FATAL ANY)
set(qt_provenance "${qt_prefix}/share/game-capture-qt")
file(MAKE_DIRECTORY "${qt_provenance}")
file(COPY "${qt_source}/LICENSES" DESTINATION "${qt_provenance}")
configure_file("${CMAKE_CURRENT_LIST_FILE}" "${qt_provenance}/build-qt-macos.cmake" COPYONLY)
configure_file("${CMAKE_CURRENT_LIST_DIR}/qt-macos-clang21.patch" "${qt_provenance}/qt-macos-clang21.patch" COPYONLY)
configure_file("${CMAKE_CURRENT_LIST_DIR}/qt-macos-accessibility.patch" "${qt_provenance}/qt-macos-accessibility.patch" COPYONLY)
configure_file("${CMAKE_CURRENT_LIST_DIR}/qt-macos-combobox-accessibility.patch" "${qt_provenance}/qt-macos-combobox-accessibility.patch" COPYONLY)
configure_file("${CMAKE_CURRENT_LIST_DIR}/qt-macos-spinbox-accessibility.patch" "${qt_provenance}/qt-macos-spinbox-accessibility.patch" COPYONLY)
file(WRITE "${qt_provenance}/source.txt"
    "Qt Base ${qt_version}\nSource: https://download.qt.io/archive/qt/6.9/${qt_version}/submodules/${qt_archive}\nSHA-256: ${qt_sha256}\nLocal patch: qt-macos-clang21.patch, upstream a76004f16fdc43e1b7af83bfdf3f1a613491b234\nLocal patch: qt-macos-accessibility.patch, preserve ListItem AXPress/toggle mapping\nLocal patch: qt-macos-combobox-accessibility.patch, commit Mac combo selection through AXPress\nLocal patch: qt-macos-spinbox-accessibility.patch, use the actual Mac spin-box single step\nSDK: ${QT_SDK}\nArchitecture: arm64\nMinimum OS: 14.2\nRecipe: build-qt-macos.cmake\nThe LICENSES directory contains Qt Base's source license inventory.\nThis development provenance is not a complete release corresponding-source/third-party-notice distribution.\n")
message(STATUS "Qt dependency installed at ${qt_prefix}")
