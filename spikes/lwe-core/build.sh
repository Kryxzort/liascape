#!/usr/bin/env bash
# Spike (throwaway): build linux-wallpaperengine `next-v2` core library + our offscreen host.
#
#   bash spikes/lwe-core/build.sh            # checkout (if needed) + build core + build host
#   bash spikes/lwe-core/build.sh host       # rebuild only the host
#
# Runs itself inside the repo flake devShell with the stray LD_LIBRARY_PATH removed (see
# .superpowers global constraints). Libraries the devShell lacks are resolved ad hoc from the
# repo flake's *locked* nixpkgs (`--inputs-from`), so their glibc matches the devShell's gcc.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LWE_URL="https://github.com/Almamu/linux-wallpaperengine"
LWE_REV="ddea3b493d2f4cca78a2e9547c4e61b92a14e0fc" # next-v2 head, 2026-08-03 "chore: formatting"

if [[ "${LIASCAPE_SPIKE_INNER:-}" != 1 ]]; then
    exec env -u LD_LIBRARY_PATH LIASCAPE_SPIKE_INNER=1 nix develop "$REPO" -c bash "$0" "$@"
fi

LWE="$HERE/lwe"
BUILD="$HERE/build"
mkdir -p "$BUILD"

# ---- ad hoc packages not in the devShell (devShell already has gcc 15, make, pkg-config,
#      ffmpeg-dev 8.1.2, mpv 0.41 (libmpv), libglvnd-dev via pkg-config only, libpulse-dev).
#      libGL (libglvnd) is repeated here because CMake FindOpenGL needs it on CMAKE_PREFIX_PATH. ----
# gmpxx.dev: undeclared — core/Render/FBOProvider.cpp has a stray `#include <gmpxx.h>` (nothing from gmp is used)
EXTRA=(cmake SDL2.dev SDL2 freetype.dev freetype glm lz4.dev lz4 zlib.dev zlib libGL.dev libGL gmpxx.dev)
mapfile -t EXTRA_PATHS < <(nix build --inputs-from "$REPO" --no-link --print-out-paths "${EXTRA[@]/#/nixpkgs#}")
for p in "${EXTRA_PATHS[@]}"; do
    [[ -d "$p/bin" ]] && PATH="$p/bin:$PATH"
    # some LWE targets (common-object: glm) rely on the compiler's default include path
    [[ -d "$p/include" ]] && CPATH="$p/include${CPATH:+:$CPATH}"
    CMAKE_PREFIX_PATH="$p${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
    for pc in "$p/lib/pkgconfig" "$p/share/pkgconfig"; do
        [[ -d "$pc" ]] && PKG_CONFIG_PATH="$pc${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    done
done
export PATH CPATH CMAKE_PREFIX_PATH PKG_CONFIG_PATH

if [[ "${1:-}" != host ]]; then
    # ---- 1) upstream checkout ----
    if [[ ! -d "$LWE/.git" ]]; then
        git clone "$LWE_URL" "$LWE"
    fi
    if ! git -C "$LWE" cat-file -e "$LWE_REV^{commit}" 2>/dev/null; then
        git -C "$LWE" fetch origin next-v2
    fi
    git -C "$LWE" checkout -q "$LWE_REV"
    git -C "$LWE" submodule update --init --recursive

    # ---- 2) core library only (no CEF/webhelper, no frontend, no dev-viewer, no tests) ----
    cmake -S "$LWE" -B "$BUILD/lwe" \
        -DCMAKE_BUILD_TYPE=Release \
        -DWPBUILD_CORE=ON \
        -DWPBUILD_WEBHELPER=OFF \
        -DWPBUILD_FRONTEND=OFF \
        -DWPBUILD_DEVVIEWER=OFF \
        -DWPBUILD_TESTS=OFF
    # Build the core *target* only: the dev-viewer/webhelper OBJECT libraries are declared before
    # their option gate and would otherwise be compiled by `all` (they need GLFW/CEF headers).
    cmake --build "$BUILD/lwe" --target linux-wallpaperengine-core -j"$(nproc)"
fi

# ---- 3) our host ----
g++ -std=c++20 -O2 -g -Wall -Wno-unused-function \
    -I"$LWE/include" -I"$LWE/src/glad/include" -I"$LWE/src/External/stb" \
    "$HERE/host.cpp" \
    "$BUILD/lwe/linux-wallpaperengine-glad/liblinux-wallpaperengine-glad.a" \
    -L"$BUILD/lwe/lib" -llinux-wallpaperengine-core \
    -Wl,-rpath,"$BUILD/lwe/lib" \
    $(pkg-config --libs egl) -ldl -lpthread \
    -o "$BUILD/lwe-core-host"

echo "built: $BUILD/lwe-core-host"
