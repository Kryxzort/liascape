#!/usr/bin/env bash
# LWE (linux-wallpaperengine) `next-v2` core for liascape-player's scene worker — fetch, build, check.
#
# Source of truth: third_party/lwe/PIN (JSON). The core comes from the owner's fork
# (Kryxzort/linux-wallpaperengine, branch `livepaper/next-v2`): upstream's pinned `next-v2` commit
# (`base`) plus our patches as commits on top (`rev`). `patches/lwe/NNNN-*.patch` is the same set of
# commits as `git format-patch` output — what CREDITS.md and the rebase recipe read; `verify` proves
# the two agree. UPSTREAM.md § linux-wallpaperengine has the resync recipe.
#
#   bash scripts/lwe.sh fetch            # clone PIN.repo at PIN.rev (+ submodules, each verified) into the cache
#   bash scripts/lwe.sh prepare          # copy it, without VCS dirs, to build/lwe-src-<rev>
#   bash scripts/lwe.sh build            # CMake: the core target only → $LIASCAPE_LWE_CORE_DIR (default build/lwe-core)
#   bash scripts/lwe.sh check            # the built core exports only wp_* and ships its headers
#   bash scripts/lwe.sh test             # compile + run patches/lwe/tests/host_api_test.c against the built core
#   bash scripts/lwe.sh verify           # base + patches/lwe/*.patch == PIN.rev's tree
#   bash scripts/lwe.sh patches          # regenerate patches/lwe/*.patch from base..rev (git format-patch)
#   bash scripts/lwe.sh rebase <rev>     # re-apply every patch onto upstream <rev> in a scratch copy; ok/conflict each
#   bash scripts/lwe.sh deps             # exit 1 + per-distro package lines when the build deps are missing
#   LWE_DEV_SRC=<fork checkout> bash scripts/lwe.sh build test   # patch work: build a working tree in place
#
# Commands chain: `bash scripts/lwe.sh fetch prepare build check`.
# Knobs (env): LWE_SRC_CACHE (default ~/.cache/liascape/src), LWE_REPO (clone this instead of
# PIN.repo — e.g. a local clone of the fork while developing a patch), LWE_JOBS (default 8),
# LIASCAPE_LWE_CORE_DIR (install dir of `build`; default <repo>/build/lwe-core).
#
# `--nix` first: run inside this repo's flake devShell (cmake + every dep), minus the stray
# LD_LIBRARY_PATH some shells carry (it breaks native links — .claude/rules/player-core.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "${1:-}" = "--nix" ]; then
    shift
    if [ -z "${LWE_IN_NIX_DEVELOP:-}" ]; then
        exec env -u LD_LIBRARY_PATH LWE_IN_NIX_DEVELOP=1 nix develop "$ROOT" -c bash "$0" "$@"
    fi
fi
PIN="$ROOT/third_party/lwe/PIN"
PATCH_DIR="$ROOT/patches/lwe"

pin() { # pin <key> — a top-level string value of the PIN file (one key per line)
    sed -n "s/^  \"$1\": *\"\([^\"]*\)\".*/\1/p" "$PIN"
}
pin_submodules() { # "<path> <commit>" lines from the PIN's "submodules" object
    sed -n '/"submodules"/,/}/s/^ *"\([^"]*\)": *"\([0-9a-f]\{40\}\)".*/\1 \2/p' "$PIN"
}

REV="$(pin rev)"
BASE="$(pin base)"
VERSION="$(pin version)"
REPO="${LWE_REPO:-$(pin repo)}"
BRANCH="$(pin branch)"
UPSTREAM="$(pin upstream)"
CACHE="${LWE_SRC_CACHE:-$HOME/.cache/liascape/src}"
SRC="$CACHE/lwe-$REV"
PREP="$ROOT/build/lwe-src-$REV"
BUILD="$ROOT/build/lwe-build-$REV"
CORE="${LIASCAPE_LWE_CORE_DIR:-$ROOT/build/lwe-core}"
JOBS="${LWE_JOBS:-8}"
# patch work: LWE_DEV_SRC=<a checkout of the fork branch> builds that tree in place (incremental,
# build/lwe-build-dev) instead of the prepared copy of PIN.rev
if [ -n "${LWE_DEV_SRC:-}" ]; then
    PREP="$(cd "$LWE_DEV_SRC" && pwd -P)"
    BUILD="$ROOT/build/lwe-build-dev"
