#!/bin/sh
# Run on the oldest supported Linux userland, independently for each architecture.
set -eu
prefix=${1:?Usage: build-portable-ffmpeg.sh ABSOLUTE_PREFIX [JOBS]}
jobs=${2:-2}
case "$prefix" in /*) ;; *) echo 'Prefix must be absolute' >&2; exit 1;; esac
version=6.1.6
digest=d4fcb164028dd3beee5d92c0ac72e46aac6973c75ea12dc14de07bf8f407370a
mkdir -p "$prefix/source"
cd "$prefix/source"
# Reuse the reviewed Mac dependency pin for RIST; Ubuntu 22.04 has no librist-dev.
rist=librist-v0.2.20
if [ ! -f "$rist.tar.gz" ]; then
    curl --fail --location --retry 3 "https://code.videolan.org/rist/librist/-/archive/v0.2.20/$rist.tar.gz" -o "$rist.tar.gz"
fi
printf '%s  %s\n' 9e40eeb87f014790531ad41326cc271b930a65962e4b15231b301fc59b29fe31 "$rist.tar.gz" | sha256sum --check -
if [ ! -d "$rist" ]; then tar -xf "$rist.tar.gz"; fi
if [ ! -d "$prefix/rist-build" ]; then
    meson setup "$prefix/rist-build" "$rist" --prefix="$prefix" --libdir=lib \
        --buildtype=release --default-library=shared -Dtest=false -Dbuilt_tools=false \
        -Dbuiltin_lz4=true -Dbuiltin_cjson=true -Dbuiltin_mbedtls=true -Duse_mbedtls=true
fi
meson compile -C "$prefix/rist-build" -j "$jobs"
meson install -C "$prefix/rist-build"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
archive=ffmpeg-$version.tar.xz
if [ ! -f "$archive" ]; then
    curl --fail --location --retry 3 "https://ffmpeg.org/releases/$archive" -o "$archive"
fi
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check -
if [ ! -d "ffmpeg-$version" ]; then tar -xf "$archive"; fi
cd "ffmpeg-$version"
./configure --prefix="$prefix" --enable-shared --disable-static \
    --disable-debug --disable-doc --disable-ffplay --disable-autodetect \
    --enable-gpl --enable-version3 --enable-libx264 --enable-libx265 \
    --enable-libvpx --enable-libaom --enable-libopus --enable-libsrt \
    --enable-librist --enable-openssl --enable-zlib
make -j "$jobs"
make install
