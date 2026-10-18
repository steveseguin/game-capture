set(VERSUS_MAC_SYPHON_ROOT "${CMAKE_CURRENT_LIST_DIR}/../build-macos-deps/syphon-f4761677a45b8034a3c2069ec0f3d2553da81fba"
    CACHE PATH "Pinned Syphon framework prefix built by build-syphon-macos.cmake")
get_filename_component(VERSUS_MAC_SYPHON_ROOT "${VERSUS_MAC_SYPHON_ROOT}" ABSOLUTE)
if(NOT EXISTS "${VERSUS_MAC_SYPHON_ROOT}/Frameworks/Syphon.framework/Syphon")
    message(FATAL_ERROR "Build the Mac Syphon dependency first: cmake -P cmake/build-syphon-macos.cmake")
endif()
add_library(versus-syphon INTERFACE)
target_compile_options(versus-syphon INTERFACE "-F${VERSUS_MAC_SYPHON_ROOT}/Frameworks")
target_link_libraries(versus-syphon INTERFACE "${VERSUS_MAC_SYPHON_ROOT}/Frameworks/Syphon.framework" "-framework Metal")