fi

die() { echo "lwe.sh: $*" >&2; exit 1; }
[ -n "$REV" ] && [ -n "$BASE" ] && [ -n "$VERSION" ] || die "cannot read rev/base/version from $PIN"

cmd_deps() {
    local missing=""
    command -v cmake >/dev/null 2>&1 || missing="$missing cmake"
    command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || missing="$missing c++"
    command -v git >/dev/null 2>&1 || missing="$missing git"
    if command -v pkg-config >/dev/null 2>&1; then
        for p in sdl2 freetype2 liblz4 zlib libavformat libavcodec libswresample libswscale libavutil mpv gl; do
            pkg-config --exists "$p" 2>/dev/null || missing="$missing ${p}(dev)"
        done
        # glm is header-only; it ships a CMake config (and on some distros a .pc)
        if ! pkg-config --exists glm 2>/dev/null; then
            local found="" d
            local IFS_=$IFS; IFS=:
            for d in /usr/include /usr/local/include ${CPATH:-} ; do [ -f "$d/glm/glm.hpp" ] && found=1; done
            for d in ${CMAKE_PREFIX_PATH:-} ; do [ -f "$d/include/glm/glm.hpp" ] && found=1; done
            IFS=$IFS_
            [ -n "$found" ] || missing="$missing glm(dev)"
        fi
    else
        missing="$missing pkg-config"
    fi
    if [ -n "$missing" ]; then
        cat >&2 <<MSG
ERROR: missing build dependencies for Wallpaper Engine scenes (LWE core):$missing
  Install them and re-run, or pass --no-scenes to build without scene support:
    Arch:   sudo pacman -S cmake git sdl2 freetype2 glm lz4 zlib ffmpeg mpv libglvnd
    Debian: sudo apt install cmake git libsdl2-dev libfreetype-dev libglm-dev liblz4-dev zlib1g-dev libavformat-dev libavcodec-dev libswresample-dev libswscale-dev libavutil-dev libmpv-dev libgl-dev
    Fedora: sudo dnf install cmake git SDL2-devel freetype-devel glm-devel lz4-devel zlib-devel ffmpeg-free-devel mpv-libs-devel libglvnd-devel
    NixOS:  use the flake instead — 'nix run github:Kryxzort/liascape' (all deps handled)
MSG
        return 1
    fi
}

cmd_fetch() {
    mkdir -p "$CACHE"
    if [ ! -d "$SRC/.git" ]; then
        local tmp="$SRC.part"
        [ -e "$tmp" ] && mv "$tmp" "$tmp.stale-$$"
        echo "==> lwe: cloning $REPO ($BRANCH) → $SRC"
        git clone -q --no-checkout --branch "$BRANCH" "$REPO" "$tmp" \
            || git clone -q --no-checkout "$REPO" "$tmp"
        mv "$tmp" "$SRC"
    fi
    if ! git -C "$SRC" cat-file -e "$REV^{commit}" 2>/dev/null; then
        git -C "$SRC" fetch -q origin "$REV" || git -C "$SRC" fetch -q origin "$BRANCH"
    fi
    git -C "$SRC" cat-file -e "$REV^{commit}" 2>/dev/null || die "$REPO has no commit $REV"
    git -C "$SRC" -c advice.detachedHead=false checkout -q --detach "$REV"
    git -C "$SRC" merge-base --is-ancestor "$BASE" "$REV" || die "base $BASE is not an ancestor of $REV"
    git -C "$SRC" submodule update -q --init --recursive
    # every submodule exactly at the PIN's commit (the gitlink of $REV, and checked out)
    local bad=0 path want link have
    while read -r path want; do
        link="$(git -C "$SRC" rev-parse "$REV:$path" 2>/dev/null || true)"
        have="$(git -C "$SRC/$path" rev-parse HEAD 2>/dev/null || true)"
        if [ "$link" != "$want" ] || [ "$have" != "$want" ]; then
            echo "lwe.sh: submodule $path: PIN $want, gitlink ${link:-?}, checked out ${have:-?}" >&2
            bad=1
        fi
    done < <(pin_submodules)
    [ "$bad" = 0 ] || die "submodules do not match $PIN"
    echo "==> lwe: $SRC at $REV ($(pin_submodules | wc -l) submodules verified)"
}

