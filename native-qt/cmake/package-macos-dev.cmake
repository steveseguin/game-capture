if(NOT EXISTS "${APP_BUNDLE}/Contents/MacOS/game-capture" OR NOT EXISTS "${MACDEPLOYQT}")
    message(FATAL_ERROR "A built application and macdeployqt are required")
endif()
if(NOT EXISTS "${FFMPEG_PREFIX}/bin/ffmpeg" OR NOT EXISTS "${FFMPEG_PREFIX}/share/game-capture-ffmpeg/sources.txt")
    message(FATAL_ERROR "Build the pinned Mac FFmpeg helper with cmake/build-ffmpeg-macos.cmake before packaging")
endif()

if(NOT EXISTS "${SYPHON_PREFIX}/Frameworks/Syphon.framework/Syphon" OR
   NOT EXISTS "${SYPHON_PREFIX}/share/game-capture-syphon/source.txt")
    message(FATAL_ERROR "Build the pinned Syphon framework before packaging")
endif()

set(staged_app "${PACKAGE_DIR}/Game Capture.app")
if(staged_app STREQUAL APP_BUNDLE)
    message(FATAL_ERROR "Packaging destination must differ from the build bundle")
endif()
file(MAKE_DIRECTORY "${PACKAGE_DIR}")
file(REMOVE_RECURSE "${staged_app}")
execute_process(COMMAND /usr/bin/ditto "${APP_BUNDLE}" "${staged_app}"
    COMMAND_ERROR_IS_FATAL ANY)
set(license_dir "${staged_app}/Contents/Resources/licenses")
file(MAKE_DIRECTORY "${license_dir}")
file(MAKE_DIRECTORY "${staged_app}/Contents/Frameworks")
execute_process(COMMAND /usr/bin/ditto "${SYPHON_PREFIX}/Frameworks/Syphon.framework"
    "${staged_app}/Contents/Frameworks/Syphon.framework" COMMAND_ERROR_IS_FATAL ANY)
file(COPY "${SYPHON_PREFIX}/share/game-capture-syphon/" DESTINATION "${license_dir}/Syphon")
file(MAKE_DIRECTORY "${staged_app}/Contents/Helpers")
file(COPY "${FFMPEG_PREFIX}/bin/ffmpeg" DESTINATION "${staged_app}/Contents/Helpers")
file(COPY "${FFMPEG_PREFIX}/share/game-capture-ffmpeg/" DESTINATION "${license_dir}/FFmpeg")
execute_process(COMMAND /usr/bin/codesign --force --sign - "${staged_app}/Contents/Helpers/ffmpeg"
    COMMAND_ERROR_IS_FATAL ANY)
if(IS_DIRECTORY "${QT_PROVENANCE_DIR}")
    file(COPY "${QT_PROVENANCE_DIR}/" DESTINATION "${license_dir}/Qt")
endif()
configure_file("${REPOSITORY_DIR}/LICENSE" "${license_dir}/Game-Capture-AGPL-3.0.txt" COPYONLY)
configure_file("${X264_SOURCE_DIR}/COPYING" "${license_dir}/x264-GPL-2.0-or-later.txt" COPYONLY)
configure_file("${X264_SOURCE_DIR}/x264.h" "${license_dir}/x264-public-header.h" COPYONLY)
file(WRITE "${license_dir}/x264-source.txt"
    "x264 source: https://code.videolan.org/videolan/x264.git\nRevision: b35605ace3ddf7c1a5d67a2eb553f034aef41d55\nBuild recipe: native-qt/cmake/x264-macos.cmake in the matching Game Capture source.\nGPL version 2 or later; combined with this application using its GPLv3 option.\nThis local development bundle is not a release/source distribution.\n")
set(notice_args "")
foreach(component IN LISTS NOTICE_COMPONENTS)
    list(APPEND notice_args --component "${component}")
endforeach()
execute_process(COMMAND "${PYTHON_EXECUTABLE}" "${REPOSITORY_DIR}/native-qt/qa/collect-macos-notices.py"
    ${notice_args} --qt-source "${QT_SOURCE_DIR}" --qt-version "${QT_VERSION}"
    --output "${license_dir}/NativeDependencies"
    COMMAND_ERROR_IS_FATAL ANY)
# Homebrew Qt can mix absolute framework names in the executable with @rpath
# names in plugins. Normalize the staged executable so macdeployqt carries the
# Qt search path into plugin deployment as well. Never modify installed Qt.
set(staged_binary "${staged_app}/Contents/MacOS/game-capture")
execute_process(COMMAND /usr/bin/otool -L "${staged_binary}"
    OUTPUT_VARIABLE linked_libraries COMMAND_ERROR_IS_FATAL ANY)
string(REGEX MATCHALL "/[^\n]+/Qt[^/ \n]+\\.framework/Versions/[^/ \n]+/[^ \n]+" qt_frameworks "${linked_libraries}")
foreach(framework IN LISTS qt_frameworks)
    string(REGEX REPLACE "^.+/(Qt[^/]+\\.framework/.*)$" "@rpath/\\1" relative_framework "${framework}")
    execute_process(COMMAND /usr/bin/install_name_tool -change "${framework}" "${relative_framework}" "${staged_binary}"
        COMMAND_ERROR_IS_FATAL ANY)
endforeach()
# Remove build-machine search paths from the copied executable. macdeployqt
# replaces the temporary Qt path below with its bundle-relative framework path.
execute_process(COMMAND /usr/bin/otool -l "${staged_binary}"
    OUTPUT_VARIABLE load_commands COMMAND_ERROR_IS_FATAL ANY)
string(REGEX MATCHALL "path /[^\n]+ \\(offset [0-9]+\\)" absolute_rpaths "${load_commands}")
foreach(rpath IN LISTS absolute_rpaths)
    string(REGEX REPLACE "^path (.*) \\(offset [0-9]+\\)$" "\\1" rpath "${rpath}")
    execute_process(COMMAND /usr/bin/install_name_tool -delete_rpath "${rpath}" "${staged_binary}"
        COMMAND_ERROR_IS_FATAL ANY)
endforeach()
# Syphon is already copied; make its bundle-relative location resolvable by deployment.
execute_process(COMMAND /usr/bin/install_name_tool -add_rpath "@executable_path/../Frameworks" "${staged_binary}"
    COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND /usr/bin/install_name_tool -add_rpath "${QT_LIB_DIR}" "${staged_binary}"
    COMMAND_ERROR_IS_FATAL ANY)
# Deployment changes Mach-O load commands, invalidating linker signatures.
# Ad-hoc signing permits local arm64 execution; it is not distribution signing.
execute_process(COMMAND "${MACDEPLOYQT}" "${staged_app}" -always-overwrite "-libpath=${QT_LIB_DIR}" "-libpath=${SYPHON_PREFIX}/Frameworks" -codesign=-
    OUTPUT_VARIABLE deploy_output ERROR_VARIABLE deploy_error
    COMMAND_ERROR_IS_FATAL ANY)
# macdeployqt can report unresolved dependencies while returning success.
if("${deploy_output}\n${deploy_error}" MATCHES "ERROR:")
    message(FATAL_ERROR "Qt deployment failed:\n${deploy_output}\n${deploy_error}")
endif()
execute_process(COMMAND /usr/bin/codesign --verify --deep --strict "${staged_app}"
    COMMAND_ERROR_IS_FATAL ANY)
message(STATUS "Development bundle: ${staged_app}")
message(STATUS "Development use only: not signed for distribution or notarized. Mac media qualification is incomplete.")
