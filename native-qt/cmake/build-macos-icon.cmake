# Package the existing application artwork at the standard macOS icon sizes.
# No image-generation service, third-party conversion dependency or new artwork.
if(NOT APPLE OR NOT EXISTS "${ICON_SOURCE}" OR NOT IS_ABSOLUTE "${ICON_OUTPUT}")
    message(FATAL_ERROR "A macOS host, source artwork and absolute ICON_OUTPUT are required")
endif()
get_filename_component(icon_directory "${ICON_OUTPUT}" DIRECTORY)
set(iconset "${icon_directory}/GameCapture.iconset")
file(MAKE_DIRECTORY "${iconset}")
foreach(size IN ITEMS 16 32 128 256 512)
    foreach(scale IN ITEMS 1 2)
        math(EXPR pixels "${size} * ${scale}")
        if(scale EQUAL 2)
            set(suffix "@2x")
        else()
            set(suffix "")
        endif()
        execute_process(COMMAND /usr/bin/sips -z "${pixels}" "${pixels}" "${ICON_SOURCE}"
            --out "${iconset}/icon_${size}x${size}${suffix}.png"
            OUTPUT_QUIET COMMAND_ERROR_IS_FATAL ANY)
    endforeach()
endforeach()
execute_process(COMMAND /usr/bin/iconutil --convert icns --output "${ICON_OUTPUT}" "${iconset}"
    COMMAND_ERROR_IS_FATAL ANY)