cmd_prepare() {
    [ -d "$SRC/.git" ] || die "no source at $SRC — run fetch first"
    if [ -f "$PREP/.liascape-prepared" ] && [ "$(cat "$PREP/.liascape-prepared")" = "$REV" ]; then
        echo "==> lwe: $PREP already prepared"
        return
    fi
    local tmp="$PREP.part-$$"
    mkdir -p "$tmp"
    # a copy without .git/ (and without submodules' .git files) — what a release tarball or the
    # Nix fetch looks like; the CMake version then comes from WPBUILD_VERSION_OVERRIDE
    tar -C "$SRC" --exclude-vcs --exclude=./src/External/quickjs/test262 -cf - . | tar -C "$tmp" -xf -
    echo "$REV" > "$tmp/.liascape-prepared"
    [ -e "$PREP" ] && mv "$PREP" "$PREP.old-$$"
    mv "$tmp" "$PREP"
    echo "==> lwe: prepared $PREP"
}

cmd_build() {
    [ -f "$PREP/.liascape-prepared" ] || [ -n "${LWE_DEV_SRC:-}" ] || die "no prepared source at $PREP — run prepare first"
    cmd_deps
    local t0=$SECONDS
    if [ ! -f "$BUILD/CMakeCache.txt" ]; then
        cmake -S "$PREP" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
            -DWPBUILD_CORE=ON -DWPBUILD_WEBHELPER=OFF -DWPBUILD_FRONTEND=OFF \
            -DWPBUILD_DEVVIEWER=OFF -DWPBUILD_TESTS=OFF \
            -DWPBUILD_VERSION_OVERRIDE="$VERSION" >/dev/null
    fi
    # the core *target* only: the dev-viewer/webhelper OBJECT libraries are declared before their
    # option gate and `all` would compile them (they need GLFW/CEF headers)
    cmake --build "$BUILD" --target linux-wallpaperengine-core -j"$JOBS"
    mkdir -p "$CORE/lib" "$CORE/include/linux-wallpaperengine"
    find "$CORE/lib" -maxdepth 1 -name 'liblinux-wallpaperengine-core.so*' -delete
    cp -P "$BUILD"/lib/liblinux-wallpaperengine-core.so* "$CORE/lib/"
    cp "$PREP"/include/linux-wallpaperengine/*.h "$CORE/include/linux-wallpaperengine/"
    cp "$BUILD/generated/version.h" "$CORE/include/linux-wallpaperengine/"
    if [ -n "${LWE_DEV_SRC:-}" ]; then echo "dev:$PREP" > "$CORE/REV"; else echo "$REV" > "$CORE/REV"; fi
    echo "==> lwe: core built in $((SECONDS - t0)) s → $CORE"
    echo "LIASCAPE_LWE_CORE_DIR=$CORE"
}

cmd_check() {
    local so="$CORE/lib/liblinux-wallpaperengine-core.so"
    [ -e "$so" ] || die "no core at $so — run build first"
    local syms bad n
    syms="$(nm -D --defined-only "$so" | awk '$2 ~ /^[TDBVWR]$/ {print $3}')"
    bad="$(printf '%s\n' "$syms" | grep -v '^wp_' || true)"
    [ -z "$bad" ] || die "core exports non-wp_ symbols: $(echo $bad | head -c 400)"
    n="$(printf '%s\n' "$syms" | grep -c '^wp_')"
    for h in configuration content context export playlists project render version; do
        [ -f "$CORE/include/linux-wallpaperengine/$h.h" ] || die "missing header $h.h"
    done
    echo "==> lwe: check ok — $n wp_* exports, headers present ($CORE)"
}

cmd_test() {
    local so="$CORE/lib/liblinux-wallpaperengine-core.so"
    [ -e "$so" ] || die "no core at $so — run build first"
    local out="$ROOT/build/lwe-host-api-test"
    mkdir -p "$ROOT/build"
    c++ -std=c++20 -O1 -g -Wall "$PATCH_DIR/tests/host_api_test.cpp" \
        -I"$CORE/include" -L"$CORE/lib" -llinux-wallpaperengine-core -Wl,-rpath,"$CORE/lib" \
        $(pkg-config --cflags --libs sdl2 egl) -o "$out"
    local empty rc=0
    empty="$(mktemp -d)"
    # LIASCAPE_WE_ASSETS_DIR (WE's assets/, proprietary) enables the audio-mix test; SKIPped without
    SDL_AUDIODRIVER=dummy "$out" "$PATCH_DIR/tests/fixtures" "$empty" ${LIASCAPE_WE_ASSETS_DIR:+"$LIASCAPE_WE_ASSETS_DIR"} || rc=$?
    rmdir "$empty"
    return "$rc"
}

# a throwaway worktree of the cache clone at <commit>; echoes its path
scratch_tree() {
    local at="$1" dir
    dir="$(mktemp -d "${TMPDIR:-/tmp}/lwe-scratch.XXXXXX")"
    rmdir "$dir"
    git -C "$SRC" worktree add -q --detach "$dir" "$at" >/dev/null
    echo "$dir"
}
drop_tree() { git -C "$SRC" worktree remove --force "$1" >/dev/null 2>&1 || true; }

cmd_verify() {
    [ -d "$SRC/.git" ] || die "no source at $SRC — run fetch first"
    local dir p ok=1
    dir="$(scratch_tree "$BASE")"
    for p in "$PATCH_DIR"/[0-9][0-9][0-9][0-9]-*.patch; do
        if git -C "$dir" apply --check "$p" 2>/dev/null && git -C "$dir" apply --index "$p"; then
            echo "  ok        $(basename "$p")"
        else
            echo "  CONFLICT  $(basename "$p")"; ok=0
        fi
    done
    if [ "$ok" = 1 ] && git -C "$dir" diff --cached --quiet "$REV" --ignore-submodules=all; then
        echo "==> lwe: base $BASE + patches/lwe == $REV"
    else
        [ "$ok" = 1 ] && git -C "$dir" diff --cached --stat "$REV" --ignore-submodules=all >&2
        drop_tree "$dir"
        die "patches/lwe does not reproduce $REV — run \`bash scripts/lwe.sh patches\`"
    fi
    drop_tree "$dir"
}

cmd_patches() {
    [ -d "$SRC/.git" ] || die "no source at $SRC — run fetch first"
    mkdir -p "$PATCH_DIR"
    find "$PATCH_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.patch' -delete
    git -C "$SRC" format-patch -q --no-signature -o "$PATCH_DIR" "$BASE..$REV"
    ls "$PATCH_DIR"/*.patch | sed "s|^$ROOT/||"
}

cmd_rebase() {
    local onto="${1:-}"
    [ -n "$onto" ] || die "usage: lwe.sh rebase <upstream-rev>"
    [ -d "$SRC/.git" ] || die "no source at $SRC — run fetch first"
    if ! git -C "$SRC" cat-file -e "$onto^{commit}" 2>/dev/null; then
        git -C "$SRC" fetch -q "$UPSTREAM" "$onto" || die "cannot fetch $onto from $UPSTREAM"
    fi
    local dir p fails=0
    dir="$(scratch_tree "$onto")"
    echo "==> lwe: re-applying patches/lwe onto $onto (scratch copy; nothing else changes)"
    for p in "$PATCH_DIR"/[0-9][0-9][0-9][0-9]-*.patch; do
        if git -C "$dir" apply --3way --check "$p" >/dev/null 2>&1 && git -C "$dir" apply --3way --index "$p" >/dev/null 2>&1; then
            echo "  ok        $(basename "$p")"
        else
            echo "  CONFLICT  $(basename "$p")"; fails=$((fails + 1))
        fi
    done
    drop_tree "$dir"
    [ "$fails" = 0 ] || die "$fails patch(es) conflict on $onto — rebase the fork branch by hand (UPSTREAM.md)"
    echo "==> lwe: every patch applies on $onto"
}

[ $# -gt 0 ] || { sed -n '2,25p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
    c="$1"; shift
    case "$c" in
        fetch) cmd_fetch ;;
        prepare) cmd_prepare ;;
        build) cmd_build ;;
        check) cmd_check ;;
        test) cmd_test ;;
        verify) cmd_verify ;;
        patches) cmd_patches ;;
        deps) cmd_deps ;;
        rebase) cmd_rebase "${1:-}"; shift || true ;;
        *) die "unknown command '$c' (fetch | prepare | build | check | test | verify | patches | rebase <rev> | deps)" ;;
    esac
done
