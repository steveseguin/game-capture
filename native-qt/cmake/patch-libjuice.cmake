# Backport libjuice f68639a7fa272acfaa4a246d29957d94bef670ae and close the
# same registry mutex on initialization failure. The pinned source remains
# MPL-2.0; this script is the complete, reproducible source modification.
# https://github.com/paullouisageneau/libjuice/commit/f68639a7fa272acfaa4a246d29957d94bef670ae
function(game_capture_patch_libjuice source_dir)
    set(path "${source_dir}/deps/libjuice/src/conn.c")
    file(READ "${path}" source)
    string(REPLACE "\r\n" "\n" source "${source}")
    string(SHA256 digest "${source}")
    set(original "1e20e6267ac274360b496449a9ab5bd443608075756278ef8aeb6faf60d5c170")
    set(patched "d66099730120c132eb8c5e0477a689a24c7626bcf0e9ba75a29d79b4eee44608")
    if(digest STREQUAL patched)
        return()
    endif()
    if(NOT digest STREQUAL original)
        message(FATAL_ERROR "libjuice conn.c differs from the pinned source; review the registry mutex backport before updating the dependency")
    endif()
    string(REPLACE
        "\t\t\tmutex_unlock(&registry->mutex);\n\t\t\tfree(registry->agents);"
        "\t\t\tmutex_unlock(&registry->mutex);\n\t\t\tmutex_destroy(&registry->mutex);\n\t\t\tfree(registry->agents);"
        source "${source}")
    string(REPLACE
        "\t\tentry->registry = NULL;\n\t\tfree(registry->agents);"
        "\t\tentry->registry = NULL;\n\t\tmutex_destroy(&registry->mutex);\n\t\tfree(registry->agents);"
        source "${source}")
    string(SHA256 digest "${source}")
    if(NOT digest STREQUAL patched)
        message(FATAL_ERROR "libjuice registry mutex backport did not produce the expected source")
    endif()
    file(WRITE "${path}" "${source}")
    message(STATUS "Applied libjuice registry mutex cleanup backport")
endfunction()
